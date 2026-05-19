/**
 * Gateway recall interception — transparent memory search for any client.
 *
 * Uses a unified "Marker and Expand" strategy:
 *
 *  1. **On response (to client):** The recall `tool_use` block is replaced
 *     with a human-readable marker text block
 *     (`📚 Searching <scope> for "<query>"…`). The recall is executed
 *     internally and the result is stored in session state.
 *
 *  2. **On request (from client):** Marker text blocks in the conversation
 *     are expanded back into the original `tool_use` + `tool_result` pairs
 *     before forwarding upstream.
 *
 *  For recall-only responses, a follow-up call is still made internally
 *  so the model can continue in the same HTTP response (seamless UX).
 *
 * All recall execution delegates to `runRecall()` from `@loreai/core`.
 */
import {
  runRecall,
  RECALL_TOOL_DESCRIPTION,
  RECALL_PARAM_DESCRIPTIONS,
  log,
  config as loreConfig,
  type RecallScope,
  type LLMClient,
} from "@loreai/core";

import type {
  GatewayTool,
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
  GatewayMessage,
  RecallStore,
} from "./translate/types";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** Recall tool definition for injection into upstream requests. */
export const RECALL_GATEWAY_TOOL: GatewayTool = {
  name: "recall",
  description: RECALL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: RECALL_PARAM_DESCRIPTIONS.query,
      },
      scope: {
        type: "string",
        enum: ["all", "session", "project", "knowledge"],
        description: RECALL_PARAM_DESCRIPTIONS.scope,
      },
      id: {
        type: "string",
        description: RECALL_PARAM_DESCRIPTIONS.id,
      },
    },
    required: ["query"],
  },
};

export const RECALL_TOOL_NAME = "recall";

/** Safety-net cap on recall follow-ups per client request (like any agentic loop). */
export const MAX_RECALL_DEPTH = 10;

// ---------------------------------------------------------------------------
// Marker utilities — human-readable text ↔ recall tool round-trip
// ---------------------------------------------------------------------------

/** Scope → human-readable label for marker text. */
const SCOPE_LABELS: Record<string, string> = {
  all: "all archives",
  session: "session history",
  project: "project archives",
  knowledge: "knowledge base",
};

/** Reverse: label → scope enum. */
const LABEL_TO_SCOPE: Record<string, RecallScope> = Object.fromEntries(
  Object.entries(SCOPE_LABELS).map(([k, v]) => [v, k as RecallScope]),
);

/** Map a recall scope to a human-readable label. */
export function scopeToLabel(scope: string = "all"): string {
  return SCOPE_LABELS[scope] ?? SCOPE_LABELS.all;
}

/** Map a human-readable label back to a scope enum value. */
export function labelToScope(label: string): RecallScope {
  return LABEL_TO_SCOPE[label] ?? "all";
}

/**
 * Build a marker text string for a recall tool call.
 *
 * Format: `📚 Searching <scope-label> for "<query>"…`
 * When `id` is provided (detail lookup), uses: `📚 Fetching detail for <id>…`
 */
export function buildRecallMarker(query: string, scope: string = "all", id?: string): string {
  if (id) return `📚 Fetching detail for ${id}…`;
  return `📚 Searching ${scopeToLabel(scope)} for "${query}"…`;
}

/** Regex to parse a recall marker back into query + scope. */
const MARKER_REGEX = /📚 Searching (.+?) for "(.+?)"…/;

/** Regex to parse an id-based recall marker. */
const ID_MARKER_REGEX = /📚 Fetching detail for (.+?)…/;

/** Check if a text string is a recall marker (search or detail). */
export function isRecallMarker(text: string): boolean {
  return parseRecallMarker(text) !== null;
}

/**
 * Parse a recall marker text block, returning query and scope if valid.
 * Returns null if the text doesn't match the marker format.
 */
export function parseRecallMarker(
  text: string,
): { query: string; scope: RecallScope; id?: string } | null {
  // Try id-based marker first
  const idMatch = ID_MARKER_REGEX.exec(text);
  if (idMatch) {
    return { query: "", scope: "all", id: idMatch[1] };
  }
  const match = MARKER_REGEX.exec(text);
  if (!match) return null;
  return {
    query: match[2],
    scope: labelToScope(match[1]),
  };
}

/** Derive a store key from query + scope, or from id for detail lookups. */
export function recallStoreKey(query: string, scope: string = "all", id?: string): string {
  if (id) return `id:${id}`;
  return `${scope}:${query}`;
}

// ---------------------------------------------------------------------------
// Marker expansion — restore tool_use + tool_result from markers on inbound
// ---------------------------------------------------------------------------

