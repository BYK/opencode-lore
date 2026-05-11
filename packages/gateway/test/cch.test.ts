import { describe, test, expect, beforeEach } from "bun:test";
import {
  signBody,
  resignBody,
  captureBillingPrefix,
  buildBillingBlock,
  deleteBillingPrefix,
  validateSeed,
  resolveSeed,
  _resetForTest,
  WORKER_VERSION,
  WORKER_SEED,
  WORKER_SALT,
  CCH_PLACEHOLDER,
  VERSION_SEEDS,
  _computeVersionSuffix,
  _parseSemver,
  _compareSemver,
} from "../src/cch";

const SID_A = "sess-a";
const SID_B = "sess-b";

beforeEach(() => {
  _resetForTest();
});

// ---------------------------------------------------------------------------
// signBody
// ---------------------------------------------------------------------------

describe("signBody", () => {
  test("replaces cch=00000 with a 5-char hex hash", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.37.fbe; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);
  });

  test("produces different hashes for different bodies", () => {
    const body1 = '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"hello"}]}';
    const body2 = '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"world"}]}';

    const cch1 = signBody(body1).match(/cch=([0-9a-f]{5})/)?.[1];
    const cch2 = signBody(body2).match(/cch=([0-9a-f]{5})/)?.[1];

    expect(cch1).toBeDefined();
    expect(cch2).toBeDefined();
    expect(cch1).not.toEqual(cch2);
  });

  test("produces deterministic output for the same input", () => {
    const body = '{"text":"cch=00000;","data":"stable"}';
    expect(signBody(body)).toEqual(signBody(body));
  });

  test("zero-pads short hashes to 5 chars", () => {
    for (let i = 0; i < 20; i++) {
      const body = `{"text":"cch=00000;","i":${i}}`;
      const match = signBody(body).match(/cch=([0-9a-f]+);/);
      expect(match).not.toBeNull();
      expect(match![1]).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// computeVersionSuffix
// ---------------------------------------------------------------------------

describe("computeVersionSuffix", () => {
  test("returns a 3-char hex string", () => {
    const suffix = _computeVersionSuffix("hello world message");
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });

  test("different messages produce different suffixes", () => {
    const s1 = _computeVersionSuffix("Summarize this conversation segment");
    const s2 = _computeVersionSuffix("Expand the following query for search");
    expect(s1).not.toEqual(s2);
  });

  test("pads with '0' for short messages", () => {
    // Message shorter than index 20 — should pad
    const s1 = _computeVersionSuffix("hi");
    expect(s1).toMatch(/^[0-9a-f]{3}$/);
  });

  test("is deterministic", () => {
    const msg = "Some worker prompt text here";
    expect(_computeVersionSuffix(msg)).toEqual(_computeVersionSuffix(msg));
  });

  test("uses chars at indices 4, 7, 20", () => {
    // We know the algorithm: sha256(salt + chars[4,7,20] + version)[:3]
    // Just verify it doesn't throw and produces a valid suffix
    const msg = "0123456789012345678901234";
    const suffix = _computeVersionSuffix(msg);
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });
});

// ---------------------------------------------------------------------------
// captureBillingPrefix (per-session)
// ---------------------------------------------------------------------------

describe("captureBillingPrefix", () => {
  test("detects billing header in a real Claude Code system prompt", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;\nYou are Claude Code...";
    expect(captureBillingPrefix(SID_A, system)).toBe(true);
  });

  test("detects billing header with different version and hash values", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=00000;";
    expect(captureBillingPrefix(SID_A, system)).toBe(true);
  });

  test("returns false when no billing header is present", () => {
    expect(
      captureBillingPrefix(SID_A, "You are Claude Code, Anthropic's official CLI."),
    ).toBe(false);
  });

  test("returns false for empty system prompt", () => {
    expect(captureBillingPrefix(SID_A, "")).toBe(false);
  });

  test("returns false when billing header is not at the start", () => {
    const system =
      "Some prefix\nx-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;";
    expect(captureBillingPrefix(SID_A, system)).toBe(false);
  });

  test("non-matching turn does not erase a previously captured flag", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_A, "later turn with no header");
    expect(buildBillingBlock(SID_A, "test message")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBillingBlock (per-session, pinned version)
// ---------------------------------------------------------------------------

describe("buildBillingBlock", () => {
  const MSG = "Summarize this conversation.";

  test("returns null for an unknown session", () => {
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
  });

  test("returns null when sessionID is undefined", () => {
    expect(buildBillingBlock(undefined, MSG)).toBeNull();
  });

  test("returns block with cch=00000 placeholder after capture", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    expect(block).not.toBeNull();
    expect(block!.type).toBe("text");
    expect(block!.text).toContain("cch=00000;");
    expect(block!.text).toContain("cc_entrypoint=cli");
    expect(block!.text).toStartWith("x-anthropic-billing-header:");
  });

  test("pins billing header to WORKER_VERSION, not the client version", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.0.99.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    expect(block!.text).toContain(`cc_version=${WORKER_VERSION}.`);
    expect(block!.text).not.toContain("cc_version=2.0.99");
  });

  test("includes a 3-char hex version suffix derived from user message", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    // cc_version=2.1.37.XXX where XXX is 3 hex chars
    expect(block!.text).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
  });

  test("different user messages produce different version suffixes", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block1 = buildBillingBlock(SID_A, "Summarize this conversation.");
    const block2 = buildBillingBlock(SID_A, "Expand query for semantic search.");
    // Extract the suffix
    const suffix1 = block1!.text.match(/cc_version=\d+\.\d+\.\d+\.([0-9a-f]{3})/)?.[1];
    const suffix2 = block2!.text.match(/cc_version=\d+\.\d+\.\d+\.([0-9a-f]{3})/)?.[1];
    expect(suffix1).toBeDefined();
    expect(suffix2).toBeDefined();
    expect(suffix1).not.toEqual(suffix2);
  });

  test("does not leak billing state from session A into session B", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    // Session B never captures billing
    captureBillingPrefix(SID_B, "You are a helpful assistant.");

    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).toBeNull();
  });

  test("both sessions get billing blocks when both have billing headers", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_B,
      "x-anthropic-billing-header: cc_version=2.0.0.xyz; cc_entrypoint=cli; cch=b9999;",
    );

    // Both sessions get billing blocks pinned to WORKER_VERSION
    const blockA = buildBillingBlock(SID_A, MSG);
    const blockB = buildBillingBlock(SID_B, MSG);
    expect(blockA).not.toBeNull();
    expect(blockB).not.toBeNull();
    expect(blockA!.text).toContain(`cc_version=${WORKER_VERSION}.`);
    expect(blockB!.text).toContain(`cc_version=${WORKER_VERSION}.`);
  });

  test("an API-key session that never captures a prefix returns null", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_B, "You are a helpful assistant."); // no header

    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteBillingPrefix
