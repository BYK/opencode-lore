import { describe, test, expect } from "bun:test";
import {
  isCompactionRequest,
  extractPreviousSummary,
  isTitleOrSummaryRequest,
  buildCompactionResponse,
  COMPACTION_SYSTEM_PATTERNS,
  COMPACTION_USER_PATTERNS,
  COMPACTION_TEMPLATE_SECTIONS,
} from "../src/compaction";
import type { GatewayRequest, GatewayResponse } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid GatewayRequest with sensible defaults. */
function makeRequest(
  overrides: Partial<GatewayRequest> & {
    system?: string;
    messages?: GatewayRequest["messages"];
  } = {},
): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-sonnet-4-20250514",
    system: "",
    messages: [],
    tools: [],
    stream: false,
    maxTokens: 4096,
    metadata: {},
    rawHeaders: {},
    ...overrides,
  };
}

/** Build a user message with a single text block. */
function userMsg(text: string): GatewayRequest["messages"][0] {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Build an assistant message with a single text block. */
function assistantMsg(text: string): GatewayRequest["messages"][0] {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// isCompactionRequest
// ---------------------------------------------------------------------------

describe("isCompactionRequest", () => {
  test("detects compaction from system prompt pattern", () => {
    const req = makeRequest({
      system:
        "You are an anchored context summarization assistant for coding sessions.",
      messages: [userMsg("Summarize"), assistantMsg("Done")],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("system prompt detection is case-insensitive", () => {
    const req = makeRequest({
      system:
        "You are an ANCHORED CONTEXT SUMMARIZATION ASSISTANT for coding.",
      messages: [userMsg("Summarize")],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("detects compaction from user message pattern — anchored summary", () => {
    const req = makeRequest({
      system: "You are a helpful assistant.",
      tools: [], // empty tools required for user-pattern path
      messages: [
        userMsg(
          "Please create an anchored summary from the conversation history above.",
        ),
      ],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("detects compaction from user message pattern — Update the anchored summary", () => {
    const req = makeRequest({
      system: "Generic system prompt",
      tools: [],
      messages: [
        userMsg("Update the anchored summary below based on recent changes."),
      ],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("detects compaction from user message pattern — previous-summary tag", () => {
    const req = makeRequest({
      system: "Generic system prompt",
      tools: [],
      messages: [
        userMsg(
          "Here is the context:\n<previous-summary>\nold summary\n</previous-summary>",
        ),
      ],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("user message patterns require empty tools array", () => {
    const req = makeRequest({
      system: "Generic system prompt",
      tools: [
        { name: "bash", description: "Run shell", inputSchema: {} },
      ],
      messages: [
        userMsg(
          "Please create an anchored summary from the conversation history above.",
        ),
      ],
    });
    // Should NOT match — tools present blocks user-pattern path
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("detects compaction from template sections", () => {
    // Need <template> tag + ≥4 section headers
    const templateContent = [
      "<template>",
      "## Goal",
      "Build a web application",
      "## Progress",
      "### Done",
      "- Setup project",
      "## Key Decisions",
      "- Using React",
      "## Next Steps",
      "- Implement auth",
      "## Critical Context",
      "User prefers TypeScript",
      "## Relevant Files",
      "- src/index.ts",
      "</template>",
    ].join("\n");

    const req = makeRequest({
      system: "Generic system prompt",
      // template path works even with tools present
      tools: [
        { name: "bash", description: "Run shell", inputSchema: {} },
      ],
      messages: [userMsg(templateContent)],
    });
    expect(isCompactionRequest(req)).toBe(true);
  });

  test("template sections require <template> tag", () => {
    // All sections present but no <template> tag
    const content = [
      "## Goal",
      "## Progress",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
      "## Relevant Files",
    ].join("\n");

    const req = makeRequest({
      system: "Generic system prompt",
      messages: [userMsg(content)],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("template sections need ≥4 matches", () => {
    // <template> tag but only 3 sections — below threshold
    const content = [
      "<template>",
      "## Goal",
      "## Progress",
      "## Key Decisions",
      "</template>",
    ].join("\n");

    const req = makeRequest({
      system: "Generic system prompt",
      messages: [userMsg(content)],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("returns false for normal conversation requests", () => {
    const req = makeRequest({
      system: "You are a helpful assistant.",
      tools: [
        { name: "bash", description: "Run shell commands", inputSchema: {} },
        {
          name: "read",
          description: "Read files",
          inputSchema: {},
        },
      ],
      messages: [
        userMsg("Help me write a function to sort an array"),
        assistantMsg("Sure, here is a sort function..."),
        userMsg("Can you optimize it?"),
      ],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("returns false for title/summary requests", () => {
    const req = makeRequest({
      system: "Generate a title.",
      tools: [],
      messages: [userMsg("Sort array function")],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("handles empty messages array", () => {
    const req = makeRequest({
      system: "You are a helpful assistant.",
      messages: [],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });

  test("handles no tools with innocuous user message", () => {
    const req = makeRequest({
      system: "You are a helpful assistant.",
      tools: [],
      messages: [userMsg("What is 2 + 2?")],
    });
    expect(isCompactionRequest(req)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractPreviousSummary
// ---------------------------------------------------------------------------

describe("extractPreviousSummary", () => {
  test("extracts content between previous-summary tags", () => {
    const req = makeRequest({
      messages: [
        userMsg(
          "Context:\n<previous-summary>\nThis is the old summary.\n</previous-summary>\nNow update it.",
        ),
      ],
    });
    expect(extractPreviousSummary(req)).toBe("This is the old summary.");
  });

  test("returns undefined when no tags present", () => {
    const req = makeRequest({
      messages: [userMsg("Just a normal message without any tags.")],
    });
    expect(extractPreviousSummary(req)).toBeUndefined();
  });

  test("returns undefined for empty messages", () => {
    const req = makeRequest({ messages: [] });
    expect(extractPreviousSummary(req)).toBeUndefined();
  });

  test("handles multi-line summary content", () => {
    const multiLine = [
      "## Goal",
      "Build a web app",
      "",
      "## Progress",
      "- Setup done",
      "- Auth implemented",
    ].join("\n");

    const req = makeRequest({
      messages: [
        userMsg(
          `<previous-summary>\n${multiLine}\n</previous-summary>`,
        ),
      ],
    });
    expect(extractPreviousSummary(req)).toBe(multiLine);
  });

  test("extracts from last user message, not earlier ones", () => {
    const req = makeRequest({
      messages: [
        userMsg(
          "<previous-summary>\nOld from first user msg\n</previous-summary>",
        ),
        assistantMsg("Some response"),
        userMsg(
          "<previous-summary>\nLatest summary\n</previous-summary>",
        ),
      ],
    });
    expect(extractPreviousSummary(req)).toBe("Latest summary");
  });
});

// ---------------------------------------------------------------------------
// isTitleOrSummaryRequest
// ---------------------------------------------------------------------------

describe("isTitleOrSummaryRequest", () => {
  test("detects short system prompt + single message as title request", () => {
    const req = makeRequest({
      system: "Generate a short title for the conversation.",
      tools: [],
      messages: [userMsg("Help me sort an array in JavaScript")],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(true);
  });

  test("detects with 2 messages and 1 tool (within limits)", () => {
    const req = makeRequest({
      system: "Summarize this conversation.",
      tools: [{ name: "output", description: "Output", inputSchema: {} }],
      messages: [
        userMsg("First"),
        assistantMsg("Second"),
      ],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(true);
  });

  test("returns false for normal conversation with many tools", () => {
    const req = makeRequest({
      system: "You are a helpful coding assistant.",
      tools: [
        { name: "bash", description: "Run shell", inputSchema: {} },
        { name: "read", description: "Read files", inputSchema: {} },
        { name: "write", description: "Write files", inputSchema: {} },
      ],
      messages: [userMsg("Help me with a bug")],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(false);
  });

  test("returns false for many messages", () => {
    const req = makeRequest({
      system: "Short prompt.",
      tools: [],
      messages: [
        userMsg("Turn 1"),
        assistantMsg("Response 1"),
        userMsg("Turn 2"),
      ],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(false);
  });

  test("returns false for long system prompt", () => {
    const req = makeRequest({
      system: "A".repeat(500), // exactly at limit — must be < 500
      tools: [],
      messages: [userMsg("Hello")],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(false);
  });

  test("returns false for compaction requests (handled separately)", () => {
    const req = makeRequest({
      system:
        "You are an anchored context summarization assistant for coding sessions.",
      tools: [],
      messages: [userMsg("Summarize the conversation")],
    });
    // Compaction-detected → isCompactionRequest returns true → isTitleOrSummaryRequest returns false
    expect(isTitleOrSummaryRequest(req)).toBe(false);
  });

  test("system prompt just under limit passes", () => {
    const req = makeRequest({
      system: "A".repeat(499),
      tools: [],
      messages: [userMsg("Hello")],
    });
    expect(isTitleOrSummaryRequest(req)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCompactionResponse
// ---------------------------------------------------------------------------

describe("buildCompactionResponse", () => {
  test("returns valid GatewayResponse shape", () => {
    const response = buildCompactionResponse(
      "session123",
      "## Goal\nBuild an app",
      "claude-sonnet-4-20250514",
    );

    // Verify it has all required GatewayResponse fields
    expect(response.id).toBeTypeOf("string");
    expect(response.id.length).toBeGreaterThan(0);
    expect(response.model).toBe("claude-sonnet-4-20250514");
    expect(response.content).toBeArray();
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as { type: "text"; text: string }).text).toBe(
      "## Goal\nBuild an app",
    );
    expect(response.stopReason).toBeTypeOf("string");
    expect(response.usage).toBeDefined();
    expect(response.usage.inputTokens).toBeTypeOf("number");
    expect(response.usage.outputTokens).toBeTypeOf("number");
  });

  test("has correct stop reason", () => {
    const response = buildCompactionResponse("s1", "summary", "model-1");
    expect(response.stopReason).toBe("end_turn");
  });

  test("has reasonable token estimate", () => {
    const summary = "A".repeat(400); // 400 chars → ~100 tokens at 4 chars/token
    const response = buildCompactionResponse("s1", summary, "model-1");
    expect(response.usage.outputTokens).toBe(100);
    expect(response.usage.inputTokens).toBe(0);
  });

  test("token estimate rounds up", () => {
    const summary = "ABC"; // 3 chars → ceil(3/4) = 1 token
    const response = buildCompactionResponse("s1", summary, "model-1");
    expect(response.usage.outputTokens).toBe(1);
  });

  test("response ID starts with msg_lore_compact_", () => {
    const response = buildCompactionResponse("s1", "text", "model-1");
    expect(response.id).toStartWith("msg_lore_compact_");
  });

  test("response ID is unique across calls", () => {
    const r1 = buildCompactionResponse("s1", "text", "model-1");
    const r2 = buildCompactionResponse("s1", "text", "model-1");
    expect(r1.id).not.toBe(r2.id);
  });

  test("passes through model name unchanged", () => {
    const response = buildCompactionResponse(
      "s1",
      "text",
      "gpt-4o-2024-05-13",
    );
    expect(response.model).toBe("gpt-4o-2024-05-13");
  });
});