/**
 * Find recall marker text blocks in the conversation and expand them
 * back into tool_use + tool_result pairs for the upstream API.
 *
 * Scans ALL assistant messages (not just the last one) since markers
 * persist across turns until gradient evicts the message.
 *
 * Mutates the request in-place. Returns true if any expansion was performed.
 */
export function expandRecallMarkers(
  req: GatewayRequest,
  store: RecallStore,
): boolean {
  let expanded = false;

  // Iterate forward; when we splice messages the index is adjusted.
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.role !== "assistant") continue;

    // Find the first (should be only) recall marker in this message.
    // We process one marker per assistant message per pass; the outer
    // loop will revisit if there's more than one (rare).
    let markerIdx = -1;
    let parsed: { query: string; scope: RecallScope; id?: string } | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block.type !== "text") continue;
      parsed = parseRecallMarker(block.text);
      if (parsed) {
        markerIdx = j;
        break;
      }
    }

    if (markerIdx < 0 || !parsed) continue;

    const key = recallStoreKey(parsed.query, parsed.scope, parsed.id);
    const stored = store.get(key);
    if (!stored) continue; // No stored result — leave marker as-is

    // Check if there's non-tool content AFTER the marker in this message.
    // This happens when recall-only follow-up piped continuation content
    // (text blocks) into the same assistant message. Tool_use blocks after
    // the marker are from the same turn (mixed tools) and stay together.
    const afterMarker = msg.content.slice(markerIdx + 1);
    const hasContinuationAfter = afterMarker.length > 0 &&
      afterMarker.some((b) => b.type !== "tool_use");

    // Replace marker with tool_use
    msg.content[markerIdx] = {
      type: "tool_use",
      id: stored.toolUseId,
      name: RECALL_TOOL_NAME,
      input: stored.input,
    };

    // Truncate assistant message at the tool_use (remove continuation)
    if (hasContinuationAfter) {
      msg.content.length = markerIdx + 1;
    }

    // Build synthetic tool_result user message
    const toolResultMsg: GatewayMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: stored.toolUseId,
          content: stored.result,
        },
      ],
    };

    if (hasContinuationAfter) {
      // Split: insert tool_result user message + continuation assistant
      // message after the current assistant message.
      const continuationMsg: GatewayMessage = {
        role: "assistant",
        content: afterMarker,
      };
      req.messages.splice(i + 1, 0, toolResultMsg, continuationMsg);
      // Skip past the two newly inserted messages
      i += 2;
    } else {
      // No split needed — insert tool_result into the following user message.
      // Prepend (unshift) so the recall result appears before existing
      // tool_results — matching the tool_use order in the assistant message.
      const nextMsg = req.messages[i + 1];
      if (nextMsg?.role === "user") {
        nextMsg.content.unshift({
          type: "tool_result",
          toolUseId: stored.toolUseId,
          content: stored.result,
        });
      } else {
        // No following user message — insert a synthetic one
        req.messages.splice(i + 1, 0, toolResultMsg);
        i += 1;
      }
    }

    expanded = true;
  }

  return expanded;
}

/**
 * Clean up orphaned recall store entries whose markers no longer
 * appear in the conversation (e.g. gradient evicted the turn).
 */
