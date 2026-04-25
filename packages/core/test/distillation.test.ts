import { describe, test, expect } from "bun:test";
import {
  messagesToText,
  truncateToolOutputsInContent,
} from "../src/distillation";
import type * as temporal from "../src/temporal";

// Fixed timestamp so [hh:mm] prefixes are deterministic across runs.
const T = new Date("2026-04-24T09:15:00Z").getTime();

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
// Operates on the flattened-content shape produced by temporal.partsToText
// (see temporal.ts: chunks joined with "\n", tool outputs wrapped in
// "[tool:<name>] ..."). Per-envelope truncation preserves plain text and
// [reasoning] blocks untouched; only tool payloads above the cap are
// replaced with a compact annotation.

describe("truncateToolOutputsInContent", () => {
  test("passthrough: content with no tool envelopes is unchanged", () => {
    const plain = "User asked about auth.\n[reasoning] Thinking about flow";
    expect(truncateToolOutputsInContent(plain, 2_000)).toBe(plain);
  });

  test("passthrough: short tool output below cap is unchanged", () => {
    const content = "[tool:read] file contents are small";
    expect(truncateToolOutputsInContent(content, 2_000)).toBe(content);
  });

  test("truncates oversized single tool envelope", () => {
    const output = "x".repeat(5_000);
    const content = `[tool:grep] ${output}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    // Annotation replaces the payload wholesale.
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    expect(result).toContain("lines");
    expect(result.length).toBeLessThan(content.length);
    // Original payload must not survive.
    expect(result).not.toContain("xxxxxxxxxx"); // 10 x's would be in the body
  });

  test("preserves plain text BEFORE an oversized envelope", () => {
    const output = "y".repeat(5_000);
    const content = [
      "I need to search for that symbol.",
      `[tool:grep] ${output}`,
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("I need to search for that symbol.");
    expect(result).toContain("[output omitted — grep:");
  });

  test("known limitation (1a): plain text AFTER a tool chunk is attributed to the payload", () => {
    // partsToText joins chunks with "\n" and plain text has no structural
    // prefix, so a text chunk that follows a tool chunk is indistinguishable
    // from a continuation of the tool output. The truncator attributes the
    // trailing text to the tool payload. Acceptable trade-off — see
    // CHUNK_BOUNDARY_RE comment in src/distillation.ts.
    const output = "y".repeat(5_000);
    const content = [
      `[tool:grep] ${output}`,
      "Follow-up text attributed to grep output.",
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    // Annotation is emitted; trailing text is swallowed into the annotation.
    expect(result).toContain("[output omitted — grep:");
    expect(result).not.toContain("Follow-up text attributed");
  });

  test("known limitation (1b): short tool + long trailing text gets the text swallowed", () => {
    // Inverse of the above: a tool chunk with small output that's followed
    // by a big assistant text-reply. The combined chunk exceeds the cap,
    // so the trailing analysis disappears into the annotation. This is
    // the same CHUNK_BOUNDARY_RE limitation (direction: long text after
    // small tool) and is acceptable for background distill input — the
    // summary-level observations still capture the interaction shape.
    const longTrailingText = "This is a long analysis after the tool call. ".repeat(100);
    const content = [
      "[tool:grep] found 3 matches",
      longTrailingText,
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    // Truncation fires because the combined chunk > cap.
    expect(result).toContain("[output omitted — grep:");
    // The trailing analysis is gone.
    expect(result).not.toContain("long analysis after");
  });

  test("known limitation (2): embedded [tool:<name>] inside a payload fabricates a boundary", () => {
    // If a tool output legitimately contains the literal sequence
    // `\n[tool:<identifier>] ` (e.g. reading a file that documents this
    // serialization format), the truncator splits on it. The tightened
    // tool-name regex `[a-z][a-z0-9_-]*` reduces the surface (a literal
    // `[tool:Fake]` inside a body won't split because of the uppercase F),
    // but valid-identifier-shaped literals still fabricate a split. Pinning
    // the behavior so it's not silently rediscovered.
    const big = "x".repeat(3_000);
    const content = [
      `[tool:read] reading AGENTS.md`,
      `File contents include the literal envelope prefix below:`,
      `[tool:bash] this is a legitimate part of the read payload`,
      big,
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    // The embedded `[tool:bash]` prefix creates a fabricated second chunk.
    // The fabricated chunk contains the big payload and gets truncated as
    // if it were a real bash call — producing an annotation that references
    // "bash" even though no bash call occurred.
    expect(result).toContain("[output omitted — bash:");
    // The first read chunk body is short so it survives untruncated.
    expect(result).toContain("[tool:read] reading AGENTS.md");
  });

  test("tightened regex: uppercase tool name inside a payload does NOT split", () => {
    // Tool names with uppercase letters don't match the identifier regex,
    // so literal `[tool:Fake]` occurrences in payloads stay inline.
    const body = "first line\n[tool:Fake] mid-payload text with uppercase F\nmore data";
    const content = `[tool:grep] ${body}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    // Single chunk, under cap — passes through verbatim.
    expect(result).toBe(content);
  });

  test("perf: 100KB single-letter payload without '/' annotates in <500ms", () => {
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

  test("perf: 100KB payload WITH '/' still completes in <1s via scan limit", () => {
    // Even with a single '/' present (so the no-slash fast-exit doesn't
    // help), the 64KB scan cap on the path regex keeps runtime bounded.
    // The fragment before '/' is only 64KB of `x`, which the slicing
    // prevents from backtracking for too long.
    const pathological = "x".repeat(50_000) + "/file.ts " + "y".repeat(50_000);
    const content = `[tool:grep] ${pathological}`;
    const start = performance.now();
    const result = truncateToolOutputsInContent(content, 2_000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toContain("[output omitted — grep:");
  });

  test("separates a tool chunk from a following [reasoning] chunk", () => {
    // Unlike plain text, [reasoning] has a structural prefix so the
    // boundary regex correctly separates it from a preceding tool chunk.
    const output = "y".repeat(5_000);
    const content = [
      `[tool:grep] ${output}`,
      "[reasoning] Post-search reasoning",
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[output omitted — grep:");
    expect(result).toContain("[reasoning] Post-search reasoning");
  });

  test("truncates multiple oversized envelopes independently", () => {
    const big = "z".repeat(5_000);
    const content = [
      "[tool:grep] " + big,
      "[tool:read] " + big,
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    // Both envelopes replaced with separate annotations.
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    expect(result).toContain("[tool:read] [output omitted — read:");
    expect(result.length).toBeLessThan(content.length);
  });

  test("mixed sizes: only the oversized envelope is truncated", () => {
    const big = "q".repeat(5_000);
    const small = "small output lines";
    const content = [
      `[tool:grep] ${big}`,
      `[tool:ls] ${small}`,
    ].join("\n");
    const result = truncateToolOutputsInContent(content, 2_000);
    expect(result).toContain("[tool:grep] [output omitted — grep:");
    // The small envelope survives verbatim.
    expect(result).toContain(`[tool:ls] ${small}`);
  });

  test("line-start anchor: mid-line [tool:X] does not split the envelope", () => {
    // A tool-call JSON or prose that mentions `[tool:grep]` as literal
    // text *not at the start of a line* must not be mistaken for a new
    // envelope. The boundary regex requires a preceding `\n`, so
    // mid-line occurrences preceded by a space (as here) are preserved.
    // The adjacent "known limitation (2)" test covers the
    // newline-preceded-embedded-envelope path.
    const body = "some text [tool:grep] mid-line, no split\nmore data";
    const content = `[tool:read] ${body}`;
    const result = truncateToolOutputsInContent(content, 2_000);
    // Below threshold — full content passes through.
    expect(result).toBe(content);
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
    // Full user content present verbatim.
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
    const msgs = [
      msg("user", "Hello there"),
      msg("assistant", "Hi back"),
    ];
    const out = messagesToText(msgs, 2_000);
    // Time format is HH:MM; content of the stamp varies by local TZ, so pin
    // only the structural shape.
    expect(out).toMatch(/\[user\] \(\d\d:\d\d\) Hello there/);
    expect(out).toMatch(/\[assistant\] \(\d\d:\d\d\) Hi back/);
  });

  test("joins multiple messages with a blank line separator", () => {
    const msgs = [msg("user", "first"), msg("user", "second")];
    const out = messagesToText(msgs, 2_000);
    // Exactly one blank line between the two `[user] (...) ...` lines.
    const lines = out.split("\n\n");
    expect(lines).toHaveLength(2);
  });

  test("explicit toolOutputMaxChars override wins over config default", () => {
    const body = "c".repeat(1_000);
    const msgs = [msg("assistant", `[tool:grep] ${body}`)];
    // Cap of 100 forces truncation even though the body is only 1KB.
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

  test("handles mixed content: assistant text, reasoning, and tool output", () => {
    // Chunks before the tool envelope survive because the boundary regex
    // finds the [tool:grep] prefix. Trailing [reasoning] also survives
    // because it has a structural prefix. See CHUNK_BOUNDARY_RE docs in
    // src/distillation.ts for the plain-text-after-tool caveat.
    const big = "e".repeat(5_000);
    const content = [
      "I'll search for that.",
      "[reasoning] Planning the search",
      `[tool:grep] ${big}`,
      "[reasoning] Found what I needed.",
    ].join("\n");
    const msgs = [msg("assistant", content)];
    const out = messagesToText(msgs, 2_000);
    // Plain text and both reasoning chunks preserved.
    expect(out).toContain("I'll search for that.");
    expect(out).toContain("[reasoning] Planning the search");
    expect(out).toContain("[reasoning] Found what I needed.");
    // Tool body truncated.
    expect(out).toContain("[output omitted — grep:");
    expect(out).not.toContain("e".repeat(100));
  });
});
