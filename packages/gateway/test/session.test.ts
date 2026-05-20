import { describe, test, expect, beforeEach } from "bun:test";
import {
  base62Encode,
  generateSessionID,
  formatMarker,
  parseMarker,
  scanForMarker,
  fingerprintMessages,
  extractKnownSessionHeader,
  findRotationPredecessor,
  ROTATION_MAX_AGE_MS,

  isSessionHeaderName,
  isIdLikeValue,
  collectCandidateHeaders,
  learnHeaders,
  _resetGlobalHeaderValues,
  type HeaderCandidate,
  type RotationCandidate,
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

  test("model changes do not affect fingerprint (model excluded)", async () => {
    const messages = [{ role: "user", content: "Help me with code" }];
    // fingerprintMessages no longer accepts model — same messages always
    // produce the same hash regardless of what model the client sends.
    const hash1 = await fingerprintMessages(messages, {
      authSuffix: "auth123",
    });
    const hash2 = await fingerprintMessages(messages, {
      authSuffix: "auth123",
    });
    expect(hash1).toBe(hash2);
  });

  test("different auth suffixes produce different fingerprints", async () => {
    const messages = [{ role: "user", content: "Hello" }];
    const hash1 = await fingerprintMessages(messages, {
      authSuffix: "user-a",
    });
    const hash2 = await fingerprintMessages(messages, {
      authSuffix: "user-b",
    });
    expect(hash1).not.toBe(hash2);
  });
});

// ===========================================================================
// Tier 1: Known session headers
// ===========================================================================

describe("extractKnownSessionHeader", () => {
  test("extracts x-claude-code-session-id", () => {
    const result = extractKnownSessionHeader({
      "x-claude-code-session-id": "uuid-1234-5678",
      "content-type": "application/json",
    });
    expect(result).toEqual({
      sessionId: "uuid-1234-5678",
      headerName: "x-claude-code-session-id",
    });
  });

  test("extracts x-session-affinity", () => {
    const result = extractKnownSessionHeader({
      "x-session-affinity": "ses_abc123def",
      "content-type": "application/json",
    });
    expect(result).toEqual({
      sessionId: "ses_abc123def",
      headerName: "x-session-affinity",
    });
  });

  test("prefers x-lore-session-id over x-claude-code-session-id and x-session-affinity", () => {
    const result = extractKnownSessionHeader({
      "x-lore-session-id": "stable-lore-id",
      "x-claude-code-session-id": "claude-uuid",
      "x-session-affinity": "opencode-id",
    });
    expect(result).toEqual({
      sessionId: "stable-lore-id",
      headerName: "x-lore-session-id",
    });
  });

  test("prefers x-claude-code-session-id over x-session-affinity", () => {
    const result = extractKnownSessionHeader({
      "x-claude-code-session-id": "claude-uuid",
      "x-session-affinity": "opencode-id",
    });
    expect(result).toEqual({
      sessionId: "claude-uuid",
      headerName: "x-claude-code-session-id",
    });
  });

  test("returns null when no known headers present", () => {
    const result = extractKnownSessionHeader({
      "content-type": "application/json",
      authorization: "Bearer sk-xxx",
    });
    expect(result).toBeNull();
  });

  test("ignores empty header values", () => {
    const result = extractKnownSessionHeader({
      "x-claude-code-session-id": "",
      "x-session-affinity": "valid-id",
    });
    expect(result).toEqual({
      sessionId: "valid-id",
      headerName: "x-session-affinity",
    });
  });
});

// ===========================================================================
// Tier 2: Header learning helpers
// ===========================================================================

describe("isSessionHeaderName", () => {
  test("matches session-related header names", () => {
    expect(isSessionHeaderName("x-session-affinity")).toBe(true);
    expect(isSessionHeaderName("x-my-session-id")).toBe(true);
    expect(isSessionHeaderName("x-custom-session")).toBe(true);
    expect(isSessionHeaderName("x-client-session-key")).toBe(true);
  });

  test("matches affinity-related header names", () => {
    expect(isSessionHeaderName("x-affinity")).toBe(true);
    expect(isSessionHeaderName("x-server-affinity")).toBe(true);
  });

  test("rejects session headers containing token/cookie/auth/secret", () => {
    expect(isSessionHeaderName("x-session-token")).toBe(false);
    expect(isSessionHeaderName("x-session-cookie")).toBe(false);
    expect(isSessionHeaderName("x-session-auth")).toBe(false);
    expect(isSessionHeaderName("x-session-secret")).toBe(false);
  });

  test("rejects non-session headers", () => {
    expect(isSessionHeaderName("content-type")).toBe(false);
    expect(isSessionHeaderName("authorization")).toBe(false);
    expect(isSessionHeaderName("x-request-id")).toBe(false);
    expect(isSessionHeaderName("x-client-version")).toBe(false);
  });
});