export function cleanupRecallStore(
  req: GatewayRequest,
  store: RecallStore,
): void {
  if (store.size === 0) return;

  // Collect all marker keys still present in assistant messages
  const activeKeys = new Set<string>();
  for (const msg of req.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const parsed = parseRecallMarker(block.text);
      if (parsed) {
        activeKeys.add(recallStoreKey(parsed.query, parsed.scope, parsed.id));
      }
    }
  }

  // Remove entries not referenced by any current marker
  for (const key of store.keys()) {
    if (!activeKeys.has(key)) {
      store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Find the recall tool_use block in a GatewayResponse, if any. */
export function findRecallToolUse(
  resp: GatewayResponse,
): GatewayToolUseBlock | undefined {
  return resp.content.find(
    (b): b is GatewayToolUseBlock =>
      b.type === "tool_use" && b.name === RECALL_TOOL_NAME,
  );
}

/** Check whether a response contains a recall tool_use. */
export function hasRecallToolUse(resp: GatewayResponse): boolean {
  return findRecallToolUse(resp) !== undefined;
}

/** Check whether the response contains non-recall tool_use blocks. */
export function hasOtherToolUse(resp: GatewayResponse): boolean {
  return resp.content.some(
    (b) => b.type === "tool_use" && b.name !== RECALL_TOOL_NAME,
  );
}

/** Check whether the client's tools list already includes a recall tool. */
export function clientHasRecallTool(tools: GatewayTool[]): boolean {
  return tools.some((t) => t.name === RECALL_TOOL_NAME);
}

// ---------------------------------------------------------------------------
// Recall execution
// ---------------------------------------------------------------------------

/** Parse recall input from the tool_use block. */
function parseRecallInput(block: GatewayToolUseBlock): {
  query: string;
  scope: RecallScope;
  id?: string;
} {
  const input = block.input as Record<string, unknown>;
  return {
    query: typeof input.query === "string" ? input.query : "",
    scope: (input.scope as RecallScope) ?? "all",
    ...(typeof input.id === "string" && input.id ? { id: input.id } : {}),
  };
}

/**
 * Execute the recall tool and return formatted results.
 *
 * Wraps `runRecall()` with error handling — on failure returns a
 * user-friendly error string rather than throwing.
 */
export async function executeRecall(
  block: GatewayToolUseBlock,
  projectPath: string,
  sessionID: string,
  llm?: LLMClient,
): Promise<{ result: string; input: { query: string; scope?: RecallScope; id?: string } }> {
  const { query, scope, id } = parseRecallInput(block);
  const cfg = loreConfig();

  try {
    const result = await runRecall({
      query,
      scope,
      id,
      projectPath,
      sessionID,
      knowledgeEnabled: cfg.knowledge?.enabled ?? true,
      llm,
      searchConfig: cfg.search,
    });

    return { result, input: { query, scope, id } };
  } catch (e) {
    log.error("gateway recall execution failed:", e);
    return {
      result: "Recall search failed. The memory system encountered an error.",
      input: { query, scope, id },
    };
  }
}

// ---------------------------------------------------------------------------
// Follow-up request builder (Case 1: recall-only)
// ---------------------------------------------------------------------------

/**
 * Build a follow-up request after recall execution.
 *
 * The follow-up includes:
 *  - All original messages
 *  - The assistant's full response (with recall tool_use replaced by marker text)
 *  - A user message with the recall results as plain text
 *  - Full tools list (including recall — the continuation is recall-aware)
 *
 * The model continues from where it left off, now with recall results
 * in context. If it needs more detail it can call recall again.
 */
export function buildRecallFollowUp(
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
): GatewayRequest {
  // Build the follow-up using plain text blocks instead of tool_use/tool_result.
  //
  // Why: marker text is what the client sees in its conversation history.
  // Using text blocks keeps the follow-up consistent with the marker-based
  // round-trip strategy (expandRecallMarkers reconstructs proper tool_use +
  // tool_result pairs on the next client turn).
  //
  // Thinking blocks MUST be preserved: the Anthropic API requires thinking
  // blocks (with their cryptographic signatures) to precede content blocks
  // in assistant messages when extended thinking is enabled.
  // Using a deny-list (exclude text/tool_use/tool_result) rather than an
  // allow-list so future block types (e.g. redacted_thinking) are preserved
  // by default.
  const prefixBlocks = resp.content.filter(
    (b) => b.type !== "text" && b.type !== "tool_use" && b.type !== "tool_result",
  );

  // Build a marker text for what was recalled
  const input = recallToolUseBlock.input as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query : "";
  const scope = (input.scope as string) ?? "all";
  const id = typeof input.id === "string" && input.id ? input.id : undefined;
  const markerText = buildRecallMarker(query, scope, id);

  const assistantMessage: GatewayMessage = {
    role: "assistant",
    content: [...prefixBlocks, { type: "text" as const, text: markerText }],
  };

  // Provide recall results as plain text in the user message
  const resultMessage: GatewayMessage = {
    role: "user",
    content: [
      {
        type: "text" as const,
        text: recallResult || "[No results found.]",
      },
    ],
  };

  return {
    ...originalReq,
    messages: [
      ...originalReq.messages,
      assistantMessage,
      resultMessage,
    ],
  };
}

// ---------------------------------------------------------------------------
// Response content rewriting — replace recall tool_use with marker text
// ---------------------------------------------------------------------------

/**
 * Build a GatewayResponse with recall tool_use blocks replaced by marker text.
 *
 * Used for both recall-only and mixed-tools cases to produce a response
 * where the client sees human-readable markers instead of tool call mechanics.
 */
export function replaceRecallWithMarker(
  resp: GatewayResponse,
): GatewayResponse {
  return {
    ...resp,
    content: resp.content.map((b) => {
      if (b.type === "tool_use" && b.name === RECALL_TOOL_NAME) {
        const input = b.input as Record<string, unknown>;
        const query = typeof input.query === "string" ? input.query : "";
        const scope = (input.scope as string) ?? "all";
        const id = typeof input.id === "string" && input.id ? input.id : undefined;
        return { type: "text" as const, text: buildRecallMarker(query, scope, id) };
      }
      return b;
    }),
  };
}
