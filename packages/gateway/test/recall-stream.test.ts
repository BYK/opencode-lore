/**
 * Unit tests for the RecallAwareStreamAccumulator.
 *
 * Tests the streaming recall interception logic:
 *  - No recall → all events forwarded unchanged
 *  - Recall-only → recall block suppressed, held-back events correct
 *  - Mixed tools → recall suppressed, other tools re-indexed
 *  - Recall at different positions (first, middle, last tool)
 *  - Block index renumbering correctness
 */
import { describe, test, expect } from "bun:test";
import {
  createRecallAwareAccumulator,
  formatSSEEvent,
} from "../src/stream/anthropic";

// ---------------------------------------------------------------------------
// Helpers: build SSE events matching Anthropic's streaming format
// ---------------------------------------------------------------------------

function messageStart(
  id = "msg_test",
  model = "claude-sonnet-4-20250514",
): { event: string; data: string } {
  return {
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }),
  };
}

function contentBlockStart(
  index: number,
  block: Record<string, unknown>,
): { event: string; data: string } {
  return {
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: block,
    }),
  };
}

function textBlockStart(index: number): { event: string; data: string } {
  return contentBlockStart(index, { type: "text", text: "" });
}

function toolUseBlockStart(
  index: number,
  name: string,
  id = `toolu_${index}`,
): { event: string; data: string } {
  return contentBlockStart(index, { type: "tool_use", id, name });
}

function contentBlockDelta(
  index: number,
  delta: Record<string, unknown>,
): { event: string; data: string } {
  return {
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta,
    }),
  };
}

function textDelta(
  index: number,
  text: string,
): { event: string; data: string } {
  return contentBlockDelta(index, { type: "text_delta", text });
}

function inputJsonDelta(
  index: number,
  json: string,
): { event: string; data: string } {
  return contentBlockDelta(index, { type: "input_json_delta", partial_json: json });
}

function contentBlockStop(
  index: number,
): { event: string; data: string } {
  return {
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  };
}

function messageDelta(
  stopReason = "end_turn",
): { event: string; data: string } {
  return {
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 50 },
    }),
  };
}

function messageStop(): { event: string; data: string } {
  return {
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  };
}

/** Process a sequence of events and return the concatenated forwarded text. */
function processAll(
  accum: ReturnType<typeof createRecallAwareAccumulator>,
  events: Array<{ event: string; data: string }>,
): string {
  let output = "";
  for (const { event, data } of events) {
    output += accum.processEvent(event, data);
  }
  return output;
}

/** Count SSE events in a forwarded string (each event has "event: ..." line). */
function countSSEEvents(sse: string): number {
  return (sse.match(/^event: /gm) ?? []).length;
}

