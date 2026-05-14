/**
 * Gateway LLM adapter: implements LLMClient via direct API calls.
 * Used by Lore's background workers (distillation, curation, query expansion)
 * running inside the gateway process.
 *
 * Supports both Anthropic Messages API and OpenAI Chat Completions API.
 * The provider is selected at call time based on `model.providerID`:
 *   - "anthropic" → POST /v1/messages (Anthropic wire format)
 *   - "openai"    → POST /v1/chat/completions (OpenAI wire format)
 *
 * Retry logic, Sentry instrumentation, worker call tracking, and error
 * handling are shared across both providers.
 */

import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";
import * as Sentry from "@sentry/bun";
import type { AuthCredential } from "./auth";
import { authHeaders } from "./auth";
import { buildBillingBlock, signBody } from "./cch";
import {
  setGenAiUsageAttributes,
  emitCostMetric,
  type AnthropicUsage,
} from "./sentry";
import { recordWorkerCost } from "./cost-tracker";

// ---------------------------------------------------------------------------
// Worker call tracking
// ---------------------------------------------------------------------------

/** Tracks worker session IDs so temporal capture can skip them. */
export const activeWorkerCalls = new Set<string>();

// ---------------------------------------------------------------------------
// Retry helpers (exported for testing)
// ---------------------------------------------------------------------------

/** HTTP status codes that are transient and worth retrying. */
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);

/** Max retries by error category for **background** (non-urgent) calls. */
const MAX_RETRIES_RATE_LIMIT = 5; // 429s: ~2-3 min with server-guided backoff
const MAX_RETRIES_SERVER = 3; // 5xx: fast retries

/**
 * Max retries for **urgent** calls — synchronous worker work that the
 * client is awaiting (compaction, query expansion, overflow distillation).
 * Tight budget so a 429 storm cannot turn the SSE response into a multi-
 * minute hang. The user-visible "Lore made OpenCode hang" symptom that
 * motivated splitting these budgets came from urgent calls inheriting the
 * background-worker retry timing. 2 retries × ~3s max = ~6s ceiling.
 */
const MAX_RETRIES_URGENT = 2;

/** Cap Retry-After server hints separately for urgent vs background calls.
 *  Urgent paths cannot afford a 60-120s pause even if the server asks. */
const RETRY_AFTER_CAP_URGENT_MS = 8_000;
const RETRY_AFTER_CAP_BACKGROUND_MS = 120_000;

export function maxRetriesFor(
  status: number | null,
  urgent: boolean = false,
): number {
  if (urgent) return MAX_RETRIES_URGENT;
  if (status === 429) return MAX_RETRIES_RATE_LIMIT;
  return MAX_RETRIES_SERVER;
}

/** Parse the Retry-After header into milliseconds, or null if absent/invalid. */
export function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Compute delay for a retry attempt.
 * - Always honor Retry-After when present, capped per-mode (urgent: 8s, bg: 120s)
 * - 429 without Retry-After:
 *    - urgent: 1s, 2s, 4s (capped 4s)
 *    - background: 30s, 45s, 60s, 60s, 60s
 * - 5xx: aggressive 1s, 2s, 4s (capped 8s) — same for urgent and background
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
  status: number | null,
  urgent: boolean = false,
): number {
  // Always honor Retry-After from server, but cap tighter for urgent calls
  if (retryAfterMs != null) {
    const cap = urgent ? RETRY_AFTER_CAP_URGENT_MS : RETRY_AFTER_CAP_BACKGROUND_MS;
    return Math.min(retryAfterMs, cap);
  }

  // Urgent path: aggressive exponential regardless of status
  if (urgent) return Math.min(1000 * 2 ** attempt, 4000);

  // 429 without Retry-After: conservative delays
  if (status === 429) return Math.min(15_000 + (attempt + 1) * 15_000, 60_000);

  // 5xx: aggressive exponential backoff
  return Math.min(1000 * 2 ** attempt, 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// OpenAI response types & usage normalization (exported for testing)
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions response shape (subset we need). */
type OpenAIChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/**
 * Normalize OpenAI usage to the AnthropicUsage shape for unified cost tracking.
 *
 * Maps:
 *   prompt_tokens                          → input_tokens
 *   completion_tokens                      → output_tokens
 *   prompt_tokens_details.cached_tokens    → cache_read_input_tokens
 *   (not reported by OpenAI)               → cache_creation_input_tokens = 0
 */
export function normalizeOpenAIUsage(
  usage: OpenAIChatResponse["usage"],
): AnthropicUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0, // OpenAI doesn't report this separately
  };
}

// ---------------------------------------------------------------------------
// Provider-specific request builders
// ---------------------------------------------------------------------------

/** Upstream URL + provider name for a resolved provider. */
type ProviderTarget = {
  url: string;
  providerName: string;
};

