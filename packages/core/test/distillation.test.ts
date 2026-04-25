import { describe, test, expect, beforeEach } from "bun:test";
import {
  messagesToText,
  truncateToolOutputsInContent,
  loadForSession,
  latestMetaObservations,
  metaDistill,
} from "../src/distillation";
import * as temporal from "../src/temporal";
import { CHUNK_TERMINATOR, partsToText } from "../src/temporal";
import { db, ensureProject } from "../src/db";
import type { LorePart, LLMClient } from "../src/types";

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

// ─── F2: meta-distill anchored update + loadForSession archived filter ──

const META_PROJECT = "/test/meta-distill/project";
const META_SESSION = "sess-meta-distill";

function insertGen0(input: {
  projectId: string;
  sessionID: string;
  observations: string;
  archived?: 0 | 1;
  createdAt?: number;
}): string {
  const id = crypto.randomUUID();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.sessionID,
      "",
      "[]",
      input.observations,
      "[]",
      0,
      Math.ceil(input.observations.length / 3),
      input.archived ?? 0,
      input.createdAt ?? Date.now(),
    );
  return id;
}

function insertMeta(input: {
  projectId: string;
  sessionID: string;
  observations: string;
  generation: number;
  archived?: 0 | 1;
  createdAt?: number;
}): string {
  const id = crypto.randomUUID();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.sessionID,
      "",
      "[]",
      input.observations,
      "[]",
      input.generation,
      Math.ceil(input.observations.length / 3),
      input.archived ?? 0,
      input.createdAt ?? Date.now(),
    );
  return id;
}

/** Build a minimal LLMClient stub that returns a canned response. */
function makeStubLLM(response: string | null): LLMClient & {
  prompts: Array<{ system: string; user: string }>;
} {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    prompt: async (system: string, user: string) => {
      prompts.push({ system, user });
      return response ?? "";
    },
  };
}

describe("latestMetaObservations", () => {
  beforeEach(() => {
    const pid = ensureProject(META_PROJECT);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("returns undefined when no distillations exist", () => {
    expect(latestMetaObservations(META_PROJECT, META_SESSION)).toBeUndefined();
  });

  test("returns undefined when only gen-0 rows exist (no meta yet)", () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "raw seg" });
    expect(latestMetaObservations(META_PROJECT, META_SESSION)).toBeUndefined();
  });

  test("returns gen-1 observations when one meta exists", () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "raw seg" });
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "consolidated meta",
      generation: 1,
    });
    expect(latestMetaObservations(META_PROJECT, META_SESSION)).toBe(
      "consolidated meta",
    );
  });

  test("prefers higher generation over more recent created_at", () => {
    const pid = ensureProject(META_PROJECT);
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "gen-1 newer",
      generation: 1,
      createdAt: Date.now(),
    });
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "gen-2 older but higher",
      generation: 2,
      createdAt: Date.now() - 10_000,
    });
    expect(latestMetaObservations(META_PROJECT, META_SESSION)).toBe(
      "gen-2 older but higher",
    );
  });

  test("scopes to the session — other sessions don't leak", () => {
    const pid = ensureProject(META_PROJECT);
    insertMeta({
      projectId: pid,
      sessionID: "other-session",
      observations: "other meta",
      generation: 1,
    });
    expect(latestMetaObservations(META_PROJECT, META_SESSION)).toBeUndefined();
  });
});

describe("loadForSession — archived filter", () => {
  beforeEach(() => {
    const pid = ensureProject(META_PROJECT);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("excludes archived rows by default", () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "live row", archived: 0 });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "merged row", archived: 1 });
    const rows = loadForSession(META_PROJECT, META_SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observations).toBe("live row");
  });

  test("includes archived rows when includeArchived: true", () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "live row", archived: 0 });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "merged row", archived: 1 });
    const rows = loadForSession(META_PROJECT, META_SESSION, true);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.observations).sort()).toEqual([
      "live row",
      "merged row",
    ]);
  });

  test("returns empty array when no rows exist (default and includeArchived true)", () => {
    expect(loadForSession(META_PROJECT, META_SESSION)).toHaveLength(0);
    expect(loadForSession(META_PROJECT, META_SESSION, true)).toHaveLength(0);
  });
});

