/**
 * Tests for Anthropic prompt caching in buildAnthropicRequest.
 *
 * Validates three caching strategies:
 *  1. System prompt caching with 5m TTL (conversation turns)
 *  2. System prompt caching with 1h TTL (worker calls)
 *  3. Conversation message caching (breakpoint on last block)
 *  4. No caching for passthrough (title/summary requests)
 */
import { describe, test, expect } from "bun:test";
import {
  buildAnthropicRequest,
  type AnthropicCacheOptions,
} from "../src/translate/anthropic";
import type { GatewayRequest } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides: Partial<GatewayRequest> = {},
): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-sonnet-4-20250514",
    system: "You are a helpful assistant.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    tools: [],
    stream: true,
    maxTokens: 4096,
    metadata: {},
    rawHeaders: {
      "x-api-key": "test-key",
      "anthropic-beta": "extended-thinking-2025-04-30",
    },
    ...overrides,
  };
}

function getBody(req: GatewayRequest, cache?: AnthropicCacheOptions) {
  return buildAnthropicRequest(req, cache).body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// No caching (default / passthrough)
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — no caching", () => {
  test("system is a plain string when no cache options", () => {
    const body = getBody(makeRequest());
    expect(body.system).toBe("You are a helpful assistant.");
  });

  test("system is a plain string when cache is undefined", () => {
    const body = getBody(makeRequest(), undefined);
    expect(body.system).toBe("You are a helpful assistant.");
  });

  test("system is a plain string when systemTTL is false", () => {
    const body = getBody(makeRequest(), { systemTTL: false });
    expect(body.system).toBe("You are a helpful assistant.");
  });

  test("messages have no cache_control when cacheConversation is false", () => {
    const body = getBody(makeRequest(), { cacheConversation: false });
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    for (const msg of messages) {
      for (const block of msg.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });

  test("messages have no cache_control when no cache options", () => {
    const body = getBody(makeRequest());
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    for (const msg of messages) {
      for (const block of msg.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// System prompt caching — 5m TTL (conversation turns)
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — system prompt caching (5m)", () => {
  test("system becomes a block array with ephemeral cache_control", () => {
    const body = getBody(makeRequest(), { systemTTL: "5m" });
    expect(Array.isArray(body.system)).toBe(true);
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("You are a helpful assistant.");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("5m TTL does not include explicit ttl field (uses Anthropic default)", () => {
    const body = getBody(makeRequest(), { systemTTL: "5m" });
    const blocks = body.system as Array<Record<string, unknown>>;
    const cc = blocks[0].cache_control as Record<string, string>;
    expect(cc.ttl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// System prompt caching — 1h TTL (worker calls)
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — system prompt caching (1h)", () => {
  test("system becomes a block array with 3600s TTL", () => {
    const body = getBody(makeRequest(), { systemTTL: "1h" });
    expect(Array.isArray(body.system)).toBe(true);
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("You are a helpful assistant.");
    expect(blocks[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

// ---------------------------------------------------------------------------
// System prompt edge cases
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — system prompt edge cases", () => {
  test("empty system is not included even with caching enabled", () => {
    const body = getBody(makeRequest({ system: "" }), { systemTTL: "5m" });
    expect(body.system).toBeUndefined();
  });

  test("large system prompt is cached correctly", () => {
    const longSystem = "x".repeat(50_000);
    const body = getBody(makeRequest({ system: longSystem }), {
      systemTTL: "5m",
    });
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks[0].text).toBe(longSystem);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

// ---------------------------------------------------------------------------
// Conversation caching — breakpoint on last message block
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — conversation caching", () => {
  test("last block of last message gets cache_control", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "What is 2+2?" }],
        },
      ],
    });
    const body = getBody(req, { cacheConversation: true });
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    // Last message's last block should have cache_control
    const lastMsg = messages[messages.length - 1]!;
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });

    // Earlier messages should NOT have cache_control
    for (let i = 0; i < messages.length - 1; i++) {
      for (const block of messages[i].content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });

  test("works with multi-block last message (tool_use + text)", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "toolu_01",
              name: "bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_01",
              content: "file1.txt\nfile2.txt",
            },
            { type: "text", text: "What files are there?" },
          ],
        },
      ],
    });
    const body = getBody(req, { cacheConversation: true });
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;

    const lastMsg = messages[messages.length - 1]!;
    // Only the LAST block gets the breakpoint
    expect(lastMsg.content[0].cache_control).toBeUndefined();
    expect(lastMsg.content[lastMsg.content.length - 1]!.cache_control).toEqual(
      { type: "ephemeral" },
    );
  });

  test("no-op when messages array is empty", () => {
    const req = makeRequest({ messages: [] });
    const body = getBody(req, { cacheConversation: true });
    const messages = body.messages as Array<unknown>;
    expect(messages).toHaveLength(0);
  });

  test("no-op when last message has empty content", () => {
    const req = makeRequest({
      messages: [{ role: "user", content: [] }],
    });
    // Should not throw
    const body = getBody(req, { cacheConversation: true });
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0].content).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined: system + conversation caching (conversation turn config)
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — combined caching (conversation turn)", () => {
  test("system gets 5m cache and last message block gets breakpoint", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi!" }],
        },
        { role: "user", content: [{ type: "text", text: "More" }] },
      ],
    });
    const body = getBody(req, {
      systemTTL: "5m",
      cacheConversation: true,
    });

    // System prompt cached
    const system = body.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });

    // Last message block cached
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const lastMsg = messages[messages.length - 1]!;
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });
});

