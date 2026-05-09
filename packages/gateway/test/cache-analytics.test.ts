import { describe, test, expect } from "bun:test";
import {
  compressBody,
  decompressBody,
  findDivergenceOffset,
  mapOffsetToJsonPath,
  inferDivergenceReason,
  analyzeCacheTurn,
} from "../src/cache-analytics";
import type { CacheAnalytics, GatewayUsage } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCacheAnalytics(): CacheAnalytics {
  return {
    lastRequestBody: null,
    lastRequestBodyLength: 0,
    lastCacheRead: 0,
    lastCacheCreation: 0,
    turnCount: 0,
    bustCount: 0,
  };
}

function makeUsage(overrides: Partial<GatewayUsage> = {}): GatewayUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 900,
    cacheCreationInputTokens: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Compression round-trip
// ---------------------------------------------------------------------------

describe("compression", () => {
  test("round-trips a JSON body through zstd", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "hello world" }],
    });
    const compressed = compressBody(body);
    // Small bodies may not compress (zstd frame overhead) — just verify round-trip
    expect(decompressBody(compressed)).toBe(body);
  });

  test("round-trips large repetitive JSON", () => {
    const body = JSON.stringify({
      messages: Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} with some content`,
      })),
    });
    const compressed = compressBody(body);
    expect(compressed.length).toBeLessThan(body.length / 2);
    expect(decompressBody(compressed)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// findDivergenceOffset
// ---------------------------------------------------------------------------

describe("findDivergenceOffset", () => {
  test("identical strings → returns length", () => {
    expect(findDivergenceOffset("abc", "abc")).toBe(3);
  });

  test("different at start", () => {
    expect(findDivergenceOffset("abc", "xyz")).toBe(0);
  });

  test("different in middle", () => {
    expect(findDivergenceOffset("abcdef", "abcXYZ")).toBe(3);
  });

  test("one is prefix of the other", () => {
    expect(findDivergenceOffset("abc", "abcdef")).toBe(3);
    expect(findDivergenceOffset("abcdef", "abc")).toBe(3);
  });

  test("empty strings", () => {
    expect(findDivergenceOffset("", "")).toBe(0);
    expect(findDivergenceOffset("abc", "")).toBe(0);
    expect(findDivergenceOffset("", "abc")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapOffsetToJsonPath
// ---------------------------------------------------------------------------

describe("mapOffsetToJsonPath", () => {
  test("offset 0 → <start>", () => {
    expect(mapOffsetToJsonPath('{"a":1}', 0)).toBe("<start>");
  });

  test("offset past end → <end>", () => {
    expect(mapOffsetToJsonPath('{"a":1}', 100)).toBe("<end>");
  });

  test("top-level key", () => {
    const json = '{"model":"opus","system":"hello"}';
    // Find offset where "system" value starts
    const offset = json.indexOf('"hello"');
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system");
  });

  test("nested messages array — later element", () => {
    const json = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "CHANGED" },
      ],
    });
    const offset = json.indexOf("CHANGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toMatch(/messages\[2\]/);
  });

  test("nested messages array — first element (index 0)", () => {
    const json = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "CHANGED" },
        { role: "assistant", content: "second" },
      ],
    });
    const offset = json.indexOf("CHANGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("messages[0].content");
  });

  test("system block array (Anthropic cache format)", () => {
    const json = JSON.stringify({
      model: "opus",
      system: [{ type: "text", text: "CHANGED_HERE", cache_control: { type: "ephemeral" } }],
      messages: [],
    });
    const offset = json.indexOf("CHANGED_HERE");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system[0].text");
  });

  test("content block array within message", () => {
    const json = JSON.stringify({
      messages: [
        { role: "user", content: [
          { type: "text", text: "first block" },
          { type: "text", text: "DIVERGED" },
        ]},
      ],
    });
    const offset = json.indexOf("DIVERGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("messages[0].content[1].text");
  });

  test("system prompt change", () => {
    const json = JSON.stringify({
      model: "opus",
      system: "You are a helpful assistant",
      messages: [],
    });
    const offset = json.indexOf("helpful");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system");
  });

  test("tools array", () => {
    const json = JSON.stringify({
      model: "opus",
      tools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "DIFFERENT" },
      ],
      messages: [],
    });
    const offset = json.indexOf("DIFFERENT");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toMatch(/tools\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// inferDivergenceReason
// ---------------------------------------------------------------------------

describe("inferDivergenceReason", () => {
  test("system prompt — bare", () => {
    expect(inferDivergenceReason("system", 100, 100)).toBe(
      "system prompt changed",
    );
  });

  test("system prompt — host block", () => {
    expect(inferDivergenceReason("system[0].text", 100, 100)).toBe(
      "host system prompt changed",
    );
  });

  test("system prompt — LTM block", () => {
    expect(inferDivergenceReason("system[1].text", 100, 100)).toBe(
      "LTM knowledge block updated (background curation/consolidation)",
    );
  });

  test("model change", () => {
    expect(inferDivergenceReason("model", 100, 100)).toBe("model changed");
  });

  test("tools change", () => {
    expect(inferDivergenceReason("tools[1].name", 100, 100)).toBe(
      "tool definitions changed",
    );
  });

  test("message content change — no message count", () => {
    expect(
      inferDivergenceReason("messages[3].content[1]", 100, 100),
    ).toBe("message at position 3 content changed");
  });

  test("message content change — new message at end", () => {
    expect(
      inferDivergenceReason("messages[9].content[0]", 100, 120, 10),
    ).toBe("new conversation message (normal turn progression)");
  });

  test("message content change — earlier message modified", () => {
    expect(
      inferDivergenceReason("messages[3].content[1]", 100, 100, 10),
    ).toBe("earlier message modified at position 3 (window shift or content change)");
  });

  test("message content change — distilled prefix rewrite", () => {
    expect(
      inferDivergenceReason("messages[0].content[0]", 100, 100, 10),
    ).toBe("distilled conversation prefix changed (meta-distillation rewrite)");
  });

  test("appended content", () => {
    expect(inferDivergenceReason("<end>", 100, 200)).toBe(
      "new message appended (normal conversation growth)",
    );
  });

  test("truncated content", () => {
    expect(inferDivergenceReason("<end>", 200, 100)).toBe(
      "context window compressed (gradient eviction)",
    );
  });
});

// ---------------------------------------------------------------------------
// analyzeCacheTurn — integration
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn", () => {
  test("first turn — no comparison, stores body", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });

    const result = analyzeCacheTurn(analytics, body, makeUsage());

    expect(result.turn).toBe(1);
    expect(result.divergencePoint).toBe("<first-turn>");
    expect(result.cacheHitRate).toBeCloseTo(0.9);
    expect(analytics.lastRequestBody).not.toBeNull();
    expect(analytics.lastRequestBodyLength).toBe(body.length);
    expect(analytics.turnCount).toBe(1);
    expect(analytics.bustCount).toBe(0);
  });

  test("identical request bodies → 100% prefix match", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body, makeUsage());
    const result = analyzeCacheTurn(analytics, body, makeUsage());

    expect(result.turn).toBe(2);
    expect(result.prefixMatchPercent).toBe(1);
    expect(result.divergencePoint).toBe("<identical>");
    expect(result.divergenceReason).toBe("request bodies are identical");
  });

  test("new message appended → divergence at end", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "how are you" },
      ],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.turn).toBe(2);
    // body1 is a prefix of body2 (minus the closing brackets)
    expect(result.prefixMatchPercent).toBeGreaterThan(0.5);
  });

  test("system prompt changed → divergence at system", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      system: "You are helpful",
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      model: "opus",
      system: "You are DIFFERENT",
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toBe("system");
    expect(result.divergenceReason).toBe("system prompt changed");
    expect(result.prefixMatchPercent).toBeLessThan(0.5);
  });

  test("confirmed bust when cache_read=0 and cache_creation>0", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    // First turn — never a bust
    analyzeCacheTurn(analytics, body, makeUsage());
    expect(analytics.bustCount).toBe(0);

    // Second turn with cache miss
    analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 500,
        inputTokens: 100,
      }),
    );
    expect(analytics.bustCount).toBe(1);
  });

  test("no bust when cache_read > 0", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    analyzeCacheTurn(analytics, body, makeUsage());
    analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        inputTokens: 50,
      }),
    );
    expect(analytics.bustCount).toBe(0);
  });

  test("cache hit rate computation", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    const result = analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
        inputTokens: 100,
      }),
    );

    // 800 / (800 + 100 + 100) = 0.8
    expect(result.cacheHitRate).toBeCloseTo(0.8);
  });

  test("compressed body is smaller than original", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} with repeated content to compress well`,
      })),
    });

    analyzeCacheTurn(analytics, body, makeUsage());

    expect(analytics.lastRequestBody!.length).toBeLessThan(body.length);
    expect(analytics.lastRequestBodyLength).toBe(body.length);
  });

  test("message content change — divergence in messages", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "original response" },
        { role: "user", content: "follow up" },
      ],
    });
    const body2 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "MODIFIED response" },
        { role: "user", content: "follow up" },
      ],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toMatch(/messages\[1\]/);
    expect(result.divergenceReason).toMatch(/message at position 1 content changed/);
  });
});
