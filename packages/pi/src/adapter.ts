/**
 * Type adapters between Pi's message/content types and Lore's host-agnostic
 * types (`LoreMessage`, `LorePart`, `LoreMessageWithParts`).
 *
 * Pi uses a flat `Message[]` where each message has a role and a content array.
 * Tool calls are content blocks on assistant messages; tool results are separate
 * `ToolResultMessage` entries with matching `toolCallId`.
 *
 * Lore's gradient engine operates on `{ info, parts }[]` — where an assistant
 * message's tool calls are merged with their subsequent tool results into
 * `LoreToolPart`s with `state.status === "completed" | "error"`.
 *
 * These adapters bridge the shape mismatch without losing information:
 *   Pi Message[]  → LoreMessageWithParts[]   (for gradient input)
 *   Pi Message    → LoreMessage + LorePart[] (for temporal capture on message_end)
 */
import type {
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from "@mariozechner/pi-ai";
import type {
  LoreAssistantMessage,
  LoreMessage,
  LoreMessageWithParts,
  LorePart,
  LoreReasoningPart,
  LoreTextPart,
  LoreToolPart,
  LoreUserMessage,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// Synthetic ID generation
// ---------------------------------------------------------------------------
//
// Pi's messages don't carry IDs. Lore's DB schema and gradient caching both
// expect stable IDs — so we synthesize them from `role + timestamp + index`.
// Collisions are avoided by including a per-conversion sequence number.
//
// The IDs are opaque to Pi and only flow through Lore's internal bookkeeping;
// they don't need to round-trip back into Pi's session state.

function messageID(
  role: PiMessage["role"],
  timestamp: number,
  index: number,
): string {
  return `pi-${role}-${timestamp}-${index}`;
}

function partID(messageId: string, partIndex: number): string {
  return `${messageId}-p${partIndex}`;
}

// ---------------------------------------------------------------------------
// Pi → Lore: full conversation conversion (for `context` hook)
// ---------------------------------------------------------------------------

/**
 * Convert Pi's flat Message[] into Lore's grouped LoreMessageWithParts[].
 *
 * Tool calls on an assistant message are merged with their matching
 * `ToolResultMessage` entries so Lore's gradient sees a single `LoreToolPart`
 * per call with terminal state (`completed` or `error`).
 *
 * @param sessionID  Pi doesn't expose a session ID to extensions in every event,
 *                   so the caller passes a stable value (e.g. from the session file
 *                   path hash, or an empty string when not needed).
 */
export function piMessagesToLore(
  messages: PiMessage[],
  sessionID: string,
): LoreMessageWithParts[] {
  // Pre-scan: index ToolResultMessages by toolCallId so we can attach their
  // content to the originating assistant tool call.
  const toolResults = new Map<string, PiToolResultMessage>();
  for (const m of messages) {
    if (m.role === "toolResult") {
      toolResults.set(m.toolCallId, m);
    }
  }

  const out: LoreMessageWithParts[] = [];
  messages.forEach((m, index) => {
    // ToolResult messages are folded into the preceding assistant message —
    // skip them here, they're consumed via `toolResults`.
    if (m.role === "toolResult") return;

    if (m.role === "user") {
      out.push(userMessageToLore(m, sessionID, index));
    } else {
      out.push(assistantMessageToLore(m, sessionID, index, toolResults));
    }
  });

  return out;
}

function userMessageToLore(
  m: PiUserMessage,
  sessionID: string,
  index: number,
): LoreMessageWithParts {
  const id = messageID("user", m.timestamp, index);
  const info: LoreUserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: m.timestamp },
    // Pi doesn't surface agent/model on user messages — fill with blanks.
    // These flow through into Lore's temporal storage metadata but aren't
    // read back by the gradient or curator logic.
    agent: "",
    model: { providerID: "", modelID: "" },
  };

  const parts: LorePart[] = [];
  if (typeof m.content === "string") {
    parts.push({
      id: partID(id, 0),
      sessionID,
      messageID: id,
      type: "text",
      text: m.content,
      time: { start: m.timestamp, end: m.timestamp },
    });
  } else {
    m.content.forEach((c, i) => {
      if (c.type === "text") {
        parts.push({
          id: partID(id, i),
          sessionID,
          messageID: id,
          type: "text",
          text: c.text,
          time: { start: m.timestamp, end: m.timestamp },
        });
      }
      // Image parts flow through as generic — Lore doesn't process them
      // for text extraction and they're preserved by spread in the gradient.
      // Spread first so the explicit `id`/`sessionID`/`messageID` overrides
      // any stray fields from Pi and we keep the correct `type` discriminant.
      else {
        parts.push({
          ...c,
          id: partID(id, i),
          sessionID,
          messageID: id,
          type: c.type,
        });
      }
    });
  }

  return { info, parts };
}