// ---------------------------------------------------------------------------
// Non-caching fields are unaffected
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — caching doesn't affect other fields", () => {
  test("model, max_tokens, stream, tools, metadata preserved", () => {
    const req = makeRequest({
      model: "claude-opus-4-20250514",
      maxTokens: 128000,
      stream: false,
      tools: [
        {
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
        },
      ],
      metadata: { temperature: 0.7, top_p: 0.9 },
    });
    const body = getBody(req, {
      systemTTL: "5m",
      cacheConversation: true,
    });

    expect(body.model).toBe("claude-opus-4-20250514");
    expect(body.max_tokens).toBe(128000);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  test("headers include api key and beta", () => {
    const { headers } = buildAnthropicRequest(makeRequest(), {
      systemTTL: "5m",
    });
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-beta"]).toBe(
      "extended-thinking-2025-04-30",
    );
  });
});

// ---------------------------------------------------------------------------
// LTM as separate system block
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — LTM system block", () => {
  test("LTM creates a second system block without cache_control", () => {
    const body = getBody(makeRequest(), {
      systemTTL: "1h",
      ltmSystem: "## Long-term Knowledge\n\n* entry one\n* entry two",
    });
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);

    // Block 0: host prompt with 1h cache
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("You are a helpful assistant.");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Block 1: LTM — no cache_control
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toBe("## Long-term Knowledge\n\n* entry one\n* entry two");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  test("no LTM block when ltmSystem is undefined", () => {
    const body = getBody(makeRequest(), { systemTTL: "1h" });
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("You are a helpful assistant.");
  });

  test("no LTM block when ltmSystem is empty string", () => {
    const body = getBody(makeRequest(), { systemTTL: "1h", ltmSystem: "" });
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
  });

  test("LTM with 5m TTL uses ephemeral without ttl field on host block", () => {
    const body = getBody(makeRequest(), {
      systemTTL: "5m",
      ltmSystem: "some knowledge",
    });
    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  test("LTM concatenated as string when no caching", () => {
    const body = getBody(makeRequest(), {
      systemTTL: false,
      ltmSystem: "some knowledge",
    });
    expect(typeof body.system).toBe("string");
    expect(body.system).toBe("You are a helpful assistant.\n\nsome knowledge");
  });

  test("no LTM concatenation when ltmSystem undefined and no caching", () => {
    const body = getBody(makeRequest(), { systemTTL: false });
    expect(body.system).toBe("You are a helpful assistant.");
  });
});

// ---------------------------------------------------------------------------
// Tool caching
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — tool caching", () => {
  const reqWithTools = () =>
    makeRequest({
      tools: [
        {
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
        },
        {
          name: "recall",
          description: "Search memory",
          inputSchema: { type: "object" },
        },
      ],
    });

  test("last tool gets 1h cache_control when cacheTools is true", () => {
    const body = getBody(reqWithTools(), { cacheTools: true });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);

    // First tool — no cache_control
    expect(tools[0].cache_control).toBeUndefined();

    // Last tool — 1h cache
    expect(tools[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("no cache_control on tools when cacheTools is false", () => {
    const body = getBody(reqWithTools(), { cacheTools: false });
    const tools = body.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(tool.cache_control).toBeUndefined();
    }
  });

  test("no cache_control on tools when cacheTools is undefined", () => {
    const body = getBody(reqWithTools(), {});
    const tools = body.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(tool.cache_control).toBeUndefined();
    }
  });

  test("single tool gets cache_control when cacheTools is true", () => {
    const req = makeRequest({
      tools: [
        {
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
        },
      ],
    });
    const body = getBody(req, { cacheTools: true });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("no tools array when request has no tools", () => {
    const body = getBody(makeRequest(), { cacheTools: true });
    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined: all cache layers (system 1h + LTM + tools 1h + conversation 5m)
// ---------------------------------------------------------------------------

describe("buildAnthropicRequest — full layered caching", () => {
  test("all breakpoints set correctly in production config", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
        { role: "user", content: [{ type: "text", text: "More" }] },
      ],
      tools: [
        {
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
        },
        {
          name: "recall",
          description: "Search memory",
          inputSchema: { type: "object" },
        },
      ],
    });
    const body = getBody(req, {
      systemTTL: "1h",
      ltmSystem: "## Knowledge\n\n* gotcha one",
      cacheTools: true,
      cacheConversation: true,
    });

    // System: 2 blocks — host (1h BP) + LTM (no BP)
    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].cache_control).toBeUndefined();

    // Tools: last tool gets 1h BP
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Messages: last block of last message gets 5m BP
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const lastMsg = messages[messages.length - 1]!;
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });
});
