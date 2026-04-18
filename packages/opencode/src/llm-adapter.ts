/**
 * OpenCode LLMClient adapter.
 *
 * Wraps the OpenCode SDK's `client.session.prompt()` into the host-agnostic
 * `LLMClient` interface that @loreai/core expects. Handles:
 *   1. Worker session lifecycle (create → prompt → rotate)
 *   2. "Agent not found" retry (OpenCode loses plugin agent registrations
 *      after a config re-read) — retries once without the agent parameter
 *   3. Error extraction from SDK response objects
 *
 * This is the OpenCode-specific counterpart of what `promptWorker()` used to
 * do in core's worker.ts, but now lives in the host adapter layer.
 */
import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { LLMClient } from "@loreai/core";
import { log, isWorkerSession } from "@loreai/core";

type Client = ReturnType<typeof createOpencodeClient>;

// Re-export workerSessionIDs from core for session tracking
import { workerSessionIDs } from "@loreai/core";

/**
 * Create an LLMClient backed by the OpenCode SDK.
 *
 * Each call to `prompt()` creates a fresh hidden child session, sends the
 * prompt, extracts the text, and discards the session (rotation). This
 * prevents accumulating multiple assistant messages with reasoning/thinking
 * parts, which providers reject.
 *
 * @param client     The OpenCode SDK client
 * @param parentID   Parent session ID — child sessions are created under this
 */
export function createOpenCodeLLMClient(
  client: Client,
  parentID: string,
): LLMClient {
  return {
    async prompt(system, user, opts) {
      // Create a fresh worker session for this call
      let workerID: string;
      try {
        const session = await client.session.create({
          body: { parentID, title: `lore ${opts?.workerID ?? "worker"}` },
        });
        if (!session.data) {
          log.warn("failed to create worker session");
          return null;
        }
        workerID = session.data.id;
        workerSessionIDs.add(workerID);
      } catch (e) {
        log.warn("failed to create worker session:", e);
        return null;
      }

      const parts = [
        { type: "text" as const, text: `${system}\n\n${user}` },
      ];
      const agent = opts?.workerID;
      const model = opts?.model;

      // First attempt — with agent
      let result: { data?: unknown; error?: unknown };
      try {
        result = await client.session.prompt({
          path: { id: workerID },
          body: {
            parts,
            ...(agent ? { agent } : {}),
            ...(model ? { model } : {}),
          },
        });
      } catch (e) {
        result = { error: e };
      }

      const text = extractText(result);
      if (text !== null) return text;

      // Check for agent-not-found -> retry without agent
      const errStr = stringifyError(result.error);
      if (/agent[^"]*not found/i.test(errStr)) {
        log.warn(`agent "${agent}" not found, retrying without agent`);

        // Create a fresh worker session for the retry
        let retryWorkerID: string;
        try {
          const session = await client.session.create({
            body: { parentID },
          });
          if (!session.data) {
            log.warn("failed to create retry worker session");
            return null;
          }
          retryWorkerID = session.data.id;
          workerSessionIDs.add(retryWorkerID);
        } catch (e) {
          log.warn("failed to create retry worker session:", e);
          return null;
        }

        let retry: { data?: unknown; error?: unknown };
        try {
          retry = await client.session.prompt({
            path: { id: retryWorkerID },
            body: {
              parts,
              // No agent parameter — use session defaults
              ...(model ? { model } : {}),
            },
          });
        } catch (e) {
          retry = { error: e };
        }

        const retryText = extractText(retry);
        if (retryText !== null) return retryText;

        log.warn("worker prompt retry also failed:", retry.error);
        return null;
      }

      log.warn("worker prompt failed:", result.error);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first text part from a session.prompt() result. */
function extractText(result: { data?: unknown; error?: unknown }): string | null {
  if (!result.data || typeof result.data !== "object") return null;
  const data = result.data as { parts?: Array<{ type: string; text?: string }> };
  if (!data.parts || !Array.isArray(data.parts)) return null;
  const textPart = data.parts.find(
    (p): p is { type: "text"; text: string } =>
      p.type === "text" && typeof p.text === "string",
  );
  return textPart?.text ?? null;
}

/** Safely stringify an error for regex matching. */
function stringifyError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
