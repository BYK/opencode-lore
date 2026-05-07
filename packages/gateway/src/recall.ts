/**
 * Gateway recall interception — transparent memory search for any client.
 *
 * Injects a `recall` tool into upstream requests and handles the response
 * transparently. Two strategies based on whether recall is the only tool:
 *
 *  - **Case 1 (recall-only)**: "Pause and Continue" — pause client stream,
 *    execute recall, send follow-up request, resume streaming in the same
 *    HTTP response.
 *  - **Case 2 (mixed tools)**: "Strip and Inject" — suppress recall blocks
 *    from the client stream, execute recall in background, inject the result
 *    into the next request from the client.
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
} from "@loreai/core";

import type {
  GatewayTool,
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
  GatewayMessage,
  PendingRecall,
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
    },
    required: ["query"],
  },
};

export const RECALL_TOOL_NAME = "recall";

// ---------------------------------------------------------------------------
// Pending recall state (cross-request, Case 2)
// ---------------------------------------------------------------------------

/** TTL for pending recall results — discard after 60 seconds. */
const PENDING_RECALL_TTL_MS = 60_000;

/** Check whether a pending recall is still valid (within TTL). */
export function isPendingRecallValid(pending: PendingRecall): boolean {
  return Date.now() - pending.timestamp < PENDING_RECALL_TTL_MS;
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
} {
  const input = block.input as Record<string, unknown>;
  return {
    query: typeof input.query === "string" ? input.query : "",
    scope: (input.scope as RecallScope) ?? "all",
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
): Promise<{ result: string; input: { query: string; scope?: RecallScope } }> {
  const { query, scope } = parseRecallInput(block);
  const cfg = loreConfig();

  try {
    const result = await runRecall({
      query,
      scope,
      projectPath,
      sessionID,
      knowledgeEnabled: cfg.knowledge?.enabled ?? true,
      searchConfig: cfg.search,
    });

    return { result, input: { query, scope } };
  } catch (e) {
    log.error("gateway recall execution failed:", e);
    return {
      result: "Recall search failed. The memory system encountered an error.",
      input: { query, scope },
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
 *  - The assistant's full response (including the recall tool_use)
 *  - A user message with the recall tool_result
 *  - Tools list WITHOUT recall (so the model won't call it again)
 *
 * The model continues from where it left off, now with recall results
 * in context. Its new response streams directly to the client.
 */
export function buildRecallFollowUp(
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
): GatewayRequest {
  // Build assistant message with ONLY the recall tool_use block.
  // Exclude any pre-recall text/thinking blocks — those were already streamed
  // to the client. By presenting only the tool_use, the model understands it
  // called recall and hasn't yet produced a substantive response, so it will
  // generate new content after receiving the tool_result.
  const assistantMessage: GatewayMessage = {
    role: "assistant",
    content: [recallToolUseBlock],
  };

  // Build user message with tool_result
  const toolResultMessage: GatewayMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: recallToolUseBlock.id,
        content: recallResult || "[No results found.]",
      },
    ],
  };

  // Strip recall from tools list
  const toolsWithoutRecall = originalReq.tools.filter(
    (t) => t.name !== RECALL_TOOL_NAME,
  );

  return {
    ...originalReq,
    messages: [
      ...originalReq.messages,
      assistantMessage,
      toolResultMessage,
    ],
    tools: toolsWithoutRecall,
  };
}

// ---------------------------------------------------------------------------
// Pending recall injection (Case 2: next request enrichment)
// ---------------------------------------------------------------------------

/**
 * Inject a pending recall result into the current request.
 *
 * Finds the last assistant message in `req.messages`, inserts the recall
 * tool_use block at the recorded position, and inserts a tool_result block
 * into the following user message.
 *
 * Mutates the request in-place for efficiency. Returns true if injection
 * was performed, false if the conversation structure didn't match
 * (e.g., no trailing assistant→user pair).
 */
export function injectPendingRecall(
  req: GatewayRequest,
  pending: PendingRecall,
): boolean {
  const messages = req.messages;
  if (messages.length < 2) return false;

  // Find the last assistant message followed by a user message.
  // The pending recall was from the previous turn's assistant response.
  let assistantIdx = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (
      messages[i].role === "assistant" &&
      messages[i + 1]?.role === "user"
    ) {
      assistantIdx = i;
      break;
    }
  }

  if (assistantIdx < 0) {
    log.warn("injectPendingRecall: no assistant→user pair found");
    return false;
  }

  const assistantMsg = messages[assistantIdx];
  const userMsg = messages[assistantIdx + 1];

  // Insert recall tool_use into assistant message at the recorded position.
  // Clamp to content length in case the message was modified by gradient.
  const insertPos = Math.min(pending.position, assistantMsg.content.length);
  const recallToolUse: GatewayToolUseBlock = {
    type: "tool_use",
    id: pending.toolUseId,
    name: RECALL_TOOL_NAME,
    input: pending.input,
  };
  assistantMsg.content.splice(insertPos, 0, recallToolUse);

  // Insert recall tool_result into the user message.
  // Add it at the beginning alongside any other tool_results.
  userMsg.content.unshift({
    type: "tool_result",
    toolUseId: pending.toolUseId,
    content: pending.result,
  });

  // Strip recall from tools list for this request
  req.tools = req.tools.filter((t) => t.name !== RECALL_TOOL_NAME);

  return true;
}

// ---------------------------------------------------------------------------
// Response content stripping (Case 2: remove recall from response)
// ---------------------------------------------------------------------------

/**
 * Build a GatewayResponse with recall tool_use blocks removed.
 *
 * Used for Case 2 to produce a clean response for `postResponse` storage
 * that excludes the gateway-internal recall blocks.
 */
export function stripRecallFromResponse(
  resp: GatewayResponse,
): GatewayResponse {
  return {
    ...resp,
    content: resp.content.filter(
      (b) => !(b.type === "tool_use" && b.name === RECALL_TOOL_NAME),
    ),
  };
}
