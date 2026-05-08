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
import {
  findRecallToolUse,
  replaceRecallWithMarker,
  expandRecallMarkers,
  recallStoreKey,
  buildRecallMarker,
} from "../src/recall";
import type { GatewayRequest, GatewayToolUseBlock, RecallStore } from "../src/translate/types";

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

// ---------------------------------------------------------------------------
// Integration: Case 2 end-to-end flow
//
// Simulates the full pipeline path for mixed tools:
//   1. Stream arrives with text + recall + Read tool_use
//   2. Accumulator suppresses recall, re-indexes Read
//   3. Pipeline extracts recall block from accumulated response
//   4. Pipeline strips recall from response for post-processing
//   5. Pipeline stores pending recall result
//   6. Next request injects pending recall into conversation history
// ---------------------------------------------------------------------------

describe("Case 2 integration — mixed tools end-to-end", () => {
  test("full flow: suppress → extract → store → inject on next request", () => {
    // --- Step 1: Stream with text + recall + Read ---
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me search memory and read the file."),
      contentBlockStop(0),
      // recall at index 1 — will be suppressed
      toolUseBlockStart(1, "recall", "toolu_recall_1"),
      inputJsonDelta(1, '{"query":"gateway architecture"}'),
      contentBlockStop(1),
      // Read at index 2 — will be re-indexed to 1 for client
      toolUseBlockStart(2, "Read", "toolu_read_1"),
      inputJsonDelta(2, '{"path":"/src/index.ts"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    // --- Step 2: Verify accumulator state ---
    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.clientBlockCount()).toBe(2); // text + Read (re-indexed)
    expect(accum.recallBlockIndex()).toBe(1);

    // Client sees text at 0 and Read at 1 (no recall)
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect(
      (blockStarts[0].data.content_block as Record<string, unknown>).type,
    ).toBe("text");
    expect(
      (blockStarts[1].data.content_block as Record<string, unknown>).name,
    ).toBe("Read");
    expect(blockStarts[1].data.index).toBe(1); // Re-indexed from 2

    // No recall events leaked
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);

    // Held-back events contain message_delta + message_stop
    const heldBack = accum.heldBackEvents();
    expect(heldBack).toContain("message_delta");
    expect(heldBack).toContain("message_stop");

    // --- Step 3: Extract recall block from accumulated response ---
    const resp = accum.getResponse();
    const recallBlock = findRecallToolUse(resp);
    expect(recallBlock).toBeDefined();
    expect(recallBlock!.id).toBe("toolu_recall_1");
    expect(recallBlock!.name).toBe("recall");

    // --- Step 4: Replace recall with marker in response for post-processing ---
    const markerResp = replaceRecallWithMarker(resp);
    expect(markerResp.content).toHaveLength(3); // text + marker text + Read
    expect(markerResp.content[1].type).toBe("text");
    expect((markerResp.content[1] as { text: string }).text).toBe(
      buildRecallMarker("gateway architecture", "all"),
    );
    // No recall tool_use blocks remain
    expect(markerResp.content.every((b) => {
      if (b.type === "tool_use") return (b as GatewayToolUseBlock).name !== "recall";
      return true;
    })).toBe(true);

    // --- Step 5: Store recall result in recallStore ---
    const store: RecallStore = new Map();
    const storeKey = recallStoreKey("gateway architecture", "all");
    store.set(storeKey, {
      toolUseId: recallBlock!.id,
      input: { query: "gateway architecture" },
      position: accum.recallBlockIndex(),
      result: "Found: gateway uses Anthropic protocol, recall interception is transparent",
    });

    // --- Step 6: Expand markers in next request ---
    // Simulate the next request: client sends tool_result for Read,
    // and the assistant message contains the marker text (not raw tool_use)
    const nextReq: GatewayRequest = {
      model: "claude-sonnet-4-20250514",
      protocol: "anthropic",
      system: "You are helpful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Search memory and read file" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search memory and read the file." },
            { type: "text", text: buildRecallMarker("gateway architecture", "all") },
            // Client only saw Read at index 1 (recall was suppressed, marker emitted)
            { type: "tool_use", id: "toolu_read_1", name: "Read", input: { path: "/src/index.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "toolu_read_1", content: "// index.ts content" },
          ],
        },
      ],
      tools: [
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "recall", description: "Search memory", inputSchema: {} },
      ],
      stream: true,
      maxTokens: 4096,
      metadata: {},
      rawHeaders: {},
    };

    const expanded = expandRecallMarkers(nextReq, store);
    expect(expanded).toBe(true);

    // Assistant message should now have recall tool_use replacing the marker
    const assistantMsg = nextReq.messages[1];
    expect(assistantMsg.content).toHaveLength(3); // text + recall + Read
    expect(assistantMsg.content[0].type).toBe("text");
    expect(assistantMsg.content[1].type).toBe("tool_use");
    expect((assistantMsg.content[1] as GatewayToolUseBlock).name).toBe("recall");
    expect((assistantMsg.content[1] as GatewayToolUseBlock).id).toBe("toolu_recall_1");
    expect(assistantMsg.content[2].type).toBe("tool_use");
    expect((assistantMsg.content[2] as GatewayToolUseBlock).name).toBe("Read");

    // User message should have recall tool_result inserted before Read tool_result
    const userMsg = nextReq.messages[2];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].type).toBe("tool_result");
    expect((userMsg.content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_1");
    expect(userMsg.content[1].type).toBe("tool_result");
    expect((userMsg.content[1] as { toolUseId: string }).toolUseId).toBe("toolu_read_1");
  });

  test("pending recall with multiple other tools — correct injection order", () => {
    // Stream: text + recall + Read + Bash
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "I'll search, read, and run."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall_2"),
      inputJsonDelta(1, '{"query":"patterns"}'),
      contentBlockStop(1),
      toolUseBlockStart(2, "Read", "toolu_read_2"),
      inputJsonDelta(2, '{}'),
      contentBlockStop(2),
      toolUseBlockStart(3, "Bash", "toolu_bash_1"),
      inputJsonDelta(3, '{"command":"ls"}'),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.clientBlockCount()).toBe(3); // text + Read + Bash

    // Client sees: text(0), Read(1), Bash(2)
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(3);
    expect(blockStarts[1].data.index).toBe(1); // Read re-indexed from 2
    expect(blockStarts[2].data.index).toBe(2); // Bash re-indexed from 3

    // Extract recall and store result
    const resp = accum.getResponse();
    const recallBlock = findRecallToolUse(resp);
    expect(recallBlock).toBeDefined();

    const store: RecallStore = new Map();
    const storeKey = recallStoreKey("patterns", "all");
    store.set(storeKey, {
      toolUseId: recallBlock!.id,
      input: { query: "patterns" },
      position: accum.recallBlockIndex(),
      result: "Found patterns info",
    });

    // Next request: client provides tool_results for Read and Bash,
    // assistant message has marker text instead of recall tool_use
    const nextReq: GatewayRequest = {
      model: "claude-sonnet-4-20250514",
      protocol: "anthropic",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "do stuff" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll search, read, and run." },
            { type: "text", text: buildRecallMarker("patterns", "all") },
            { type: "tool_use", id: "toolu_read_2", name: "Read", input: {} },
            { type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "toolu_read_2", content: "file" },
            { type: "tool_result", toolUseId: "toolu_bash_1", content: "dir listing" },
          ],
        },
      ],
      tools: [
        { name: "Read", description: "", inputSchema: {} },
        { name: "Bash", description: "", inputSchema: {} },
        { name: "recall", description: "", inputSchema: {} },
      ],
      stream: true,
      maxTokens: 4096,
      metadata: {},
      rawHeaders: {},
    };

    const expanded = expandRecallMarkers(nextReq, store);
    expect(expanded).toBe(true);

    // Assistant: text + recall(replacing marker) + Read + Bash
    const assistantMsg = nextReq.messages[1];
    expect(assistantMsg.content).toHaveLength(4);
    expect((assistantMsg.content[1] as GatewayToolUseBlock).name).toBe("recall");
    expect((assistantMsg.content[2] as GatewayToolUseBlock).name).toBe("Read");
    expect((assistantMsg.content[3] as GatewayToolUseBlock).name).toBe("Bash");

    // User: recall_result + Read_result + Bash_result
    const userMsg = nextReq.messages[2];
    expect(userMsg.content).toHaveLength(3);
    expect((userMsg.content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_2");
    expect((userMsg.content[1] as { toolUseId: string }).toolUseId).toBe("toolu_read_2");
    expect((userMsg.content[2] as { toolUseId: string }).toolUseId).toBe("toolu_bash_1");
  });
});
