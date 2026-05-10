import { describe, test, expect } from "bun:test";
import { computeMaxTokens } from "../src/pipeline";
import { detectClientType } from "../src/session";
import { hasBillingHeader } from "../src/cch";

// ---------------------------------------------------------------------------
// computeMaxTokens
// ---------------------------------------------------------------------------

describe("computeMaxTokens", () => {
  const MODEL_OUTPUT = 128_000; // e.g. Opus 4.x
  const MODEL_CONTEXT = 200_000;

  test("returns ceiling (32K) on first turn with no history", () => {
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, undefined, undefined, undefined),
    ).toBe(32_000);
  });

  test("returns ceiling capped by model output limit", () => {
    // Model with only 8192 max output → ceiling = 8192
    expect(
      computeMaxTokens(8192, 200_000, undefined, undefined, undefined),
    ).toBe(8192);
  });

  test("uses 3× EMA when history is available", () => {
    // EMA 3000 → 3 × 3000 = 9000, above floor (8192)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 3000, "end_turn", 50_000),
    ).toBe(9000);
  });

  test("returns floor when 3× EMA is below floor", () => {
    // EMA 1000 → 3 × 1000 = 3000, below floor (8192)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("returns floor when EMA is zero", () => {
    // EMA explicitly 0 (not undefined) → 3 × 0 = 0, below floor
    // Note: EMA of 0 is distinct from undefined (no history)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 0, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("jumps to ceiling after truncation (stop_reason=length)", () => {
    // EMA 1000 would normally yield floor (8192), but truncation bumps to ceiling
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "length", 50_000),
    ).toBe(32_000);
  });

  test("caps by headroom when context is nearly full", () => {
    // Input 195_000 → headroom = 200_000 - 195_000 - 1000 = 4000 → clamped to floor 8192
    // EMA 20_000 → 3 × 20_000 = 60_000 but headroom is 8192
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 20_000, "end_turn", 195_000),
    ).toBe(8192);
  });

  test("headroom calculation with moderate input", () => {
    // Input 170_000 → headroom = 200_000 - 170_000 - 1000 = 29_000
    // EMA 15_000 → 3 × 15_000 = 45_000, clamped by headroom → 29_000
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 15_000, "end_turn", 170_000),
    ).toBe(29_000);
  });

  test("adaptive stays within ceiling for large EMA", () => {
    // EMA 20_000 → 3 × 20_000 = 60_000, but ceiling = 32_000
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 20_000, "end_turn", 50_000),
    ).toBe(32_000);
  });

  test("handles missing lastInputTokens gracefully", () => {
    // No last input → estimatedInput = 0 → headroom = context - 0 - buffer
    // EMA 3000 → adaptive = 9000
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 3000, "end_turn", undefined),
    ).toBe(9000);
  });

  test("tool_use stop reason does not trigger ceiling jump", () => {
    // Only "length" triggers the safety bump
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "tool_use", 50_000),
    ).toBe(8192);
  });

  test("end_turn stop reason does not trigger ceiling jump", () => {
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("small model output limits ceiling accordingly", () => {
    // Sonnet-like model with 16K output limit
    // EMA 3000 → adaptive = 9000, ceiling = 16_000
    expect(
      computeMaxTokens(16_000, 200_000, 3000, "end_turn", 50_000),
    ).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// detectClientType
// ---------------------------------------------------------------------------

describe("detectClientType", () => {
  test("detects Claude Code via x-claude-code-session-id header", () => {
    expect(
      detectClientType({ "x-claude-code-session-id": "abc-123-uuid" }),
    ).toBe("claude-code");
  });

  test("detects OpenCode via x-session-affinity header", () => {
    expect(
      detectClientType({ "x-session-affinity": "nano-id-value" }),
    ).toBe("opencode");
  });

  test("returns generic when no known headers", () => {
    expect(detectClientType({})).toBe("generic");
    expect(detectClientType({ "x-custom-header": "value" })).toBe("generic");
  });

  test("Claude Code wins when both headers present", () => {
    expect(
      detectClientType({
        "x-claude-code-session-id": "abc",
        "x-session-affinity": "def",
      }),
    ).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// hasBillingHeader
// ---------------------------------------------------------------------------

describe("hasBillingHeader", () => {
  test("returns true for system prompt with billing header", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=a75d0;\n" +
      "You are a helpful assistant.";
    expect(hasBillingHeader(system)).toBe(true);
  });

  test("returns false for system prompt without billing header", () => {
    expect(hasBillingHeader("You are a helpful assistant.")).toBe(false);
  });

  test("returns false for empty system prompt", () => {
    expect(hasBillingHeader("")).toBe(false);
  });

  test("returns false when billing header is not at start", () => {
    const system =
      "You are a helpful assistant.\n" +
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=a75d0;";
    expect(hasBillingHeader(system)).toBe(false);
  });
});