/** Parse all events from forwarded SSE text. */
function parseForwardedEvents(
  sse: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const results: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = sse.split("\n\n").filter((b) => b.trim());
  for (const block of blocks) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) {
      try {
        results.push({ event, data: JSON.parse(data) });
      } catch {
        // skip non-JSON
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests: No recall
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — no recall", () => {
  test("all events forwarded unchanged", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello "),
      textDelta(0, "world"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(false);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.heldBackEvents()).toBe("");
    expect(countSSEEvents(output)).toBe(7);
  });

  test("tool_use blocks forwarded with unchanged indices", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me read that."),
      contentBlockStop(0),
      toolUseBlockStart(1, "Read"),
      inputJsonDelta(1, '{"path":"/a"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // tool_use block should have index 1
    const toolStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStart).toBeDefined();
    expect(toolStart!.data.index).toBe(1);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.hasRecall()).toBe(false);
  });

  test("getResponse returns complete response", () => {
    const accum = createRecallAwareAccumulator();
    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ]);

    const resp = accum.getResponse();
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("text");
    expect((resp.content[0] as { text: string }).text).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Tests: Recall-only (Case 1)
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — recall-only (Case 1)", () => {
  test("suppresses recall block events, holds back message_delta/stop", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me search my memory."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"config"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.recallBlockIndex()).toBe(1);
    expect(accum.clientBlockCount()).toBe(1); // Only the text block

    // Should have forwarded: message_start + text block (start, 2x delta, stop) = 4
    // Should NOT have forwarded: recall block (3 events) + message_delta + message_stop
    const parsed = parseForwardedEvents(output);
    const eventTypes = parsed.map((e) => e.event);
    expect(eventTypes).not.toContain("message_delta");
    expect(eventTypes).not.toContain("message_stop");

    // Verify no recall tool_use in forwarded events
    const toolStarts = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStarts).toHaveLength(0);

    // Held-back events should contain message_delta + message_stop
    const heldBack = accum.heldBackEvents();
    expect(heldBack).toContain("message_delta");
    expect(heldBack).toContain("message_stop");
  });

  test("getResponse includes the recall block for follow-up building", () => {
    const accum = createRecallAwareAccumulator();
    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Searching..."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"config path"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]);

    const resp = accum.getResponse();
    expect(resp.content).toHaveLength(2);
    expect(resp.content[0].type).toBe("text");
    expect(resp.content[1].type).toBe("tool_use");
    expect((resp.content[1] as { name: string }).name).toBe("recall");
    expect(resp.stopReason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// Tests: Mixed tools (Case 2)
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — mixed tools (Case 2)", () => {
  test("suppresses recall, forwards other tools with re-indexed indices", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Working on it."),
      contentBlockStop(0),
      // recall at index 1 — suppressed
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"test"}'),
      contentBlockStop(1),
      // Read at index 2 — should become index 1 for client
      toolUseBlockStart(2, "Read", "toolu_read"),
      inputJsonDelta(2, '{"path":"/a"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);

    // Parse forwarded events
    const parsed = parseForwardedEvents(output);

    // Find the Read tool_use content_block_start
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart).toBeDefined();
    expect(readStart!.data.index).toBe(1); // Re-indexed from 2 → 1

    // Find the Read content_block_delta
    const readDeltas = parsed.filter(
      (e) => e.event === "content_block_delta" && e.data.index === 1,
    );
    expect(readDeltas.length).toBeGreaterThan(0);

    // Find the Read content_block_stop
    const readStop = parsed.find(
      (e) => e.event === "content_block_stop" && e.data.index === 1,
    );
    expect(readStop).toBeDefined();

    // No recall events should be forwarded
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);
  });

  test("recall before other tools — re-indexes correctly", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      // text at 0
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      // recall at 1 — suppressed
      toolUseBlockStart(1, "recall"),
      inputJsonDelta(1, '{"query":"x"}'),
      contentBlockStop(1),
      // Read at 2 → becomes 1
      toolUseBlockStart(2, "Read"),
      inputJsonDelta(2, '{}'),
      contentBlockStop(2),
      // Bash at 3 → becomes 2
      toolUseBlockStart(3, "Bash"),
      inputJsonDelta(3, '{}'),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // Read should be at index 1
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart!.data.index).toBe(1);

    // Bash should be at index 2
    const bashStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Bash",
    );
    expect(bashStart!.data.index).toBe(2);
  });

  test("recall after other tools — no re-indexing needed for earlier tools", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      // Read at 1 — forwarded as-is
      toolUseBlockStart(1, "Read"),
      inputJsonDelta(1, '{}'),
      contentBlockStop(1),
      // recall at 2 — suppressed
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // Read should still be at index 1 (unchanged)
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart!.data.index).toBe(1);

    // No recall events
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);
  });

  test("recall between two tools — re-indexes only the later one", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      contentBlockStop(0),
      // Read at 1 — forwarded as index 1
      toolUseBlockStart(1, "Read"),
      contentBlockStop(1),
      // recall at 2 — suppressed
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      // Bash at 3 — forwarded as index 2
      toolUseBlockStart(3, "Bash"),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart!.data.index).toBe(1);

    const bashStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Bash",
    );
    expect(bashStart!.data.index).toBe(2);

    expect(accum.clientBlockCount()).toBe(3); // text + Read + Bash
  });
});

// ---------------------------------------------------------------------------
// Tests: Edge cases
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — edge cases", () => {
  test("recall as the very first content block", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      toolUseBlockStart(0, "recall"),
      inputJsonDelta(0, '{"query":"x"}'),
      contentBlockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.recallBlockIndex()).toBe(0);
    expect(accum.clientBlockCount()).toBe(0);

    // Only message_start should be forwarded
    const parsed = parseForwardedEvents(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe("message_start");
  });

  test("thinking + text + recall — thinking and text forwarded", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      contentBlockStart(0, { type: "thinking", thinking: "" }),
      contentBlockDelta(0, { type: "thinking_delta", thinking: "Hmm..." }),
      contentBlockStop(0),
      textBlockStart(1),
      textDelta(1, "Let me search."),
      contentBlockStop(1),
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.clientBlockCount()).toBe(2); // thinking + text
    expect(accum.recallBlockIndex()).toBe(2);

    // Verify thinking and text events are present
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter(
      (e) => e.event === "content_block_start",
    );
    expect(blockStarts).toHaveLength(2);
    expect(
      (blockStarts[0].data.content_block as Record<string, unknown>).type,
    ).toBe("thinking");
    expect(
      (blockStarts[1].data.content_block as Record<string, unknown>).type,
    ).toBe("text");
  });

  test("ping events are forwarded", () => {
    const accum = createRecallAwareAccumulator();
    const pingEvent = { event: "ping", data: JSON.stringify({ type: "ping" }) };

    const output = accum.processEvent(pingEvent.event, pingEvent.data);
    expect(output).toContain("event: ping");
  });

  test("isDone reflects stream completion", () => {
    const accum = createRecallAwareAccumulator();
    expect(accum.isDone()).toBe(false);

    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ]);

    expect(accum.isDone()).toBe(true);
  });
});