/** Resolve upstream target based on model provider. */
function resolveTarget(
  upstreams: { anthropic: string; openai: string },
  providerID: string,
): ProviderTarget {
  if (providerID === "openai") {
    return {
      url: upstreams.openai.replace(/\/$/, ""),
      providerName: "openai",
    };
  }
  return {
    url: upstreams.anthropic.replace(/\/$/, ""),
    providerName: "anthropic",
  };
}

/**
 * Build Anthropic Messages API request.
 * Returns the full URL, headers, and serialized body.
 */
function buildAnthropicWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  sessionID?: string,
): { url: string; headers: Record<string, string>; body: string } {
  // For bearer tokens (Claude Code OAuth), inject the billing header
  // as the first system block with a cch=00000 placeholder that gets
  // signed after JSON serialization.
  const billingBlock =
    cred.scheme === "bearer"
      ? buildBillingBlock(sessionID, user)
      : null;

  // System prompt caching for workers: send as block array with 1h TTL.
  // Worker calls come in bursts (distillation, curation) separated by
  // minutes of user thinking — 5m TTL expires between bursts, but 1h
  // survives. The system prompt (DISTILLATION_SYSTEM, etc.) is static
  // across all calls → near-100% cache hit rate after the first write.
  const systemBlocks = system
    ? [
        {
          type: "text" as const,
          text: system,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ]
    : [];

  const systemPayload =
    billingBlock || systemBlocks.length > 0
      ? [
          ...(billingBlock ? [billingBlock] : []),
          ...systemBlocks,
        ]
      : undefined;

  let body = JSON.stringify({
    model: model.modelID,
    max_tokens: maxTokens,
    system: systemPayload,
    messages: [{ role: "user", content: user }],
  });

  // Sign the body: compute xxHash64 and replace cch=00000 with real hash
  if (billingBlock) {
    body = signBody(body);
  }

  return {
    url: `${target.url}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...authHeaders(cred),
    },
    body,
  };
}

/**
 * Build OpenAI Chat Completions API request.
 * Returns the full URL, headers, and serialized body.
 */
function buildOpenAIWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
): { url: string; headers: Record<string, string>; body: string } {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  return {
    url: `${target.url}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cred),
    },
    body: JSON.stringify({
      model: model.modelID,
      max_completion_tokens: maxTokens,
      messages,
    }),
  };
}

/** Extract text response from an Anthropic Messages API response. */
function parseAnthropicResponse(data: {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: AnthropicUsage;
}): { text: string | null; usage: AnthropicUsage | null; model: string | null } {
  const textBlock = data.content?.find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  return {
    text: textBlock?.text ?? null,
    usage: data.usage ?? null,
    model: data.model ?? null,
  };
}