describe("isIdLikeValue", () => {
  test("accepts UUIDs", () => {
    expect(isIdLikeValue("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("accepts nanoid-style IDs", () => {
    expect(isIdLikeValue("ses_abc123def456")).toBe(true);
    expect(isIdLikeValue("V1StGXR8_Z5jdHi6B-myT")).toBe(true);
  });

  test("accepts base62 session IDs", () => {
    expect(isIdLikeValue("0KwcdDNwrsThYYON")).toBe(true);
  });

  test("rejects JWTs (contain dots)", () => {
    expect(
      isIdLikeValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.xxx"),
    ).toBe(false);
  });

  test("rejects URLs (contain slashes)", () => {
    expect(isIdLikeValue("https://example.com/api")).toBe(false);
  });

  test("rejects short values (< 8 chars)", () => {
    expect(isIdLikeValue("abc")).toBe(false);
    expect(isIdLikeValue("1234567")).toBe(false);
  });

  test("rejects very long values (> 128 chars)", () => {
    expect(isIdLikeValue("a".repeat(129))).toBe(false);
  });

  test("rejects booleans and simple words", () => {
    expect(isIdLikeValue("true")).toBe(false);
    expect(isIdLikeValue("false")).toBe(false);
  });

  test("rejects values with spaces", () => {
    expect(isIdLikeValue("some value here")).toBe(false);
  });
});

describe("collectCandidateHeaders", () => {
  test("collects x- headers with ID-like values", () => {
    const candidates = collectCandidateHeaders({
      "x-session-affinity": "ses_abc123def456",
      "x-request-id": "req-uuid-1234-5678",
      "content-type": "application/json",
      authorization: "Bearer sk-xxx-very-long-token",
    });
    expect(candidates.size).toBe(2);
    expect(candidates.get("x-session-affinity")).toBe("ses_abc123def456");
    expect(candidates.get("x-request-id")).toBe("req-uuid-1234-5678");
  });

  test("excludes non-x- headers", () => {
    const candidates = collectCandidateHeaders({
      "content-type": "application/json",
      authorization: "Bearer abcdef123456",
    });
    expect(candidates.size).toBe(0);
  });

  test("excludes x- headers with non-ID-like values", () => {
    const candidates = collectCandidateHeaders({
      "x-client-version": "1.0.0", // contains dots
      "x-debug": "true", // too short
      "x-api-key": "sk-" + "a".repeat(130), // too long
    });
    expect(candidates.size).toBe(0);
  });
});

// ===========================================================================
// Tier 2: Header learning algorithm
// ===========================================================================

describe("learnHeaders", () => {
  beforeEach(() => {
    _resetGlobalHeaderValues();
  });

  test("seeds candidates on first call", () => {
    const result = learnHeaders(undefined, {
      "x-my-session": "session-id-12345",
      "x-request-id": "req-aaaabbbb1234",
    });
    expect(result.updatedCandidates.size).toBe(2);
    expect(result.updatedCandidates.get("x-my-session")?.seenCount).toBe(1);
    expect(result.updatedCandidates.get("x-request-id")?.seenCount).toBe(1);
    expect(result.promoted).toBeNull();
  });

  test("increments seenCount for stable headers", () => {
    const headers = { "x-my-session": "session-id-12345" };
    const r1 = learnHeaders(undefined, headers);
    const r2 = learnHeaders(r1.updatedCandidates, headers);
    expect(r2.updatedCandidates.get("x-my-session")?.seenCount).toBe(2);
    expect(r2.promoted).toBeNull(); // not yet at threshold
  });

  test("resets seenCount when value changes", () => {
    const r1 = learnHeaders(undefined, {
      "x-request-id": "req-aaaabbbb1234",
    });
    expect(r1.updatedCandidates.get("x-request-id")?.seenCount).toBe(1);

    const r2 = learnHeaders(r1.updatedCandidates, {
      "x-request-id": "req-ccccdddd5678",
    });
    expect(r2.updatedCandidates.get("x-request-id")?.seenCount).toBe(1);
    expect(r2.updatedCandidates.get("x-request-id")?.value).toBe(
      "req-ccccdddd5678",
    );
  });

  test("removes candidates that disappear from request", () => {
    const r1 = learnHeaders(undefined, {
      "x-my-session": "session-id-12345",
      "x-ephemeral": "temp-val-abcd1234",
    });
    expect(r1.updatedCandidates.size).toBe(2);

    const r2 = learnHeaders(r1.updatedCandidates, {
      "x-my-session": "session-id-12345",
      // x-ephemeral is gone
    });
    expect(r2.updatedCandidates.size).toBe(1);
    expect(r2.updatedCandidates.has("x-ephemeral")).toBe(false);
  });

  test("does not promote until cross-session uniqueness is confirmed", () => {
    // Simulate 3 turns from a single session — header is stable but
    // only one value seen globally → should NOT promote.
    const headers = { "x-my-session": "session-aaaa1111" };
    const r1 = learnHeaders(undefined, headers);
    const r2 = learnHeaders(r1.updatedCandidates, headers);
    const r3 = learnHeaders(r2.updatedCandidates, headers);

    expect(r3.updatedCandidates.get("x-my-session")?.seenCount).toBe(3);
    // Only one value seen globally — could be a constant
    expect(r3.promoted).toBeNull();
  });

  test("promotes header after stability + cross-session uniqueness", () => {
    // Session A: 3 turns with value "aaaa"
    const headersA = { "x-my-session": "session-aaaa1111" };
    const a1 = learnHeaders(undefined, headersA);
    const a2 = learnHeaders(a1.updatedCandidates, headersA);
    // Still not promoted (only 1 global value)
    expect(a2.promoted).toBeNull();

    // Session B: 1 turn with different value "bbbb" — seeds the global set
    const headersB = { "x-my-session": "session-bbbb2222" };
    learnHeaders(undefined, headersB);
    // Now global set for x-my-session has 2 values

    // Session A: turn 3 — stable + cross-session unique → promote
    const a3 = learnHeaders(a2.updatedCandidates, headersA);
    expect(a3.promoted).toEqual({
      name: "x-my-session",
      value: "session-aaaa1111",
    });
  });

  test("prefers session-named headers over generic ones for promotion", () => {
    // Both headers are stable for 3 turns and cross-session unique,
    // but x-my-session matches the session name pattern → preferred.

    // Seed cross-session uniqueness for both headers
    learnHeaders(undefined, {
      "x-my-session": "other-session-val",
      "x-custom-id": "other-custom-val1",
    });

    // Session: 3 turns
    const headers = {
      "x-my-session": "session-aaaa1111",
      "x-custom-id": "custom-bbbb2222",
    };
    const r1 = learnHeaders(undefined, headers);
    const r2 = learnHeaders(r1.updatedCandidates, headers);
    const r3 = learnHeaders(r2.updatedCandidates, headers);

    expect(r3.promoted).toEqual({
      name: "x-my-session",
      value: "session-aaaa1111",
    });
  });

  test("per-request headers never stabilize", () => {
    // Simulate a header that changes every turn (like x-request-id)
    const r1 = learnHeaders(undefined, {
      "x-request-id": "req-turn1-abcd12",
    });
    const r2 = learnHeaders(r1.updatedCandidates, {
      "x-request-id": "req-turn2-efgh34",
    });
    const r3 = learnHeaders(r2.updatedCandidates, {
      "x-request-id": "req-turn3-ijkl56",
    });

    // seenCount resets every turn — never reaches threshold
    expect(r3.updatedCandidates.get("x-request-id")?.seenCount).toBe(1);
    expect(r3.promoted).toBeNull();
  });
});

// ===========================================================================
// Tier 1b: Header value rotation detection
// ===========================================================================

describe("findRotationPredecessor", () => {
  const now = Date.now();

  /** Helper to build a simple header index map. */
  function buildIndex(entries: Array<[string, string, string]>): Map<string, string> {
    const index = new Map<string, string>();
    for (const [headerName, headerValue, sid] of entries) {
      index.set(`${headerName}:${headerValue}`, sid);
    }
    return index;
  }

  /** Helper to build a candidate lookup function. */
  function buildLookup(
    candidates: Map<string, RotationCandidate>,
  ): (sid: string) => RotationCandidate | null {
    return (sid) => candidates.get(sid) ?? null;
  }

  test("finds a single predecessor when header value rotates", () => {
    const index = buildIndex([
      ["x-session-affinity", "old-nanoid-abc", "lore-session-123"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-123", { sid: "lore-session-123", isSubagent: false, lastActiveAt: now - 60_000 }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toEqual({
      sid: "lore-session-123",
      oldHeaderValue: "old-nanoid-abc",
    });
  });

  test("returns null when no predecessor exists (first session)", () => {
    const index = new Map<string, string>();
    const candidates = new Map<string, RotationCandidate>();

    const result = findRotationPredecessor(
      "x-session-affinity",
      "first-nanoid-abc",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });

  test("returns null when multiple predecessors exist (concurrent sessions)", () => {
    const index = buildIndex([
      ["x-session-affinity", "nanoid-session-a", "lore-session-A"],
      ["x-session-affinity", "nanoid-session-b", "lore-session-B"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-A", { sid: "lore-session-A", isSubagent: false, lastActiveAt: now - 60_000 }],
      ["lore-session-B", { sid: "lore-session-B", isSubagent: false, lastActiveAt: now - 60_000 }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });

  test("skips sub-agent sessions", () => {
    const index = buildIndex([
      ["x-session-affinity", "subagent-nanoid", "lore-subagent-1"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-subagent-1", { sid: "lore-subagent-1", isSubagent: true, lastActiveAt: now - 60_000 }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });

  test("skips stale sessions older than 24 hours", () => {
    const staleTime = now - ROTATION_MAX_AGE_MS - 1;
    const index = buildIndex([
      ["x-session-affinity", "old-nanoid-abc", "lore-session-stale"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-stale", { sid: "lore-session-stale", isSubagent: false, lastActiveAt: staleTime }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });

  test("finds predecessor when stale + active sessions exist (stale filtered out)", () => {
    const staleTime = now - ROTATION_MAX_AGE_MS - 1;
    const index = buildIndex([
      ["x-session-affinity", "stale-nanoid", "lore-session-stale"],
      ["x-session-affinity", "active-nanoid", "lore-session-active"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-stale", { sid: "lore-session-stale", isSubagent: false, lastActiveAt: staleTime }],
      ["lore-session-active", { sid: "lore-session-active", isSubagent: false, lastActiveAt: now - 60_000 }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toEqual({
      sid: "lore-session-active",
      oldHeaderValue: "active-nanoid",
    });
  });

  test("finds predecessor when subagent + real sessions exist (subagent filtered out)", () => {
    const index = buildIndex([
      ["x-session-affinity", "subagent-nanoid", "lore-subagent"],
      ["x-session-affinity", "real-nanoid", "lore-session-real"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-subagent", { sid: "lore-subagent", isSubagent: true, lastActiveAt: now - 60_000 }],
      ["lore-session-real", { sid: "lore-session-real", isSubagent: false, lastActiveAt: now - 60_000 }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toEqual({
      sid: "lore-session-real",
      oldHeaderValue: "real-nanoid",
    });
  });

  test("ignores entries from different header names", () => {
    const index = buildIndex([
      ["x-claude-code-session-id", "claude-uuid", "lore-session-claude"],
      ["x-session-affinity", "old-nanoid", "lore-session-opencode"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-claude", { sid: "lore-session-claude", isSubagent: false, lastActiveAt: now - 60_000 }],
      ["lore-session-opencode", { sid: "lore-session-opencode", isSubagent: false, lastActiveAt: now - 60_000 }],
    ]);

    // Rotating x-session-affinity should only find the opencode session, not claude
    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toEqual({
      sid: "lore-session-opencode",
      oldHeaderValue: "old-nanoid",
    });
  });

  test("skips orphaned index entries (candidate lookup returns null)", () => {
    const index = buildIndex([
      ["x-session-affinity", "orphaned-nanoid", "lore-session-gone"],
    ]);
    // No candidates — simulates session not in memory and not in DB
    const candidates = new Map<string, RotationCandidate>();

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });

  test("session just at 24h boundary is still valid", () => {
    // Exactly at the boundary (not over) should be included
    const justAtBoundary = now - ROTATION_MAX_AGE_MS;
    const index = buildIndex([
      ["x-session-affinity", "old-nanoid", "lore-session-boundary"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-boundary", { sid: "lore-session-boundary", isSubagent: false, lastActiveAt: justAtBoundary }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    // now - justAtBoundary === ROTATION_MAX_AGE_MS, which is NOT > ROTATION_MAX_AGE_MS
    expect(result).toEqual({
      sid: "lore-session-boundary",
      oldHeaderValue: "old-nanoid",
    });
  });

  test("session 1ms over 24h boundary is stale", () => {
    const justOverBoundary = now - ROTATION_MAX_AGE_MS - 1;
    const index = buildIndex([
      ["x-session-affinity", "old-nanoid", "lore-session-over"],
    ]);
    const candidates = new Map<string, RotationCandidate>([
      ["lore-session-over", { sid: "lore-session-over", isSubagent: false, lastActiveAt: justOverBoundary }],
    ]);

    const result = findRotationPredecessor(
      "x-session-affinity",
      "new-nanoid-xyz",
      index,
      buildLookup(candidates),
      now,
    );

    expect(result).toBeNull();
  });
});