describe("metaDistill — first round (no anchor)", () => {
  beforeEach(() => {
    const pid = ensureProject(META_PROJECT);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("consolidates 3+ gen-0 rows; user prompt has no <previous-meta-summary>", async () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs A" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs B" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs C" });

    const llm = makeStubLLM("<observations>\nFresh meta from 3 segments\n</observations>");
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).not.toBeNull();
    expect(result!.observations).toBe("Fresh meta from 3 segments");

    // No anchor on first run.
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]!.user).not.toContain("<previous-meta-summary>");
    // All 3 gen-0 segments appear in the prompt.
    expect(llm.prompts[0]!.user).toContain("Segment 1:");
    expect(llm.prompts[0]!.user).toContain("Segment 2:");
    expect(llm.prompts[0]!.user).toContain("Segment 3:");
    expect(llm.prompts[0]!.user).toContain("obs A");
    expect(llm.prompts[0]!.user).toContain("obs C");
  });

  test("returns null when fewer than 3 gen-0 rows exist (no anchor)", async () => {
    const pid = ensureProject(META_PROJECT);
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "only one" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "and two" });

    const llm = makeStubLLM("should not be called");
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).toBeNull();
    expect(llm.prompts).toHaveLength(0);
  });

  test("archives exactly the merged subset; gen>0 row at gen=1 created", async () => {
    const pid = ensureProject(META_PROJECT);
    const id1 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs A" });
    const id2 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs B" });
    const id3 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "obs C" });

    const llm = makeStubLLM("<observations>\nmerged\n</observations>");
    await metaDistill({ llm, projectPath: META_PROJECT, sessionID: META_SESSION });

    const archivedRows = db()
      .query(
        "SELECT id, archived, generation FROM distillations WHERE project_id = ? AND session_id = ?",
      )
      .all(pid, META_SESSION) as Array<{
      id: string;
      archived: number;
      generation: number;
    }>;
    const byId = Object.fromEntries(archivedRows.map((r) => [r.id, r]));
    expect(byId[id1]!.archived).toBe(1);
    expect(byId[id2]!.archived).toBe(1);
    expect(byId[id3]!.archived).toBe(1);
    // New gen-1 row exists.
    const meta = archivedRows.find((r) => r.generation === 1);
    expect(meta).toBeDefined();
    expect(meta!.archived).toBe(0);
  });

  test("does NOT archive rows for unrelated sessions / projects", async () => {
    const pid = ensureProject(META_PROJECT);
    const otherSessionRow = insertGen0({
      projectId: pid,
      sessionID: "unrelated-session",
      observations: "other-session row",
    });
    const otherProjectPid = ensureProject("/test/meta-distill/other");
    const otherProjectRow = insertGen0({
      projectId: otherProjectPid,
      sessionID: META_SESSION,
      observations: "other-project row",
    });

    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "A" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "B" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "C" });

    const llm = makeStubLLM("<observations>\ngood\n</observations>");
    await metaDistill({ llm, projectPath: META_PROJECT, sessionID: META_SESSION });

    const otherSessionArchived = (
      db()
        .query("SELECT archived FROM distillations WHERE id = ?")
        .get(otherSessionRow) as { archived: number }
    ).archived;
    expect(otherSessionArchived).toBe(0);

    const otherProjectArchived = (
      db()
        .query("SELECT archived FROM distillations WHERE id = ?")
        .get(otherProjectRow) as { archived: number }
    ).archived;
    expect(otherProjectArchived).toBe(0);
  });

  test("returns null and archives nothing when LLM returns empty/null", async () => {
    const pid = ensureProject(META_PROJECT);
    const id1 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "A" });
    const id2 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "B" });
    const id3 = insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "C" });

    const llm = makeStubLLM(null);
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).toBeNull();
    // Nothing archived; gen-0 rows survive for retry.
    const rows = db()
      .query("SELECT id, archived FROM distillations WHERE project_id = ? AND session_id = ?")
      .all(pid, META_SESSION) as Array<{ id: string; archived: number }>;
    expect(rows.find((r) => r.id === id1)!.archived).toBe(0);
    expect(rows.find((r) => r.id === id2)!.archived).toBe(0);
    expect(rows.find((r) => r.id === id3)!.archived).toBe(0);
    // No new gen>0 row.
    const metaRows = db()
      .query(
        "SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id = ? AND generation > 0",
      )
      .get(pid, META_SESSION) as { c: number };
    expect(metaRows.c).toBe(0);
  });

});

