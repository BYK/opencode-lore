/**
 * Gateway LLM adapter: implements LLMClient via direct Anthropic API calls.
 * Used by Lore's background workers (distillation, curation, query expansion)
 * running inside the gateway process.
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
// LLMClient factory
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient that sends single-turn prompts directly to Anthropic.
 *
 * @param upstreamUrl     Base URL of the upstream Anthropic endpoint
 * @param getAuth         Callback to resolve auth credentials (per-session → global fallback)
 * @param defaultModel    Default model to use when no override is specified
 */
export function createGatewayLLMClient(
  upstreamUrl: string,
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
      const url = `${upstreamUrl.replace(/\/$/, "")}/v1/messages`;

      // Track this call so temporal capture can skip it
      const callID = `gw-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeWorkerCalls.add(callID);

      const urgent = opts?.urgent === true;

      try {
        // --- Build system payload ---
        // For bearer tokens (Claude Code OAuth), inject the billing header
        // as the first system block with a cch=00000 placeholder that gets
        // signed after JSON serialization. The prefix is looked up by the
        // *originating* sessionID so workers for session A never sign with
        // session B's cc_version.
        const billingBlock =
          cred.scheme === "bearer" ? buildBillingBlock(opts?.sessionID) : null;

        // System prompt caching for workers: send as block array with 1h TTL.
        // Worker calls come in bursts (distillation, curation) separated by
        // minutes of user thinking — 5m TTL expires between bursts, but 1h
        // survives. The system prompt (DISTILLATION_SYSTEM, etc.) is static
        // across all calls → near-100% cache hit rate after the first write.
        // Cost: 1.25× base for the initial write, 0.1× for subsequent reads.
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

        // Build body with cch=00000 placeholder, then sign if needed
        let body = JSON.stringify({
          model: model.modelID,
          max_tokens: 8192,
          system: systemPayload,
          messages: [{ role: "user", content: user }],
        });

        // Sign the body: compute xxHash64 and replace cch=00000 with real hash
        if (billingBlock) {
          body = signBody(body);
        }

        const reqHeaders = {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders(cred),
        };

        // Wrap the entire retry loop in a gen_ai.chat span so it captures
        // real wall-clock duration including retries and backoff delays.
        return await Sentry.startSpan(
          {
            op: "gen_ai.chat",
            name: `chat ${model.modelID}`,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": model.modelID,
              "gen_ai.provider.name": "anthropic",
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
                response = await fetch(url, {
                  method: "POST",
                  headers: reqHeaders,
                  // opts.thinking is intentionally not forwarded — this bare API
                  // call never includes the `thinking` parameter so Anthropic
                  // models won't produce thinking tokens regardless.
                  body,
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
                const data = (await response.json()) as {
                  content?: Array<{ type: string; text?: string }>;
                  model?: string;
                  usage?: AnthropicUsage;
                };

                // Set usage attributes on the span
                if (data.usage) {
                  setGenAiUsageAttributes(span, data.usage, data.model);
                  emitCostMetric(model.modelID, data.usage, "direct");
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

                const textBlock = data.content?.find(
                  (b) => b.type === "text" && typeof b.text === "string",
                );

                return textBlock?.text ?? null;
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
