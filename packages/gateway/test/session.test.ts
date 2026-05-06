import { describe, test, expect } from "bun:test";
import {
  base62Encode,
  generateSessionID,
  formatMarker,
  parseMarker,
  scanForMarker,
  fingerprintMessages,
} from "../src/session";

// ---------------------------------------------------------------------------
// base62Encode
// ---------------------------------------------------------------------------

describe("base62Encode", () => {
  test("encodes known byte sequences correctly", () => {
    // Single byte 1 → "1"
    expect(base62Encode(new Uint8Array([1]))).toBe("1");
    // 62 in decimal → should produce "10" in base62 (1*62 + 0)
    expect(base62Encode(new Uint8Array([62]))).toBe("10");
    // 255 → 4*62 + 7 = "47"
    expect(base62Encode(new Uint8Array([255]))).toBe("47");
  });

  test("handles all-zeros bytes", () => {
    expect(base62Encode(new Uint8Array([0]))).toBe("0");
    expect(base62Encode(new Uint8Array([0, 0, 0]))).toBe("0");
    expect(base62Encode(new Uint8Array([0, 0, 0, 0]))).toBe("0");
  });

  test("all-zeros with minLength pads to requested width", () => {
    expect(base62Encode(new Uint8Array([0, 0]), 5)).toBe("00000");
    expect(base62Encode(new Uint8Array([0]), 3)).toBe("000");
  });

  test("produces consistent-length output with minLength", () => {
    const result = base62Encode(new Uint8Array([1]), 10);
    expect(result.length).toBe(10);
    // Should be left-padded with '0's
    expect(result).toBe("0000000001");
  });

  test("minLength does not truncate longer results", () => {
    // 12 bytes of 0xFF → large number, more than 5 base62 digits
    const big = new Uint8Array(12).fill(0xff);
    const result = base62Encode(big, 5);
    expect(result.length).toBeGreaterThanOrEqual(5);
  });

  test("output only contains alphanumeric characters", () => {
    // Test with various byte patterns
    const patterns = [
      new Uint8Array([0]),
      new Uint8Array([255]),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      new Uint8Array(12).fill(0xab),
    ];
    for (const bytes of patterns) {
      const result = base62Encode(bytes);
      expect(result).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  test("empty Uint8Array returns single zero", () => {
    expect(base62Encode(new Uint8Array([]))).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// generateSessionID
// ---------------------------------------------------------------------------

describe("generateSessionID", () => {
  test("returns a non-empty string", () => {
    const id = generateSessionID();
    expect(id.length).toBeGreaterThan(0);
  });

  test("contains only alphanumeric characters", () => {
    const id = generateSessionID();
    expect(id).toMatch(/^[0-9A-Za-z]+$/);
  });

  test("two calls produce different IDs (random component)", () => {
    const id1 = generateSessionID();
    const id2 = generateSessionID();
    expect(id1).not.toBe(id2);
  });

  test("has consistent minimum length (17 chars)", () => {
    // The constant SESSION_ID_MIN_LENGTH = 17
    for (let i = 0; i < 10; i++) {
      expect(generateSessionID().length).toBeGreaterThanOrEqual(17);
    }
  });
});

// ---------------------------------------------------------------------------
// formatMarker / parseMarker
// ---------------------------------------------------------------------------

describe("formatMarker / parseMarker", () => {
  test("round-trips correctly", () => {
    const id = "abc123XYZ";
    expect(parseMarker(formatMarker(id))).toBe(id);
  });

  test("round-trips with a real generated ID", () => {
    const id = generateSessionID();
    expect(parseMarker(formatMarker(id))).toBe(id);
  });

  test("formatMarker produces expected format", () => {
    expect(formatMarker("test")).toBe("[lore:test]");
  });

  test("parseMarker returns null for non-marker text", () => {
    expect(parseMarker("hello world")).toBeNull();
    expect(parseMarker("")).toBeNull();
    expect(parseMarker("[other:abc]")).toBeNull();
    expect(parseMarker("[lore:]")).toBeNull(); // empty id, no alphanumeric match
  });

  test("parseMarker handles markers embedded in longer text", () => {
    const id = "abc123";
    expect(parseMarker(`Some text before [lore:${id}] and after`)).toBe(id);
    expect(parseMarker(`\n\n[lore:${id}]\n\n`)).toBe(id);
  });

  test("parseMarker extracts first match only", () => {
    expect(parseMarker("[lore:first] [lore:second]")).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// scanForMarker
// ---------------------------------------------------------------------------

describe("scanForMarker", () => {
  test("finds marker in Anthropic-style messages (content is array of blocks)", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there! [lore:abc123]" }],
      },
    ];
    expect(scanForMarker(messages)).toBe("abc123");
  });

  test("finds marker in OpenAI-style messages (content is string)", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there! [lore:xyz789]" },
    ];
    expect(scanForMarker(messages)).toBe("xyz789");
  });

  test("returns null when no marker present", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    expect(scanForMarker(messages)).toBeNull();
  });

  test("returns null for empty messages array", () => {
    expect(scanForMarker([])).toBeNull();
  });

  test("finds marker in first message that contains one (scanning order)", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "[lore:fromUser]" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "[lore:fromAssistant]" }],
      },
    ];
    // scanForMarker iterates all messages in order — finds user's first
    expect(scanForMarker(messages)).toBe("fromUser");
  });

  test("handles mixed content (some messages with markers, some without)", () => {
    const messages = [
      { role: "user", content: "No marker here" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Some reasoning" },
          { type: "text", text: "And [lore:found] in second block" },
        ],
      },
      { role: "user", content: "Follow-up" },
    ];
    expect(scanForMarker(messages)).toBe("found");
  });

  test("skips non-text blocks in Anthropic-style content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: {} },
          { type: "text", text: "[lore:afterTool]" },
        ],
      },
    ];
    expect(scanForMarker(messages)).toBe("afterTool");
  });

  test("handles content that is neither string nor array", () => {
    const messages = [
      { role: "user", content: null },
      { role: "assistant", content: 42 },
    ];
    expect(scanForMarker(messages)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fingerprintMessages
// ---------------------------------------------------------------------------

describe("fingerprintMessages", () => {
  test("produces consistent hash for same messages (deterministic)", async () => {
    const messages = [
      { role: "user", content: "Hello, help me with code" },
      { role: "assistant", content: "Sure!" },
    ];
    const hash1 = await fingerprintMessages(messages);
    const hash2 = await fingerprintMessages(messages);
    expect(hash1).toBe(hash2);
  });

  test("produces different hash for different first user messages", async () => {
    const messages1 = [{ role: "user", content: "Hello" }];
    const messages2 = [{ role: "user", content: "Goodbye" }];
    const hash1 = await fingerprintMessages(messages1);
    const hash2 = await fingerprintMessages(messages2);
    expect(hash1).not.toBe(hash2);
  });

  test("returns 16 hex chars", async () => {
    const messages = [{ role: "user", content: "Test message" }];
    const hash = await fingerprintMessages(messages);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles OpenAI-style string content", async () => {
    const messages = [
      { role: "user", content: "Hello from OpenAI" },
      { role: "assistant", content: "Response" },
    ];
    const hash = await fingerprintMessages(messages);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles Anthropic-style array content", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1 " },
          { type: "text", text: "Part 2" },
        ],
      },
    ];
    const hash = await fingerprintMessages(messages);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("Anthropic-style concatenates text parts", async () => {
    // "AB" as single string vs two parts "A" + "B" should produce the same hash
    const single = [
      { role: "user", content: [{ type: "text", text: "AB" }] },
    ];
    const split = [
      {
        role: "user",
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    ];
    const hashSingle = await fingerprintMessages(single);
    const hashSplit = await fingerprintMessages(split);
    expect(hashSingle).toBe(hashSplit);
  });

  test("uses only the first user message for fingerprinting", async () => {
    const messages = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Second message" },
    ];
    const withSecond = await fingerprintMessages(messages);
    const withoutSecond = await fingerprintMessages([
      { role: "user", content: "First message" },
    ]);
    expect(withSecond).toBe(withoutSecond);
  });

  test("returns a hash even when no user messages exist", async () => {
    const messages = [{ role: "assistant", content: "I started talking" }];
    const hash = await fingerprintMessages(messages);
    // Should hash empty string — still produces 16 hex chars
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
