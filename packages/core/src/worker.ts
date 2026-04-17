/**
 * Shared worker session management and resilient LLM prompting.
 *
 * All lore background tasks (distillation, curation, query expansion) use
 * hidden child sessions to call the LLM. This module owns the shared
 * workerSessionIDs set and provides promptWorker() — a helper that:
 *   1. Calls session.prompt() and uses the response directly (no redundant
 *      session.messages() round-trip).
 *   2. Detects "agent not found" errors (when OpenCode loses plugin agent
 *      registrations after a config re-read) and retries without the agent
 *      parameter.
 *   3. Rotates the worker session after each call to prevent accumulating
 *      multiple assistant messages with reasoning/thinking parts.
 */
import type { createOpencodeClient } from "@opencode-ai/sdk";
import * as log from "./log";

type Client = ReturnType<typeof createOpencodeClient>;

// ---------------------------------------------------------------------------
// Shared worker session tracking
// ---------------------------------------------------------------------------

/** Set of ALL worker session IDs across distillation, curator, and query expansion.
 *  Used by shouldSkip() in index.ts to avoid storing/distilling worker messages. */
export const workerSessionIDs = new Set<string>();

export function isWorkerSession(sessionID: string): boolean {
  return workerSessionIDs.has(sessionID);
}

// ---------------------------------------------------------------------------
// Resilient worker prompting
// ---------------------------------------------------------------------------

/**
 * Send a prompt to a worker session and return the assistant's text response.
 *
 * Uses the session.prompt() return value directly instead of making a separate
 * session.messages() call. If the prompt fails because the agent is not found
 * (OpenCode lost plugin agent registrations), retries once without the agent
 * parameter.
 *
 * @returns The assistant's text response, or `null` if the prompt failed.
 */
export async function promptWorker(opts: {
  client: Client;
  workerID: string;
  parts: Array<{ type: "text"; text: string }>;
  agent: string;
  model?: { providerID: string; modelID: string };
  /** Module-local worker session map — entry is deleted after the call (rotation). */
  sessionMap: Map<string, string>;
  /** Key in sessionMap (typically the parent session ID). Also used as parentID
   *  when creating a fresh session for retry. */
  sessionKey: string;
}): Promise<string | null> {
  const { client, parts, agent, model, sessionMap, sessionKey } = opts;
  let { workerID } = opts;

  // First attempt — with agent
  let result: { data?: unknown; error?: unknown };
  try {
    result = await client.session.prompt({
      path: { id: workerID },
      body: {
        parts,
        agent,
        ...(model ? { model } : {}),
      },
    });
  } catch (e) {
    // SDK may throw instead of returning an error object (e.g. malformed
    // response body → JSON parse error). Treat as a prompt failure.
    result = { error: e };
  }

  // Always rotate the worker session after a prompt attempt — prevents
  // accumulating multiple assistant messages with reasoning/thinking parts,
  // which providers reject ("Multiple reasoning_opaque values").
  sessionMap.delete(sessionKey);

  const text = extractText(result);
  if (text !== null) return text;

  // Check for agent-not-found → retry without agent
  const errStr = stringifyError(result.error);
  if (/agent[^"]*not found/i.test(errStr)) {
    log.warn(`agent "${agent}" not found, retrying without agent`);

    // Create a fresh worker session for the retry
    let retryWorkerID: string;
    try {
      const session = await client.session.create({
        body: { parentID: sessionKey },
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
