/**
 * Gateway LLM adapter: implements LLMClient via direct Anthropic API calls.
 * Used by Lore's background workers (distillation, curation, query expansion)
 * running inside the gateway process.
 */

import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// API key tracking
// ---------------------------------------------------------------------------

/**
 * The most recently seen API key from incoming client requests.
 * Workers use this to authenticate upstream — they piggyback on the key
 * the main session is using rather than requiring a separate key.
 */
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
 * Create an LLMClient that sends single-turn prompts directly to Anthropic.
 *
 * @param upstreamUrl     Base URL of the upstream Anthropic endpoint
 * @param getApiKey       Callback to retrieve the current API key
 * @param defaultModel    Default model to use when no override is specified
 */
export function createGatewayLLMClient(
  upstreamUrl: string,
  getApiKey: () => string | null,
  defaultModel: { providerID: string; modelID: string },
): LLMClient {
  return {
    async prompt(system, user, opts) {
      const apiKey = getApiKey();
      if (!apiKey) {
        log.warn("no API key available for worker call");
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
                cache_control: { type: "ephemeral", ttl: "3600" },
              },
            ]
          : undefined;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
          },
          // opts.thinking is intentionally not forwarded — this bare API
          // call never includes the `thinking` parameter so Anthropic
          // models won't produce thinking tokens regardless.
          body: JSON.stringify({
            model: model.modelID,
            max_tokens: 8192,
            system: systemPayload ?? system,
            messages: [{ role: "user", content: user }],
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "(no body)");
          log.error(
            `worker upstream request failed: ${response.status} ${response.statusText} — ${text}`,
          );
          return null;
        }

        const data = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };

        const textBlock = data.content?.find(
          (b) => b.type === "text" && typeof b.text === "string",
        );

        return textBlock?.text ?? null;
      } catch (e) {
        log.error("worker prompt failed:", e);
        return null;
      } finally {
        activeWorkerCalls.delete(callID);
      }
    },
  };
}
