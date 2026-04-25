import { describe, test, expect } from "bun:test";
import {
  messagesToText,
  truncateToolOutputsInContent,
} from "../src/distillation";
import * as temporal from "../src/temporal";
import { CHUNK_TERMINATOR, partsToText } from "../src/temporal";
import type { LorePart } from "../src/types";

// Fixed timestamp so [hh:mm] prefixes are deterministic across runs.
const T = new Date("2026-04-24T09:15:00Z").getTime();

// Join chunks the way temporal.partsToText does (post-F3b): "\n\x1f"
// between chunks. Tests use this to construct realistic content
// fixtures without needing a full producer round trip every time.
function seal(...chunks: string[]): string {
  return chunks.join("\n" + CHUNK_TERMINATOR);
}

function msg(
  role: "user" | "assistant" | "tool",
  content: string,
  overrides: Partial<temporal.TemporalMessage> = {},
): temporal.TemporalMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    project_id: "proj",
    session_id: "sess",
    role,
    content,
    tokens: Math.ceil(content.length / 3),
    distilled: 0,
    created_at: T,
    metadata: "{}",
    ...overrides,
  };
}

// ─── truncateToolOutputsInContent ─────────────────────────────────────
//
// Operates on the post-F3b chunk format produced by temporal.partsToText:
// chunks separated by "\n\x1f" so the structural parser is unambiguous
// regardless of payload contents. Single-chunk content (no \x1f) takes
// a fast path that truncates the whole content as one chunk if it's an
// oversized tool envelope. Multi-chunk content splits on the separator
// and truncates each tool envelope independently.

