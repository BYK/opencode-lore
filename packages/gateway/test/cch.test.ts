import { describe, test, expect, beforeEach } from "bun:test";
import {
  signBody,
  captureBillingPrefix,
  buildBillingBlock,
  _resetForTest,
} from "../src/cch";

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
    // cch= followed by exactly 5 hex chars and a semicolon
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);
  });

  test("produces different hashes for different bodies", () => {
    const body1 = '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"hello"}]}';
    const body2 = '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"world"}]}';

    const signed1 = signBody(body1);
    const signed2 = signBody(body2);

    const cch1 = signed1.match(/cch=([0-9a-f]{5})/)?.[1];
    const cch2 = signed2.match(/cch=([0-9a-f]{5})/)?.[1];

    expect(cch1).toBeDefined();
    expect(cch2).toBeDefined();
    expect(cch1).not.toEqual(cch2);
  });

  test("produces deterministic output for the same input", () => {
    const body = '{"text":"cch=00000;","data":"stable"}';
    expect(signBody(body)).toEqual(signBody(body));
  });

  test("zero-pads short hashes to 5 chars", () => {
    // We can't force a specific hash, but we verify format on multiple inputs
    for (let i = 0; i < 20; i++) {
      const body = `{"text":"cch=00000;","i":${i}}`;
      const signed = signBody(body);
      const match = signed.match(/cch=([0-9a-f]+);/);
      expect(match).not.toBeNull();
      expect(match![1]).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// captureBillingPrefix
// ---------------------------------------------------------------------------

describe("captureBillingPrefix", () => {
  test("extracts prefix from a real Claude Code system prompt", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;\nYou are Claude Code...";
    expect(captureBillingPrefix(system)).toBe(true);
  });

  test("extracts prefix with different version and hash values", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=00000;";
    expect(captureBillingPrefix(system)).toBe(true);
  });

  test("returns false when no billing header is present", () => {
    const system = "You are Claude Code, Anthropic's official CLI for Claude.";
    expect(captureBillingPrefix(system)).toBe(false);
  });

  test("returns false for empty system prompt", () => {
    expect(captureBillingPrefix("")).toBe(false);
  });

  test("returns false when billing header is not at the start", () => {
    const system =
      "Some prefix\nx-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;";
    expect(captureBillingPrefix(system)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildBillingBlock
// ---------------------------------------------------------------------------

describe("buildBillingBlock", () => {
  test("returns null before any prefix is captured", () => {
    expect(buildBillingBlock()).toBeNull();
  });

  test("returns block with cch=00000 placeholder after capture", () => {
    captureBillingPrefix(
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock();
    expect(block).not.toBeNull();
    expect(block!.type).toBe("text");
    expect(block!.text).toContain("cch=00000;");
    expect(block!.text).toContain("cc_version=2.1.138.fbe");
    expect(block!.text).toContain("cc_entrypoint=cli");
    expect(block!.text).toStartWith("x-anthropic-billing-header:");
  });

  test("does not include the original cch hash value", () => {
    captureBillingPrefix(
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock();
    expect(block!.text).not.toContain("a39d0");
  });

  test("updates when a new prefix is captured", () => {
    captureBillingPrefix(
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      "x-anthropic-billing-header: cc_version=2.2.0.abc; cc_entrypoint=cli; cch=b1234;",
    );
    const block = buildBillingBlock();
    expect(block!.text).toContain("cc_version=2.2.0.abc");
    expect(block!.text).not.toContain("cc_version=2.1.138.fbe");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: capture → build → sign
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("capture → build → sign produces a valid signed body", () => {
    // 1. Capture from a conversation system prompt
    captureBillingPrefix(
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );

    // 2. Build billing block for worker
    const block = buildBillingBlock();
    expect(block).not.toBeNull();

    // 3. Build body with placeholder
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block, { type: "text", text: "You are a distillation worker." }],
      messages: [{ role: "user", content: "Summarize this conversation." }],
    });

    expect(body).toContain("cch=00000");

    // 4. Sign
    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);

    // 5. Parse the signed body — should be valid JSON
    const parsed = JSON.parse(signed);
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    expect(parsed.system[0].text).toContain("cc_version=2.1.138.fbe");
  });
});
