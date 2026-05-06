/**
 * Replay integration tests for the Lore gateway.
 *
 * Runs against a locally-started gateway instance that is wired with a
 * synthetic fixture array — no real API calls are made.  Each test creates
 * its own isolated harness (separate DB, separate port, separate pipeline
 * state) so tests never interfere with each other.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  makeConversationFixtures,
  makeFixtureEntry,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";
import { parseMarker } from "../src/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal request body that passes isTitleOrSummaryRequest → false. */
function makeBody(
  userMessage: string,
  extraMessages: unknown[] = [],
): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [
      { role: "user", content: userMessage },
      ...extraMessages,
    ],
    tools: STANDARD_TOOLS,
  };
}

// ---------------------------------------------------------------------------
// Suite: "Basic pipeline"
// ---------------------------------------------------------------------------

describe("Basic pipeline", () => {
  // Each test manages its own harness so they don't share interceptor state.
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("first response contains no session marker in content", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "What is 2+2?", assistantText: "Four." },
      ]),
    });

    const resp = await harness.chat(makeBody("What is 2+2?"));
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThanOrEqual(1);

    // No block should contain a [lore:...] marker — session tracking is
    // fingerprint-based, not content-marker-based.
    for (const block of content) {
      if (block.type === "text") {
        expect(parseMarker(block.text as string)).toBeNull();
      }
    }
  });

  it("second turn reuses session via fingerprint — no marker needed", async () => {
    // 2 fixtures: one for each upstream call (first turn + second turn)
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "What is 2+2?", assistantText: "Four." },
        { userMessage: "What is 3+3?", assistantText: "Six." },
      ]),
    });

    // First turn
    const resp1 = await harness.chat(makeBody("What is 2+2?"));
    expect(resp1.status).toBe(200);

    // Second turn — same first user message means same fingerprint → same session
    const resp2 = await harness.chat(
      makeBody("What is 3+3?", [
        {
          role: "assistant",
          content: [{ type: "text", text: "Four." }],
        },
        { role: "user", content: "What is 3+3?" },
      ]),
    );
    expect(resp2.status).toBe(200);

    const body2 = (await resp2.json()) as Record<string, unknown>;
    const content2 = body2.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content2)).toBe(true);
    expect(content2.length).toBeGreaterThanOrEqual(1);

    // No marker should be present in any response
    for (const block of content2) {
      if (block.type === "text") {
        expect(parseMarker(block.text as string)).toBeNull();
      }
    }
  });

  it("response includes stop_reason and content", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "What is 2+2?", assistantText: "Four." },
      ]),
    });

    const resp = await harness.chat(makeBody("What is 2+2?"));
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;

    expect(typeof body.stop_reason).toBe("string");
    expect(body.stop_reason).toBe("end_turn");
    expect(Array.isArray(body.content)).toBe(true);
    expect((body.content as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: "Session identification"
// ---------------------------------------------------------------------------

describe("Session identification", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("multi-turn conversation with same first message reuses session", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        {
          userMessage: "Follow-up question.",
          assistantText: "Got it.",
        },
      ]),
    });

    // Build a multi-turn request — fingerprint is based on the first user message
    const resp = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream: false,
      system: DEFAULT_SYSTEM,
      messages: [
        { role: "user", content: "First question" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Previous response." }],
        },
        { role: "user", content: "Follow-up question." },
      ],
      tools: STANDARD_TOOLS,
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);

    // No markers should appear in the response
    for (const block of content) {
      if (block.type === "text") {
        expect(parseMarker(block.text as string)).toBeNull();
      }
    }
  });

  it("different first messages produce successful independent responses", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Completely different first message", assistantText: "Sure." },
      ]),
    });

    const resp = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream: false,
      system: DEFAULT_SYSTEM,
      messages: [
        { role: "user", content: "Completely different first message" },
      ],
      tools: STANDARD_TOOLS,
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThanOrEqual(1);

    // Response should contain the assistant text without any markers
    for (const block of content) {
      if (block.type === "text") {
        expect(parseMarker(block.text as string)).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: "Temporal storage"
// ---------------------------------------------------------------------------

describe("Temporal storage", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("user message is stored in temporal DB after a turn", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Store this message please.", assistantText: "Stored!" },
      ]),
    });

    const resp = await harness.chat(makeBody("Store this message please."));
    expect(resp.status).toBe(200);

    // Wait briefly for synchronous post-response storage to complete
    await new Promise((r) => setTimeout(r, 200));

    const rows = harness.queryDB<{ n: number }>(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE role='user'",
    );
    // At least one user message should be stored
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("assistant message is stored in temporal DB after a turn", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Store this message please.", assistantText: "Stored!" },
      ]),
    });

    const resp = await harness.chat(makeBody("Store this message please."));
    expect(resp.status).toBe(200);

    // Wait briefly for synchronous post-response storage to complete
    await new Promise((r) => setTimeout(r, 200));

    const rows = harness.queryDB<{ n: number }>(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE role='assistant'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: "Title/summary passthrough"
// ---------------------------------------------------------------------------

describe("Title/summary passthrough", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("short system + no tools is forwarded without marker injection", async () => {
    // Passthrough requests still hit the interceptor — one fixture needed
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [
            { role: "user", content: "Title: User asks about math" },
          ],
          system: "Generate a short title.",
          responseText: "Math Question",
          model: DEFAULT_MODEL,
        }),
      ],
    });

    // Title/summary request shape: short system (<500 chars), ≤2 tools, ≤2 messages
    const resp = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 50,
      stream: false,
      system: "Generate a short title.",
      messages: [
        { role: "user", content: "Title: User asks about math" },
      ],
      // No tools — signals title/summary agent
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThanOrEqual(1);

    // No marker should be present in any block
    for (const block of content) {
      if (block.type === "text") {
        const marker = parseMarker(block.text as string);
        expect(marker).toBeNull();
      }
    }

    // But there should be some response text
    const textBlocks = content.filter((b) => b.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: "Compaction interception"
// ---------------------------------------------------------------------------

describe("Compaction interception", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("compaction request is intercepted locally — no upstream call", async () => {
    // EMPTY fixtures — compaction is handled locally, never forwarded upstream.
    // If the gateway somehow calls the interceptor, it throws "Replay exhausted"
    // which will cause the test to fail with a clear error.
    harness = await createHarness({ fixtures: [] });

    // Build a request that matches isCompactionRequest() via the system prompt pattern
    const resp = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      stream: false,
      system:
        "You are an anchored context summarization assistant for coding sessions. " +
        "Your job is to produce a structured summary of the conversation history.",
      messages: [
        {
          role: "user",
          content:
            "Please create an anchored summary from the conversation history above.",
        },
      ],
      // No tools — compaction agents typically have no tools
    });

    // The gateway must return a 200 (synthetic summary, never erroring out)
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;

    // Response must have content (the synthesized summary text)
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThanOrEqual(1);

    // There must be at least one text block
    const textBlock = content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(typeof (textBlock as Record<string, unknown>).text).toBe("string");

    // The response should have the standard Anthropic shape
    expect(typeof body.id).toBe("string");
    expect(typeof body.stop_reason).toBe("string");
  });
});
