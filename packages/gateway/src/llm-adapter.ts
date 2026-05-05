/**
 * Gateway LLMClient adapter.
 *
 * Implements the host-agnostic `LLMClient` interface from @loreai/core for
 * the gateway's background workers (distillation, curation, query expansion).
 * These calls go directly to the upstream Anthropic API via `fetch()`,
 * bypassing the proxy pipeline entirely.
 *
 * API key management: the gateway doesn't own credentials — it captures the
 * API key from real client requests flowing through the proxy and reuses it
 * for background work. See `setLastSeenApiKey()` / `getLastSeenApiKey()`.
 */
import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// API key capture — proxy stores keys from real client requests
// ---------------------------------------------------------------------------

/** Store the last-seen API key from proxy requests for worker reuse. */
let lastSeenApiKey: string | null = null;
export function setLastSeenApiKey(key: string): void {
  lastSeenApiKey = key;
}
export function getLastSeenApiKey(): string | null {
  return lastSeenApiKey;
}

// ---------------------------------------------------------------------------
// Worker call tracking
// ---------------------------------------------------------------------------

/** Tracks worker session IDs so temporal capture can skip them. */
export const activeWorkerCalls = new Set<string>();

// ---------------------------------------------------------------------------
// LLMClient factory
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient backed by direct `fetch()` calls to the upstream
 * Anthropic API. Used for background workers that must not flow through
 * the proxy pipeline (would cause infinite loops).
 *
 * @param upstreamURL   Base URL of the upstream provider (e.g. `https://api.anthropic.com`)
 * @param getApiKey     Returns the current API key, or null if unavailable
 * @param defaultModel  Fallback model when `opts.model` is not provided
 */
export function createGatewayLLMClient(
  upstreamURL: string,
  getApiKey: () => string | null,
  defaultModel: { providerID: string; modelID: string },
): LLMClient {
  return {
    async prompt(system, user, opts) {
      try {
        // Determine model
        const model = opts?.model ?? defaultModel;

        // Get API key — no key means we can't make the call
        const apiKey = getApiKey();
        if (!apiKey) {
          log.warn("no API key available for worker call");
          return null;
        }

        // Track this call so temporal capture can skip it
        const callID = `gw-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeWorkerCalls.add(callID);

        try {
          const response = await fetch(`${upstreamURL}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            // opts.thinking is intentionally not forwarded — this bare API
            // call never includes the `thinking` parameter so Anthropic
            // models won't produce thinking tokens regardless.
            body: JSON.stringify({
              model: model.modelID,
              system,
              messages: [{ role: "user", content: user }],
              max_tokens: 8192,
            }),
          });

          if (!response.ok) {
            log.error(
              `worker upstream request failed: ${response.status} ${response.statusText}`,
            );
            return null;
          }

          const result = (await response.json()) as {
            content?: Array<{ type: string; text?: string }>;
          };

          return result.content?.[0]?.text ?? null;
        } finally {
          activeWorkerCalls.delete(callID);
        }
      } catch (e) {
        log.error("worker prompt failed:", e);
        return null;
      }
    },
  };
}
