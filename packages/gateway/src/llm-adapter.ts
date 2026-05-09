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
// Retry helpers
// ---------------------------------------------------------------------------

/** HTTP status codes that are transient and worth retrying. */
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;

/** Parse the Retry-After header into milliseconds, or null if absent/invalid. */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Compute delay for a retry attempt, respecting Retry-After on the first try. */
function backoffMs(attempt: number, retryAfterMs: number | null): number {
  if (attempt === 0 && retryAfterMs != null)
    return Math.min(retryAfterMs, 30_000); // cap Retry-After at 30s
  return Math.min(1000 * 2 ** attempt, 8000); // 1s, 2s, 4s, capped at 8s
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

      try {
        // System prompt caching for workers: send as block array with 1h TTL.
        // Worker calls come in bursts (distillation, curation) separated by
        // minutes of user thinking — 5m TTL expires between bursts, but 1h
        // survives. The system prompt (DISTILLATION_SYSTEM, etc.) is static
        // across all calls → near-100% cache hit rate after the first write.
        // Cost: 1.25× base for the initial write, 0.1× for subsequent reads.
        const systemPayload = system
          ? [
              {
                type: "text",
                text: system,
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ]
          : undefined;

        const body = JSON.stringify({
          model: model.modelID,
          max_tokens: 8192,
          system: systemPayload ?? system,
          messages: [{ role: "user", content: user }],
        });

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
            },
          },
          async (span) => {
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
                if (attempt < MAX_RETRIES) {
                  const delay = backoffMs(attempt, null);
                  log.warn(
                    `worker request network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`,
                  );
                  await sleep(delay);
                  continue;
                }
                throw e; // exhausted retries — rethrow to outer catch
              }

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
              if (attempt < MAX_RETRIES) {
                const retryAfter = parseRetryAfter(response);
                const delay = backoffMs(attempt, retryAfter);
                log.warn(
                  `worker upstream ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`,
                );
                await sleep(delay);
                continue;
              }

              // Exhausted retries
              const text = await response.text().catch(() => "(no body)");
              log.error(
                `worker upstream request failed after ${MAX_RETRIES + 1} attempts: ${response.status} ${response.statusText} — ${text}`,
              );
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
