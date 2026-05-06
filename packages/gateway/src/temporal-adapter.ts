/**
 * Converts raw Anthropic API messages (as they appear in request/response
 * bodies) into `@loreai/core`'s `LoreMessageWithParts` shape for temporal
 * storage and gradient transform.
 *
 * Follows the same tool-pairing pattern used by the Pi adapter
 * (`packages/pi/src/adapter.ts`): tool_use blocks on assistant messages are
 * initially stored as "pending", then `resolveToolResults` walks the
 * conversation to merge matching tool_result blocks from subsequent user
 * messages into "completed" state.
 */
import { randomUUID } from "crypto";
import { isToolPart } from "@loreai/core";
import type {
  LoreAssistantMessage,
  LoreMessageWithParts,
  LorePart,
  LoreReasoningPart,
  LoreTextPart,
  LoreToolPart,
  LoreUserMessage,
} from "@loreai/core";
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayUsage,
} from "./translate/types";

// ---------------------------------------------------------------------------
// Part conversion helpers
// ---------------------------------------------------------------------------

function contentBlockToPart(
  block: GatewayContentBlock,
  sessionID: string,
  messageID: string,
): LorePart {
  const now = Date.now();
  switch (block.type) {
    case "text":
      return {
        id: randomUUID(),
        sessionID,
        messageID,
        type: "text",
        text: block.text,
        time: { start: now, end: now },
      } satisfies LoreTextPart;

    case "thinking":
      return {
        id: randomUUID(),
        sessionID,
        messageID,
        type: "reasoning",
        text: block.thinking,
      } satisfies LoreReasoningPart;

    case "tool_use":
      return {
        id: randomUUID(),
        sessionID,
        messageID,
        type: "tool",
        tool: block.name,
        callID: block.id,
        state: { status: "pending", input: block.input },
      } satisfies LoreToolPart;

    case "tool_result":
      return {
        id: randomUUID(),
        sessionID,
        messageID,
        type: "tool",
        tool: "result",
        callID: block.toolUseId,
        state: {
          status: "completed",
          input: null,
          output: block.content,
          time: { start: now, end: now },
        },
      } satisfies LoreToolPart;
  }
}

// ---------------------------------------------------------------------------
// 1. gatewayMessagesToLore
// ---------------------------------------------------------------------------

/**
 * Convert an array of gateway messages to Lore's message-with-parts format.
 *
 * User messages get minimal metadata (we don't know the model at message
 * level). Assistant messages get zeroed-out token counts — call
 * `updateAssistantMessageTokens` after accumulating the API response to
 * fill them in.
 */
export function gatewayMessagesToLore(
  messages: GatewayMessage[],
  sessionID: string,
): LoreMessageWithParts[] {
  const out: LoreMessageWithParts[] = [];
  const now = Date.now();

  for (const m of messages) {
    const id = randomUUID();
    const parts: LorePart[] = m.content.map((block) =>
      contentBlockToPart(block, sessionID, id),
    );

    if (m.role === "user") {
      const info: LoreUserMessage = {
        id,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "gateway",
        model: { providerID: "anthropic", modelID: "unknown" },
      };
      out.push({ info, parts });
    } else {
      const info: LoreAssistantMessage = {
        id,
        sessionID,
        role: "assistant",
        time: { created: now },
        parentID: "",
        modelID: "unknown",
        providerID: "anthropic",
        mode: "gateway",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
      out.push({ info, parts });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. updateAssistantMessageTokens
// ---------------------------------------------------------------------------

/**
 * Update an assistant message's token counts from the API response usage data.
 * Mutates in place — call after the upstream response is fully accumulated.
 */
export function updateAssistantMessageTokens(
  msg: LoreMessageWithParts,
  usage: GatewayUsage,
  model: string,
): void {
  const info = msg.info;
  if (info.role !== "assistant") return;

  info.tokens.input = usage.inputTokens;
  info.tokens.output = usage.outputTokens;
  info.tokens.cache.read = usage.cacheReadInputTokens ?? 0;
  info.tokens.cache.write = usage.cacheCreationInputTokens ?? 0;
  info.modelID = model;
}

// ---------------------------------------------------------------------------
// 3. resolveToolResults
// ---------------------------------------------------------------------------

/**
 * Walk through the messages and match tool_result blocks (on user messages)
 * with their corresponding tool_use blocks (on preceding assistant messages).
 *
 * When a tool_use was initially stored as "pending", update it to "completed"
 * with the output from the matching tool_result. This mirrors the tool-pairing
 * pattern used in the Pi adapter (`piMessagesToLore`).
 *
 * After resolving, strips all `tool: "result"` parts from user messages.
 * Their data is now redundant (merged into the assistant's completed tool part).
 * This prevents orphaned `tool_result` blocks when gradient evicts the assistant
 * message but keeps the following user message — the Anthropic API requires every
 * `tool_result` to reference a `tool_use` on the immediately preceding assistant.
 *
 * Mutates messages in place.
 */
export function resolveToolResults(messages: LoreMessageWithParts[]): void {
  // --- Pass 1: Index all tool_result parts by callID ---
  const resultsByCallID = new Map<
    string,
    { output: string; isError: boolean }
  >();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool === "result" &&
        part.state.status === "completed"
      ) {
        resultsByCallID.set(part.callID, {
          output: part.state.output,
          isError: false,
        });
      }
    }
  }

  // --- Pass 2: Resolve pending tool_use → completed where a result exists ---
  const now = Date.now();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool !== "result" &&
        part.state.status === "pending"
      ) {
        const result = resultsByCallID.get(part.callID);
        if (result) {
          part.state = {
            status: "completed",
            input: part.state.input,
            output: result.output,
            time: { start: now, end: now },
          };
        }
      }
    }
  }

  // --- Pass 3: Strip redundant tool_result parts from user messages ---
  // After resolving, tool_result data lives on the assistant's completed
  // tool part. Keeping it on user messages creates orphaned tool_result
  // blocks when gradient evicts the assistant but keeps the user.
  // loreMessagesToGateway() reconstructs tool_result blocks from the
  // assistant's completed/error tool parts, so no data is lost.
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    const before = msg.parts.length;
    msg.parts = msg.parts.filter(
      (p) => !(isToolPart(p) && p.tool === "result"),
    );
    // If stripping left the user message with no content parts,
    // add a placeholder text part so the message survives API conversion.
    if (msg.parts.length === 0 && before > 0) {
      msg.parts = [
        {
          id: randomUUID(),
          sessionID: "",
          messageID: msg.info.id,
          type: "text" as const,
          text: "[tool results provided]",
          time: { start: 0, end: 0 },
        } satisfies LoreTextPart,
      ];
    }
  }
}