/** Extract text response from an OpenAI Chat Completions response. */
function parseOpenAIResponse(data: OpenAIChatResponse): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  return {
    text: data.choices?.[0]?.message?.content ?? null,
    usage: data.usage ? normalizeOpenAIUsage(data.usage) : null,
    model: data.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// LLMClient factory
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient that sends single-turn prompts to the appropriate provider.
 *
 * Routes to Anthropic Messages API or OpenAI Chat Completions API based on
 * `model.providerID`. Retry logic, Sentry instrumentation, and error handling
 * are shared across both providers.
 *
 * @param upstreams     Base URLs for each provider
 * @param getAuth       Callback to resolve auth credentials (per-session → global fallback)
 * @param defaultModel  Default model to use when no override is specified
 */
export function createGatewayLLMClient(
  upstreams: { anthropic: string; openai: string },
  getAuth: (sessionID?: string) => AuthCredential | null,
  defaultModel: { providerID: string; modelID: string },
): LLMClient {
  return {
    async prompt(system, user, opts) {
      const cred = getAuth(opts?.sessionID);
      if (!cred) {
        log.warn("no auth credentials available for worker call");
        return null;
      }

      const model = opts?.model ?? defaultModel;
      const isOpenAI = model.providerID === "openai";
      const target = resolveTarget(upstreams, model.providerID);
      const maxTokens = opts?.maxTokens ?? 8192;

      // Build provider-specific request
      const req = isOpenAI
        ? buildOpenAIWorkerRequest(target, cred, model, system, user, maxTokens)
        : buildAnthropicWorkerRequest(
            target, cred, model, system, user, maxTokens, opts?.sessionID,
          );

      // Track this call so temporal capture can skip it
      const callID = `gw-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeWorkerCalls.add(callID);

      const urgent = opts?.urgent === true;

      try {
        // Wrap the entire retry loop in a gen_ai.chat span so it captures
        // real wall-clock duration including retries and backoff delays.
        return await Sentry.startSpan(
          {
            op: "gen_ai.chat",
            name: `chat ${model.modelID}`,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": model.modelID,
              "gen_ai.provider.name": target.providerName,
              "lore.worker_id": opts?.workerID ?? "unknown",
              "lore.call_type": "direct",
              "lore.urgent": urgent,
            },
          },
          async (span) => {
            // Track retry metrics for span enrichment
            let retryCount = 0;
            let totalDelayMs = 0;
            let lastRetryAfterMs: number | null = null;
            let finalStatus = 0;

            // Retry loop for transient errors (429, 5xx)
            for (let attempt = 0; ; attempt++) {
              let response: Response;
              try {
                response = await fetch(req.url, {
                  method: "POST",
                  headers: req.headers,
                  // opts.thinking is intentionally not forwarded — this bare API
                  // call never includes the `thinking` parameter so models
                  // won't produce thinking tokens regardless.
                  body: req.body,
                });
              } catch (e) {
                // Network/fetch error — retry if attempts remain
                const maxRetries = maxRetriesFor(null, urgent);
                if (attempt < maxRetries) {
                  const delay = backoffMs(attempt, null, null, urgent);
                  retryCount++;
                  totalDelayMs += delay;
                  log.warn(
                    `worker request network error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
                  );
                  await sleep(delay);
                  continue;
                }
                // Enrich span before rethrowing
                if (retryCount > 0) {
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                }
                throw e; // exhausted retries — rethrow to outer catch
              }

              finalStatus = response.status;

              if (response.ok) {
                const rawData = await response.json();

                // Parse response based on provider
                const parsed = isOpenAI
                  ? parseOpenAIResponse(rawData as OpenAIChatResponse)
                  : parseAnthropicResponse(rawData);

                // Set usage attributes on the span
                if (parsed.usage) {
                  setGenAiUsageAttributes(span, parsed.usage, parsed.model ?? undefined);
                  emitCostMetric(model.modelID, parsed.usage, "direct");
                  recordWorkerCost(opts?.sessionID, model.modelID, parsed.usage, "direct", opts?.workerID);
                }

                // Enrich span with retry metadata on eventual success
                if (retryCount > 0) {
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                  if (lastRetryAfterMs != null) {
                    span.setAttribute(
                      "lore.retry.last_retry_after_ms",
                      lastRetryAfterMs,
                    );
                  }
                  span.setAttribute("lore.retry.final_status", finalStatus);
                }

                return parsed.text;
              }

              // Non-transient error — fail immediately, no retry
              if (!TRANSIENT_CODES.has(response.status)) {
                const text = await response.text().catch(() => "(no body)");
                log.error(
                  `worker upstream request failed: ${response.status} ${response.statusText} — ${text}`,
                );
                span.setStatus({ code: 2, message: `HTTP ${response.status}` });
                return null;
              }

              // Transient error — retry if attempts remain
              const maxRetries = maxRetriesFor(response.status, urgent);
              if (attempt < maxRetries) {
                const retryAfter = parseRetryAfter(response);
                const delay = backoffMs(attempt, retryAfter, response.status, urgent);
                retryCount++;
                totalDelayMs += delay;
                if (retryAfter != null) lastRetryAfterMs = retryAfter;
                log.warn(
                  `worker upstream ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), ` +
                    `retrying in ${delay}ms` +
                    (retryAfter != null
                      ? ` (retry-after: ${Math.round(retryAfter / 1000)}s)`
                      : ""),
                );
                await sleep(delay);
                continue;
              }

              // Exhausted retries — log, capture Sentry error, enrich span
              const text = await response.text().catch(() => "(no body)");
              log.error(
                `worker upstream request failed after ${maxRetries + 1} attempts: ${response.status} ${response.statusText} — ${text}`,
              );

              // Capture as Sentry error for alerting
              Sentry.captureException(
                new Error(
                  `Worker upstream exhausted ${maxRetries + 1} retries: ${response.status} ${response.statusText}`,
                ),
                {
                  fingerprint: [
                    "LOREAI-GATEWAY",
                    "worker-retry-exhausted",
                    String(response.status),
                  ],
                  extra: {
                    status: response.status,
                    attempts: maxRetries + 1,
                    totalDelayMs,
                    lastRetryAfterMs,
                    model: model.modelID,
                    workerID: opts?.workerID ?? "unknown",
                  },
                },
              );

              // Enrich span with retry metadata
              span.setAttribute("lore.retry.count", retryCount);
              span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
              if (lastRetryAfterMs != null) {
                span.setAttribute(
                  "lore.retry.last_retry_after_ms",
                  lastRetryAfterMs,
                );
              }
              span.setAttribute("lore.retry.final_status", finalStatus);
              span.setStatus({ code: 2, message: `HTTP exhausted retries` });
              return null;
            }
          },
        );
      } catch (e) {
        log.error("worker prompt failed:", e);
        return null;
      } finally {
        activeWorkerCalls.delete(callID);
      }
    },
  };
}