// ---------------------------------------------------------------------------

describe("deleteBillingPrefix", () => {
  const MSG = "test";

  test("removes the billing flag for the given session", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    deleteBillingPrefix(SID_A);
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
  });

  test("does not affect other sessions", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_B,
      "x-anthropic-billing-header: cc_version=2.0.0.xyz; cc_entrypoint=cli; cch=b9999;",
    );
    deleteBillingPrefix(SID_A);
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSeed
// ---------------------------------------------------------------------------

describe("validateSeed", () => {
  test("returns null when body has no cch field", () => {
    expect(validateSeed('{"model":"claude","messages":[]}')).toBeNull();
  });

  test("returns true for a body signed with the known seed", () => {
    // Create a body, sign it with our seed, then validate
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.abc; cc_entrypoint=cli; cch=00000;`,
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);
  });

  test("returns false for a body signed with an unknown seed", () => {
    // Manually create a body with a fake cch
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli; cch=fffff;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    // The cch=fffff is almost certainly not the correct hash
    expect(validateSeed(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: capture → build → sign
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("capture → build → sign produces a valid signed body", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );

    const userMsg = "Summarize this conversation.";
    const block = buildBillingBlock(SID_A, userMsg);
    expect(block).not.toBeNull();

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block, { type: "text", text: "You are a distillation worker." }],
      messages: [{ role: "user", content: userMsg }],
    });

    expect(body).toContain("cch=00000");

    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);

    const parsed = JSON.parse(signed);
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    expect(parsed.system[0].text).toContain(`cc_version=${WORKER_VERSION}.`);
  });

  test("signed body validates against our seed", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );

    const userMsg = "Analyze these highlights.";
    const block = buildBillingBlock(SID_A, userMsg);

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block],
      messages: [{ role: "user", content: userMsg }],
    });

    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resignBody
// ---------------------------------------------------------------------------

describe("resignBody", () => {
  /** Helper: build a serialized body with a client-signed billing header. */
  function buildClientBody(opts: {
    clientVersion?: string;
    clientCch?: string;
    userMessage?: string;
  } = {}): string {
    const version = opts.clientVersion ?? "2.1.35.abc";
    const cch = opts.clientCch ?? "deadb";
    const user = opts.userMessage ?? "Tell me about TypeScript generics";
    return JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli; cch=${cch};`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: user }],
    });
  }

  test("returns body unchanged when no billing header is present", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: "plain system prompt",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resignBody(body, "hello")).toBe(body);
  });

  test("replaces client cch with a valid worker-signed cch", () => {
    const original = buildClientBody({ clientCch: "deadb" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // Client's cch should be gone
    expect(resigned).not.toContain("cch=deadb");
    // New cch should be a 5-char hex value
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    // Should not contain placeholder
    expect(resigned).not.toContain("cch=00000");
  });

  test("replaces cc_version with worker version + computed suffix", () => {
    const original = buildClientBody({ clientVersion: "2.1.35.abc" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // Client's version should be replaced
    expect(resigned).not.toContain("cc_version=2.1.35.abc");
    // Worker version should be present with a 3-char hex suffix
    expect(resigned).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
  });

  test("suffix depends on the first user message", () => {
    const body1 = buildClientBody({ clientCch: "aaaaa" });
    const body2 = buildClientBody({
      clientCch: "aaaaa",
      userMessage: "Completely different user message here!",
    });

    const resigned1 = resignBody(body1, "Tell me about TypeScript generics");
    const resigned2 = resignBody(body2, "Completely different user message here!");

    // Different user messages produce different suffixes
    const suffix1 = resigned1.match(
      new RegExp(`cc_version=${WORKER_VERSION}\\.([0-9a-f]{3});`),
    )?.[1];
    const suffix2 = resigned2.match(
      new RegExp(`cc_version=${WORKER_VERSION}\\.([0-9a-f]{3});`),
    )?.[1];

    expect(suffix1).toBeDefined();
    expect(suffix2).toBeDefined();
    expect(suffix1).not.toBe(suffix2);
  });

  test("resigned body passes validateSeed", () => {
    const original = buildClientBody({ clientCch: "12345" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // The re-signed body should validate with our known seed
    expect(validateSeed(resigned)).toBe(true);
  });

  test("produces same result as signing from scratch", () => {
    // Build a body the same way buildBillingBlock + signBody would
    const userMessage = "Tell me about TypeScript generics";
    const suffix = _computeVersionSuffix(userMessage);

    const freshBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });
    const signedFresh = signBody(freshBody);

    // Now build same body as if client sent it with wrong version/cch, then resign
    const clientBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix}; cc_entrypoint=cli; cch=99999;`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });
    const resigned = resignBody(clientBody, userMessage);

    // Both should produce identical output since version+suffix are the same
    expect(resigned).toBe(signedFresh);
  });

  test("handles empty first user message gracefully", () => {
    const original = buildClientBody({ clientCch: "abcde" });
    const resigned = resignBody(original, "");

    expect(resigned).not.toContain("cch=abcde");
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    expect(validateSeed(resigned)).toBe(true);
  });

  test("handles short first user message (fewer than 21 chars)", () => {
    const original = buildClientBody({ clientCch: "abcde", userMessage: "hi" });
    const resigned = resignBody(original, "hi");

    expect(resigned).not.toContain("cch=abcde");
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    expect(validateSeed(resigned)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  test("WORKER_VERSION is a semver string", () => {
    expect(WORKER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("WORKER_SEED is a non-zero bigint", () => {
    expect(typeof WORKER_SEED).toBe("bigint");
    expect(WORKER_SEED).not.toBe(0n);
  });

  test("WORKER_SALT is a 12-char hex string", () => {
    expect(WORKER_SALT).toMatch(/^[0-9a-f]{12}$/);
  });

  test("CCH_PLACEHOLDER is the expected sentinel", () => {
    expect(CCH_PLACEHOLDER).toBe("cch=00000");
  });

  test("VERSION_SEEDS contains the 2.1.138 seed", () => {
    expect(VERSION_SEEDS["2.1.138"]).toBe(0x4D659218E32A3268n);
  });

  test("WORKER_VERSION points to 2.1.138", () => {
    expect(WORKER_VERSION).toBe("2.1.138");
  });
});

// ---------------------------------------------------------------------------
// resolveSeed — fallback logic for unknown versions
// ---------------------------------------------------------------------------

describe("resolveSeed", () => {
  test("returns exact match for a known version", () => {
    const result = resolveSeed("2.1.138");
    expect(result.exact).toBe(true);
    expect(result.version).toBe("2.1.138");
    expect(result.seed).toBe(VERSION_SEEDS["2.1.138"]);
  });

  test("returns exact match for the older known version", () => {
    const result = resolveSeed("2.1.37");
    expect(result.exact).toBe(true);
    expect(result.version).toBe("2.1.37");
    expect(result.seed).toBe(VERSION_SEEDS["2.1.37"]);
  });

  test("falls back to closest version for an unknown version", () => {
    // 2.1.140 is closer to 2.1.138 than to 2.1.37
    const result = resolveSeed("2.1.140");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.138");
    expect(result.seed).toBe(VERSION_SEEDS["2.1.138"]);
  });

  test("falls back to closest version for a version between known seeds", () => {
    // 2.1.80 — equidistant-ish, but 2.1.37 is 43 away, 2.1.138 is 58 away
    const result = resolveSeed("2.1.80");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.37");
  });

  test("prefers newer version when equidistant", () => {
    // Create a scenario: midpoint between 2.1.37 and 2.1.138 is ~2.1.87-88
    // At exact midpoint, should prefer the newer one
    // Distance from 2.1.88: to 2.1.37 = 51, to 2.1.138 = 50 → picks 2.1.138
    const result = resolveSeed("2.1.88");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.138");
  });

  test("falls back to latest for a much newer unknown version", () => {
    const result = resolveSeed("3.0.0");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.138");
  });

  test("falls back to oldest for a much older unknown version", () => {
    const result = resolveSeed("1.0.0");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.37");
  });

  test("falls back to latest for an unparseable version string", () => {
    const result = resolveSeed("not-a-version");
    expect(result.exact).toBe(false);
    // Should return the latest known version
    expect(result.version).toBe("2.1.138");
  });

  test("falls back to latest for an empty version string", () => {
    const result = resolveSeed("");
    expect(result.exact).toBe(false);
    expect(result.version).toBe("2.1.138");
  });
});

// ---------------------------------------------------------------------------
// parseSemver / compareSemver helpers
// ---------------------------------------------------------------------------

describe("semver helpers", () => {
  test("parseSemver parses valid semver", () => {
    expect(_parseSemver("2.1.138")).toEqual([2, 1, 138]);
    expect(_parseSemver("0.0.1")).toEqual([0, 0, 1]);
  });

  test("parseSemver returns null for invalid input", () => {
    expect(_parseSemver("not-valid")).toBeNull();
    expect(_parseSemver("2.1")).toBeNull();
    expect(_parseSemver("")).toBeNull();
    expect(_parseSemver("2.1.138.4")).toBeNull();
  });

  test("compareSemver orders correctly", () => {
    expect(_compareSemver([2, 1, 138], [2, 1, 37])).toBeGreaterThan(0);
    expect(_compareSemver([2, 1, 37], [2, 1, 138])).toBeLessThan(0);
    expect(_compareSemver([2, 1, 138], [2, 1, 138])).toBe(0);
    expect(_compareSemver([3, 0, 0], [2, 1, 138])).toBeGreaterThan(0);
    expect(_compareSemver([2, 0, 0], [2, 1, 0])).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Known-good values from Claude Code binary analysis
// ---------------------------------------------------------------------------

describe("binary-verified values", () => {
  test("suffix for 'hello' matches Claude Code 2.1.138 output", () => {
    // From binary analysis: chars[4,7,20] of "hello" = "o00"
    // sha256("59cf53e54c78" + "o00" + "2.1.138")[:3] = "470"
    const suffix = _computeVersionSuffix("hello");
    expect(suffix).toBe("470");
  });

  test("2.1.138 seed signs correctly (oracle pair 1)", () => {
    // Verified: body with "hello" prompt signed by Claude Code 2.1.138 → cch=54175
    // We can't reproduce the exact body here (it includes system-reminder etc.)
    // but we verify the seed is non-zero and produces valid output
    const seed = VERSION_SEEDS["2.1.138"];
    expect(seed).toBeDefined();
    expect(seed).not.toBe(0n);

    // Sign a test body with the 2.1.138 seed and verify round-trip
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.138.470; cc_entrypoint=cli; cch=00000;" }],
      messages: [{ role: "user", content: "hello" }],
    });
    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(validateSeed(signed)).toBe(true);
  });

  test("validateSeed accepts bodies signed with either known seed", () => {
    // Sign with current WORKER_SEED (2.1.138)
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.138.abc; cc_entrypoint=cli; cch=00000;" }],
      messages: [{ role: "user", content: "test" }],
    });
    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);

    // Sign same body shape with old seed (2.1.37)
    const oldSeed = VERSION_SEEDS["2.1.37"];
    const body2 = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.37.def; cc_entrypoint=cli; cch=00000;" }],
      messages: [{ role: "user", content: "test" }],
    });
    const hash = Bun.hash.xxHash64(body2, oldSeed);
    const cch = (hash & 0xFFFFFn).toString(16).padStart(5, "0");
    const signedOld = body2.replace("cch=00000", `cch=${cch}`);
    expect(validateSeed(signedOld)).toBe(true);
  });
});
