/**
 * Pi implementation of Lore's `LLMClient` interface.
 *
 * Wraps `complete()` from `@mariozechner/pi-ai` with Pi's `ModelRegistry`
 * authentication (via `ctx.modelRegistry.getApiKeyAndHeaders(model)`).
 *
 * Unlike the OpenCode adapter, there's no session lifecycle to manage — pi-ai's
 * `complete()` is a pure function from `(model, context, options) → AssistantMessage`.
 * No worker sessions, no rotation, no agent-not-found retries.
 */
import { complete } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LLMClient } from "@loreai/core";

/**
 * Build an `LLMClient` for a Pi extension context.
 *
 * @param ctx  The Pi extension context (provides model registry + auth)
 * @param defaultModel  The Model to use when `opts.model` is not provided.
 *                      Typically the session's current model (`ctx.model`).
 *
 * Background workers (distillation, curation, query expansion) call
 * `llm.prompt(system, user, opts)`. If `opts.model` is provided, it overrides
 * the default — used when `.lore.json` pins a specific worker model.
 */
export function createPiLLMClient(
  ctx: ExtensionContext,
  defaultModel: Model<any> | null | undefined,
): LLMClient {
  return {
    async prompt(
      system: string,
      user: string,
      opts?: {
        model?: { providerID: string; modelID: string };
        workerID?: string;
        thinking?: boolean;
      },
    ): Promise<string | null> {
      // Resolve the model: opts.model (per-call override) > defaultModel (session model)
      let model: Model<any> | undefined | null;
      if (opts?.model) {
        model = ctx.modelRegistry.find(opts.model.providerID, opts.model.modelID);
        if (!model) {
          // Fall back to the session model if the configured worker model
          // isn't available in this user's registry (e.g. they removed an
          // API key). Silently degrades to default rather than crashing.
          model = defaultModel ?? undefined;
        }
      } else {
        model = defaultModel ?? undefined;
      }

      if (!model) {
        // No model configured and no default — can't do anything useful.
        return null;
      }

      // Fetch the API key + provider-specific headers from Pi's auth store.
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        // Auth failure or no key for the provider. Return null so the
        // calling background task (curator, distiller) silently no-ops
        // this turn — the agent's main flow stays unaffected.
        return null;
      }

      try {
        const response = await complete(
          model,
          {
            systemPrompt: system,
            messages: [
              {
                role: "user",
                content: user,
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            maxTokens: 8192,
            // Surface the ctx.signal if it's defined — lets user abort
            // cancel pending worker LLM calls. Defined during active turns.
            signal: ctx.signal,
            // Explicitly disable thinking when requested. Pi's complete()
            // already defaults to thinkingEnabled: false for streamAnthropic,
            // but being explicit guards against upstream behavior changes.
            ...(opts?.thinking === false ? { thinkingEnabled: false } : {}),
          },
        );

        if (response.stopReason === "aborted" || response.stopReason === "error") {
          return null;
        }

        // Extract all text content chunks and join them. Pi's assistant
        // responses can also contain `thinking` and `toolCall` blocks, but
        // for Lore's single-turn prompts we only care about the text reply.
        const text = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        return text.length > 0 ? text : null;
      } catch {
        // Any error during the call (network, provider, serialization) →
        // silent null so background workers don't poison the main agent.
        return null;
      }
    },
  };
}