describe("truncateToolOutputsInContent — single-chunk fast path", () => {
  test("plain text passes through unchanged", () => {
    const plain = "Just a user message about auth.";
    expect(truncateToolOutputsInContent(plain, 2_000)).toBe(plain);
  });

  test("short tool envelope below cap is unchanged", () => {
    const content = "[tool:read] file contents are small";
    expect(truncateToolOutputsInContent(content, 2_000)).toBe(content);
  });

  test("oversized single tool envelope is truncated", () => {
    const output = "x".repeat(5_000);
    const content = `[tool:grep] ${output}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    expect(result).toContain("lines");
    expect(result.length).toBeLessThan(content.length);
    expect(result).not.toContain("xxxxxxxxxx");
  });

  test("malformed envelope (no `] ` close) is left alone", () => {
    const content = "[tool:grep no close bracket text continues forever";
    expect(truncateToolOutputsInContent(content, 2_000)).toBe(content);
  });

  test("maxChars <= 0 disables truncation", () => {
    const big = "a".repeat(10_000);
    const content = `[tool:grep] ${big}`;
    expect(truncateToolOutputsInContent(content, 0)).toBe(content);
    expect(truncateToolOutputsInContent(content, -1)).toBe(content);
  });

  test("empty content is returned unchanged", () => {
    expect(truncateToolOutputsInContent("", 2_000)).toBe("");
  });

  test("annotation includes error signal when payload mentions errors", () => {
    const output = "x".repeat(3_000) + "\nError: connection refused\n" + "y".repeat(3_000);
    const content = `[tool:grep] ${output}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("contained errors");
  });

  test("annotation includes file paths when payload contains them", () => {
    const output =
      "matched: src/foo.ts\nmatched: src/bar.ts\n" + "z".repeat(3_000);
    const content = `[tool:grep] ${output}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("paths:");
    expect(result).toContain("src/foo.ts");
  });
});

describe("truncateToolOutputsInContent — multi-chunk path", () => {
  test("plain text BEFORE an oversized envelope is preserved", () => {
    const output = "y".repeat(5_000);
    const content = seal("I need to search for that symbol.", `[tool:grep] ${output}`);
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("I need to search for that symbol.");
    expect(result).toContain("[output omitted — grep:");
  });

  test("plain text AFTER a tool chunk is preserved (former F3 known limitation 1a)", () => {
    // Pre-F3b this test asserted the trailing text was SWALLOWED into the
    // tool annotation. The new \x1f separator makes the boundary
    // unambiguous, so the trailing text now survives untouched.
    const output = "y".repeat(5_000);
    const content = seal(`[tool:grep] ${output}`, "Follow-up text after the tool call.");
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[output omitted — grep:");
    expect(result).toContain("Follow-up text after the tool call.");
  });

  test("short tool + long trailing text preserves both (former F3 known limitation 1b)", () => {
    // Pre-F3b: short tool envelope + long trailing text resulted in the
    // trailing text being swallowed into the annotation when the combined
    // chunk exceeded the cap. With \x1f separators, the trailing text is
    // its own chunk and is preserved verbatim regardless of size.
    const longTrailingText = "Long analysis after the tool call. ".repeat(100);
    const content = seal("[tool:grep] found 3 matches", longTrailingText);
    const result = truncateToolOutputsInContent(content, 2_000);
    // The short tool chunk survives; trailing text survives in full.
    expect(result).toContain("[tool:grep] found 3 matches");
    expect(result).toContain("Long analysis after the tool call.");
    // No annotation emitted because no chunk exceeded the cap.
    expect(result).not.toContain("[output omitted —");
  });

  test("embedded literal [tool:<id>] inside a payload does NOT fabricate a split (former F3 known limitation 2)", () => {
    // Pre-F3b: a tool output that legitimately contained `\n[tool:bash] ...`
    // (e.g. reading AGENTS.md or this project's source) was split on the
    // literal occurrence, producing a fabricated [tool:bash] envelope the
    // distill LLM would treat as a real tool call. With \x1f separators,
    // the literal text inside a payload has no terminator after it, so no
    // fabrication occurs.
    const big = "x".repeat(3_000);
    const toolPayload = [
      "reading AGENTS.md",
      "File contents include the literal envelope prefix below:",
      "[tool:bash] this is a legitimate part of the read payload",
      big,
    ].join("\n");
    const content = `[tool:read] ${toolPayload}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    // The whole envelope is truncated as `read` (no fabricated `bash` annotation).
    expect(result).toContain("[output omitted — read:");
    expect(result).not.toContain("[output omitted — bash:");
  });

  test("multiple oversized envelopes are truncated independently", () => {
    const big = "z".repeat(5_000);
    const content = seal(`[tool:grep] ${big}`, `[tool:read] ${big}`);
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    expect(result).toContain("[tool:read] [output omitted — read:");
    expect(result.length).toBeLessThan(content.length);
  });

  test("only the oversized envelope is truncated; small siblings survive", () => {
    const big = "q".repeat(5_000);
    const small = "small output lines";
    const content = seal(`[tool:grep] ${big}`, `[tool:ls] ${small}`);
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    expect(result).toContain(`[tool:ls] ${small}`);
  });

  test("[reasoning] chunks pass through untouched", () => {
    const big = "y".repeat(5_000);
    const content = seal(`[tool:grep] ${big}`, "[reasoning] Post-search reasoning");
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[output omitted — grep:");
    expect(result).toContain("[reasoning] Post-search reasoning");
  });

  test("text-only multi-chunk content (no tool envelopes) returns input unchanged", () => {
    const content = seal("First text chunk.", "[reasoning] Some reasoning.");
    expect(truncateToolOutputsInContent(content, 2_000)).toBe(content);
  });

  test("uppercase tool name inside a payload (e.g. JSON dump) is preserved verbatim", () => {
    // Tool payloads containing arbitrary content — including text that
    // looks like an envelope — are preserved as-is by the new format
    // because only \x1f boundaries are structural.
    const body = "first line\n[tool:Fake] mid-payload text\nmore data";
    const content = `[tool:read] ${body}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toBe(content);
  });
});

describe("truncateToolOutputsInContent — perf regression guards", () => {
  test("100KB single-letter payload without '/' annotates in <500ms", () => {
    // Regression guard against catastrophic backtracking in the
    // path-extraction regex inside toolStripAnnotation. Pathological
    // inputs (minified JS, base64 blobs, binary dumps) used to stall
    // the background worker for ~30s on this repro. The no-slash
    // fast-exit in gradient.ts makes this O(n).
    const pathological = "x".repeat(100_000);
    const content = `[tool:grep] ${pathological}`;
    const start = performance.now();
    const result = truncateToolOutputsInContent(content, 2_000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toContain("[output omitted — grep:");
  });

  test("100KB payload WITH '/' completes in <1s via scan limit", () => {
    const pathological = "x".repeat(50_000) + "/file.ts " + "y".repeat(50_000);
    const content = `[tool:grep] ${pathological}`;
    const start = performance.now();
    const result = truncateToolOutputsInContent(content, 2_000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toContain("[output omitted — grep:");
  });
});

// ─── messagesToText ────────────────────────────────────────────────────
//
// Wraps truncateToolOutputsInContent with role-aware routing. User messages
// are never truncated (user text is always signal); assistant and tool
// messages have oversized outputs trimmed.

describe("messagesToText", () => {
  test("preserves user messages regardless of size", () => {
    const huge = "u".repeat(10_000);
    const msgs = [msg("user", huge)];
    const out = messagesToText(msgs, 2_000);
    expect(out).toContain(huge);
    expect(out).not.toContain("[output omitted —");
  });

  test("truncates oversized tool output on assistant messages", () => {
    const big = "a".repeat(5_000);
    const msgs = [msg("assistant", `[tool:grep] ${big}`)];
    const out = messagesToText(msgs, 2_000);
    expect(out).toContain("[output omitted — grep:");
    expect(out).not.toContain("a".repeat(100));
  });

  test("truncates oversized tool output on tool-role messages", () => {
    const big = "b".repeat(5_000);
    const msgs = [msg("tool", `[tool:read] ${big}`)];
    const out = messagesToText(msgs, 2_000);
    expect(out).toContain("[output omitted — read:");
  });

  test("short assistant content passes through untouched", () => {
    const content = "[tool:ls] small output";
    const msgs = [msg("assistant", content)];
    const out = messagesToText(msgs, 2_000);
    expect(out).toContain(content);
    expect(out).not.toContain("[output omitted —");
  });

  test("prefixes each message with [role] and a time stamp", () => {
    const msgs = [msg("user", "Hello there"), msg("assistant", "Hi back")];
    const out = messagesToText(msgs, 2_000);
    expect(out).toMatch(/\[user\] \(\d\d:\d\d\) Hello there/);
    expect(out).toMatch(/\[assistant\] \(\d\d:\d\d\) Hi back/);
  });

  test("joins multiple messages with a blank line separator", () => {
    const msgs = [msg("user", "first"), msg("user", "second")];
    const out = messagesToText(msgs, 2_000);
    const lines = out.split("\n\n");
    expect(lines).toHaveLength(2);
  });

  test("explicit toolOutputMaxChars override wins over config default", () => {
    const body = "c".repeat(1_000);
    const msgs = [msg("assistant", `[tool:grep] ${body}`)];
    const out = messagesToText(msgs, 100);
    expect(out).toContain("[output omitted — grep:");
  });

  test("cap of 0 disables truncation (large tool outputs survive verbatim)", () => {
    const body = "d".repeat(10_000);
    const msgs = [msg("assistant", `[tool:grep] ${body}`)];
    const out = messagesToText(msgs, 0);
    expect(out).toContain(body);
    expect(out).not.toContain("[output omitted —");
  });

  test("handles mixed content: assistant text, reasoning, tool, more text", () => {
    // Multi-chunk content with all four chunk types in order. The new
    // format preserves trailing plain text after a tool chunk (former
    // F3 known limitation 1a, now a positive assertion).
    const big = "e".repeat(5_000);
    const content = seal(
      "I'll search for that.",
      "[reasoning] Planning the search",
      `[tool:grep] ${big}`,
      "Found what I needed.",
    );
    const msgs = [msg("assistant", content)];
    const out = messagesToText(msgs, 2_000);
    expect(out).toContain("I'll search for that.");
    expect(out).toContain("[reasoning] Planning the search");
    expect(out).toContain("[output omitted — grep:");
    // Trailing plain text survives.
    expect(out).toContain("Found what I needed.");
    expect(out).not.toContain("e".repeat(100));
  });
});

// ─── Round-trip via partsToText ────────────────────────────────────────
//
// Pin the producer/consumer contract end-to-end: a LorePart[] containing
// arbitrary content (including payloads that look like envelopes) flows
// through partsToText → truncateToolOutputsInContent without fabrication
// or trailing-text loss. This is the F3b correctness guarantee.

function textPart(text: string): LorePart {
  return { type: "text", text } as LorePart;
}
function reasoningPart(text: string): LorePart {
  return { type: "reasoning", text } as LorePart;
}
function toolPart(tool: string, output: string): LorePart {
  return {
    type: "tool",
    tool,
    state: { status: "completed", output },
  } as unknown as LorePart;
}

describe("partsToText + truncateToolOutputsInContent round trip", () => {
  test("produces \\n\\x1f boundaries between chunks", () => {
    const content = partsToText([
      textPart("first"),
      reasoningPart("thinking"),
      toolPart("grep", "results"),
      textPart("last"),
    ]);
    // Expect exactly 3 separators for 4 chunks.
    const separatorCount =
      content.split("\n" + CHUNK_TERMINATOR).length - 1;
    expect(separatorCount).toBe(3);
  });

  test("\\x1f appears ONLY at structural boundaries, not inside payloads", () => {
    const adversarialOutput = [
      "reading AGENTS.md",
      "[tool:bash] this is INSIDE a tool payload, not a real envelope",
      "still inside the read output",
    ].join("\n");
    const content = partsToText([
      textPart("Searching for X"),
      toolPart("read", adversarialOutput),
      textPart("Found it."),
    ]);
    // Three chunks → two separators.
    const separators = content.split("\n" + CHUNK_TERMINATOR);
    expect(separators).toHaveLength(3);
    // The middle chunk owns the entire adversarial payload — no \x1f leaks
    // into it because partsToText only injects \x1f between chunks.
    expect(separators[1]).toContain("[tool:read] reading AGENTS.md");
    expect(separators[1]).toContain("[tool:bash] this is INSIDE");
    expect(separators[1]).toContain("still inside the read output");
    // Trailing text is its own chunk.
    expect(separators[2]).toBe("Found it.");
  });

  test("truncating an adversarial round-trip preserves trailing text and rejects fabrication", () => {
    const big = "x".repeat(3_000);
    const adversarialOutput = [
      "Reading repo source.",
      "[tool:bash] embedded literal that could fabricate pre-F3b",
      big,
    ].join("\n");
    const content = partsToText([
      textPart("Looking up the format spec."),
      toolPart("read", adversarialOutput),
      textPart("Now I understand the chunk format."),
    ]);
    const result = truncateToolOutputsInContent(content, 2_000);
    // Tool envelope is truncated as `read` (no fabricated `bash` envelope).
    expect(result).toContain("[output omitted — read:");
    expect(result).not.toContain("[output omitted — bash:");
    // Both surrounding text chunks survive.
    expect(result).toContain("Looking up the format spec.");
    expect(result).toContain("Now I understand the chunk format.");
  });
});