function assistantMessageToLore(
  m: PiAssistantMessage,
  sessionID: string,
  index: number,
  toolResults: Map<string, PiToolResultMessage>,
): LoreMessageWithParts {
  const id = messageID("assistant", m.timestamp, index);
  const info: LoreAssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: m.timestamp },
    // Pi's AssistantMessage has provider + model strings — pack them into
    // Lore's equivalent fields. `parentID` isn't meaningful on Pi so we point
    // at a synthetic prior user message ID scheme (empty is acceptable).
    parentID: "",
    modelID: m.model,
    providerID: m.provider,
    mode: "build",
    path: { cwd: "", root: "" },
    cost: m.usage?.cost?.total ?? 0,
    tokens: {
      input: m.usage?.input ?? 0,
      output: m.usage?.output ?? 0,
      reasoning: 0, // Pi tracks thinking separately — not directly mapped.
      cache: {
        read: m.usage?.cacheRead ?? 0,
        write: m.usage?.cacheWrite ?? 0,
      },
    },
  };

  const parts: LorePart[] = [];
  m.content.forEach((c, i) => {
    const pid = partID(id, i);
    if (c.type === "text") {
      parts.push({
        id: pid,
        sessionID,
        messageID: id,
        type: "text",
        text: c.text,
        time: { start: m.timestamp, end: m.timestamp },
      } satisfies LoreTextPart);
    } else if (c.type === "thinking") {
      // Map Pi's "thinking" to Lore's "reasoning" part type.
      parts.push({
        id: pid,
        sessionID,
        messageID: id,
        type: "reasoning",
        text: c.thinking,
      } satisfies LoreReasoningPart);
    } else if (c.type === "toolCall") {
      // Merge with matching ToolResultMessage if available.
      const result = toolResults.get(c.id);
      const loreToolPart: LoreToolPart = result
        ? {
            id: pid,
            sessionID,
            messageID: id,
            type: "tool",
            tool: c.name,
            callID: c.id,
            state: result.isError
              ? {
                  status: "error",
                  input: c.arguments,
                  error: extractToolContentText(result.content),
                  time: { start: m.timestamp, end: result.timestamp },
                }
              : {
                  status: "completed",
                  input: c.arguments,
                  output: extractToolContentText(result.content),
                  time: { start: m.timestamp, end: result.timestamp },
                },
          }
        : {
            // No matching result yet — this shouldn't happen for a completed
            // turn but can appear mid-stream. Mark pending so gradient can
            // decide whether to keep or downgrade it.
            id: pid,
            sessionID,
            messageID: id,
            type: "tool",
            tool: c.name,
            callID: c.id,
            state: {
              status: "pending",
              input: c.arguments,
            },
          };
      parts.push(loreToolPart);
    }
  });

  return { info, parts };
}

function extractToolContentText(
  content: PiToolResultMessage["content"],
): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pi → Lore: single-message conversion (for `message_end` hook / temporal capture)
// ---------------------------------------------------------------------------

/**
 * Convert a single Pi message into Lore shape for temporal storage.
 *
 * Returns null for `toolResult` messages — those are captured as part of the
 * preceding assistant message's tool parts in the full-conversation conversion
 * (when gradient / recall fires). Storing them separately would double-count.
 *
 * @param index A monotonically increasing counter the caller maintains per-session
 *              to ensure unique IDs for messages with identical timestamps.
 */
export function piMessageToLore(
  m: PiMessage,
  sessionID: string,
  index: number,
): { info: LoreMessage; parts: LorePart[] } | null {
  if (m.role === "toolResult") return null;
  if (m.role === "user") {
    const { info, parts } = userMessageToLore(m, sessionID, index);
    return { info, parts };
  }
  // Assistant — no tool-result pairing here; pending tool parts stay pending.
  // They'll be reconciled on the next `context` event or full conversion.
  const { info, parts } = assistantMessageToLore(
    m,
    sessionID,
    index,
    new Map(),
  );
  return { info, parts };
}
