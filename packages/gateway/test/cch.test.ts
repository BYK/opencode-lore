import { describe, test, expect, beforeEach } from "bun:test";
import {
  signBody,
  captureBillingPrefix,
  buildBillingBlock,
  deleteBillingPrefix,
  _resetForTest,
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
          text: "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=00000;",
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
// captureBillingPrefix (per-session)
// ---------------------------------------------------------------------------

describe("captureBillingPrefix", () => {
  test("extracts prefix from a real Claude Code system prompt", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;\nYou are Claude Code...";
    expect(captureBillingPrefix(SID_A, system)).toBe(true);
  });

  test("extracts prefix with different version and hash values", () => {
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

  test("non-matching turn does not erase a previously captured prefix", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_A, "later turn with no header");
    expect(buildBillingBlock(SID_A)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBillingBlock (per-session)
// ---------------------------------------------------------------------------

describe("buildBillingBlock", () => {
  test("returns null for an unknown session", () => {
    expect(buildBillingBlock(SID_A)).toBeNull();
  });

  test("returns null when sessionID is undefined", () => {
    expect(buildBillingBlock(undefined)).toBeNull();
  });

  test("returns block with cch=00000 placeholder after capture", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A);
    expect(block).not.toBeNull();
    expect(block!.type).toBe("text");
    expect(block!.text).toContain("cch=00000;");
    expect(block!.text).toContain("cc_version=2.1.138.fbe");
    expect(block!.text).toContain("cc_entrypoint=cli");
    expect(block!.text).toStartWith("x-anthropic-billing-header:");
  });

  test("does not include the original cch hash value", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    expect(buildBillingBlock(SID_A)!.text).not.toContain("a39d0");
  });

  test("updates when a new prefix is captured for the same session", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.2.0.abc; cc_entrypoint=cli; cch=b1234;",
    );
    const block = buildBillingBlock(SID_A);
    expect(block!.text).toContain("cc_version=2.2.0.abc");
    expect(block!.text).not.toContain("cc_version=2.1.138.fbe");
  });

  test("does not leak a prefix from session A into session B", () => {
    // The bug this regression-tests: a Claude Code 2.1.x and 2.0.x session
    // sharing one gateway process previously overwrote each other's prefix
    // through the module-level singleton. Workers for session A would sign
    // with session B's cc_version → 429 from the upstream signing check.
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_B,
      "x-anthropic-billing-header: cc_version=2.0.0.xyz; cc_entrypoint=cli; cch=b9999;",
    );

    expect(buildBillingBlock(SID_A)!.text).toContain("cc_version=2.1.138.fbe");
    expect(buildBillingBlock(SID_A)!.text).not.toContain("cc_version=2.0.0.xyz");

    expect(buildBillingBlock(SID_B)!.text).toContain("cc_version=2.0.0.xyz");
    expect(buildBillingBlock(SID_B)!.text).not.toContain("cc_version=2.1.138.fbe");
  });

  test("an API-key session that never captures a prefix returns null", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_B, "You are a helpful assistant."); // no header

    expect(buildBillingBlock(SID_A)).not.toBeNull();
    expect(buildBillingBlock(SID_B)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteBillingPrefix
// ---------------------------------------------------------------------------

describe("deleteBillingPrefix", () => {
  test("removes the prefix for the given session", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    expect(buildBillingBlock(SID_A)).not.toBeNull();
    deleteBillingPrefix(SID_A);
    expect(buildBillingBlock(SID_A)).toBeNull();
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
    expect(buildBillingBlock(SID_A)).toBeNull();
    expect(buildBillingBlock(SID_B)).not.toBeNull();
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

    const block = buildBillingBlock(SID_A);
    expect(block).not.toBeNull();

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block, { type: "text", text: "You are a distillation worker." }],
      messages: [{ role: "user", content: "Summarize this conversation." }],
    });

    expect(body).toContain("cch=00000");

    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);

    const parsed = JSON.parse(signed);
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    expect(parsed.system[0].text).toContain("cc_version=2.1.138.fbe");
  });
});
