/**
 * Synthetic fixture builder for Lore gateway replay tests.
 *
 * Constructs realistic `FixtureEntry` arrays without real API calls so that
 * tests are deterministic and work immediately, before anyone records a
 * real session.
 */
import type { FixtureEntry } from "../../src/recorder";

// ---------------------------------------------------------------------------
// makeTextResponse
// ---------------------------------------------------------------------------

/** Build a minimal non-streaming Anthropic response body. */
export function makeTextResponse(opts: {
  text: string;
  model?: string;
  seq?: number;
  inputTokens?: number;
  outputTokens?: number;
}): FixtureEntry["response"] {
  const model = opts.model ?? "claude-sonnet-4-20250514";
  const seq = opts.seq ?? 0;
  return {
    id: `msg_test_${seq}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: opts.text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 10,
    },
  };
}

// ---------------------------------------------------------------------------
// makeFixtureEntry
// ---------------------------------------------------------------------------

/** Build a complete FixtureEntry for a simple assistant text reply. */
export function makeFixtureEntry(opts: {
  seq: number;
  requestMessages: unknown[];
  system?: string;
  responseText: string;
  model?: string;
  wasStreaming?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}): FixtureEntry {
  const model = opts.model ?? "claude-sonnet-4-20250514";
  return {
    seq: opts.seq,
    ts: Date.now(),
    request: {
      model,
      system: opts.system ?? "",
      messages: opts.requestMessages,
      stream: opts.wasStreaming ?? false,
    },
    response: makeTextResponse({
      text: opts.responseText,
      model,
      seq: opts.seq,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
    }),
    wasStreaming: opts.wasStreaming ?? false,
    model,
  };
}

// ---------------------------------------------------------------------------
// makeConversationFixtures
// ---------------------------------------------------------------------------

/**
 * Build a multi-turn conversation fixture array.
 *
 * Each turn represents one upstream API call — gateway forces non-streaming
 * for the first response so the marker can be injected; subsequent turns
 * may be streaming or not.
 */
export function makeConversationFixtures(
  turns: Array<{
    userMessage: string;
    assistantText: string;
    model?: string;
  }>,
): FixtureEntry[] {
  const fixtures: FixtureEntry[] = [];
  const messages: unknown[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const model = turn.model ?? "claude-sonnet-4-20250514";

    // Add user message to cumulative history
    messages.push({ role: "user", content: turn.userMessage });

    fixtures.push(
      makeFixtureEntry({
        seq: i,
        requestMessages: [...messages],
        responseText: turn.assistantText,
        model,
        wasStreaming: false,
        inputTokens: 100 + i * 50,
        outputTokens: 10 + i * 5,
      }),
    );

    // Add assistant response to cumulative history for next turn
    messages.push({ role: "assistant", content: turn.assistantText });
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Standard 3-tool set (matches smoke-test pattern — passes isTitleOrSummaryRequest)
// ---------------------------------------------------------------------------

/** Three tools that ensure a request is classified as a normal conversation turn. */
export const STANDARD_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
] as const;

/** The default model used throughout fixture tests. */
export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/** A system prompt long enough (≥500 chars) that it's never mistaken for a title agent. */
export const DEFAULT_SYSTEM =
  "You are a helpful coding assistant. " +
  "You have access to tools to read, write and execute code. " +
  "Always think step by step before responding. " +
  "When in doubt, prefer explicit over implicit. " +
  "Keep your responses concise and to the point. " +
  "This system prompt is intentionally longer than 500 characters to ensure " +
  "the gateway pipeline classifies incoming requests as normal conversation " +
  "turns rather than title or summary requests. " +
  "The Lore memory system is active and will accumulate knowledge across sessions.";