describe("metaDistill — anchored second round", () => {
  beforeEach(() => {
    const pid = ensureProject(META_PROJECT);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("anchors on prior gen-1 meta when one exists; only new gen-0 in segments", async () => {
    const pid = ensureProject(META_PROJECT);
    // Prior gen-1 meta from a previous round.
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "PRIOR_META_BODY",
      generation: 1,
    });
    // Two new gen-0 rows since the prior meta.
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "new obs X" });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "new obs Y" });

    const llm = makeStubLLM(
      "<observations>\nUpdated meta with X and Y\n</observations>",
    );
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).not.toBeNull();
    expect(llm.prompts).toHaveLength(1);
    // Anchor block in the user prompt.
    expect(llm.prompts[0]!.user).toContain("<previous-meta-summary>");
    expect(llm.prompts[0]!.user).toContain("PRIOR_META_BODY");
    expect(llm.prompts[0]!.user).toContain("</previous-meta-summary>");
    // Only the new gen-0 rows appear as segments (1 and 2, not 3).
    expect(llm.prompts[0]!.user).toContain("Segment 1:");
    expect(llm.prompts[0]!.user).toContain("Segment 2:");
    expect(llm.prompts[0]!.user).not.toContain("Segment 3:");
    expect(llm.prompts[0]!.user).toContain("new obs X");
    expect(llm.prompts[0]!.user).toContain("new obs Y");
  });

  test("returns null without LLM call when anchor exists but no new gen-0 rows", async () => {
    const pid = ensureProject(META_PROJECT);
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "PRIOR_META",
      generation: 1,
    });
    // No new gen-0 rows.

    const llm = makeStubLLM("should not be called");
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).toBeNull();
    expect(llm.prompts).toHaveLength(0);
  });

  test("anchored round only requires 1 new gen-0 (relaxed from first-round threshold of 3)", async () => {
    const pid = ensureProject(META_PROJECT);
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "PRIOR_META",
      generation: 1,
    });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "single new obs" });

    const llm = makeStubLLM("<observations>\nUpdated\n</observations>");
    const result = await metaDistill({
      llm,
      projectPath: META_PROJECT,
      sessionID: META_SESSION,
    });

    expect(result).not.toBeNull();
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]!.user).toContain("<previous-meta-summary>");
  });

  test("new gen-1+ row stored at maxGen+1 (gen-2 in this case)", async () => {
    const pid = ensureProject(META_PROJECT);
    insertMeta({
      projectId: pid,
      sessionID: META_SESSION,
      observations: "PRIOR_META",
      generation: 1,
    });
    insertGen0({ projectId: pid, sessionID: META_SESSION, observations: "new" });

    const llm = makeStubLLM("<observations>\nupdated\n</observations>");
    await metaDistill({ llm, projectPath: META_PROJECT, sessionID: META_SESSION });

    const metaRows = db()
      .query(
        "SELECT generation, observations FROM distillations WHERE project_id = ? AND session_id = ? AND generation > 0 ORDER BY generation ASC",
      )
      .all(pid, META_SESSION) as Array<{ generation: number; observations: string }>;
    expect(metaRows.map((r) => r.generation)).toEqual([1, 2]);
    expect(metaRows[1]!.observations).toBe("updated");
  });
});
