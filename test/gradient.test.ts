import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db, close, ensureProject } from "../src/db";
import {
  transform,
  setModelLimits,
  calibrate,
  resetCalibration,
  setLtmTokens,
  getLtmTokens,
  getLtmBudget,
  resetPrefixCache,
} from "../src/gradient";
import type { Message, Part } from "@opencode-ai/sdk";

const PROJECT = "/test/gradient/project";

function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID = "grad-sess",
): { info: Message; parts: Part[] } {
  const info: Message =
    role === "user"
      ? {
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }
      : {
          id,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `parent-${id}`,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };
  return {
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

beforeAll(() => {
  ensureProject(PROJECT);
  // Set a small context for testing with zero overhead (no system prompt in tests)
  setModelLimits({ context: 10_000, output: 2_000 });
  calibrate(0, 0); // zero overhead: no system prompt overhead in unit tests
});

afterAll(() => close());

describe("gradient", () => {
  test("passes through small message sets unchanged (Layer 0)", () => {
    const messages = [
      makeMsg("g-1", "user", "Hello, how are you?"),
      makeMsg("g-2", "assistant", "I'm ready to help."),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    // Small messages fit within the context budget — layer 0 passthrough
    expect(result.layer).toBe(0);
    expect(result.messages).toBe(messages); // same reference — untouched
    expect(result.distilledTokens).toBe(0);
    expect(result.rawTokens).toBeGreaterThan(0);
  });

  test("handles many messages without crashing (Layer 0-2)", () => {
    const messages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(
        `bulk-${i}`,
        role as "user" | "assistant",
        `Message content number ${i} with some padding text to take up token space.`,
      );
    });
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(0);
    expect(result.layer).toBeLessThanOrEqual(4);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("Layer 4 nuclear always fits", () => {
    // Each message ~1100 tokens. With 1500 usable and rawBudget = 600,
    // even a single message exceeds the budget, forcing escalation to Layer 4.
    const messages = Array.from({ length: 10 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"detailed content about various topics and implementation details that span across multiple concerns ".repeat(40)}`;
      return makeMsg(`nuclear-${i}`, role as "user" | "assistant", text);
    });
    setModelLimits({ context: 2_000, output: 500 }); // 1500 usable, rawBudget ~600
    calibrate(0, 0); // keep overhead at zero for this test
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);
    expect(result.messages.length).toBeLessThanOrEqual(6); // layer 4: up to 3 prefix + 3 raw
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0, 0);
  });

  test("returns valid token estimates", () => {
    const messages = [
      makeMsg("tok-1", "user", "Test message"),
      makeMsg("tok-2", "assistant", "Response message"),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.rawTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.distilledTokens + result.rawTokens);
  });

  test("activates gradient mode when context is exhausted", () => {
    // Force context exhaustion: context=2000, output=500 → usable=1500
    // Each message ~550 tokens, 6 messages ~3300 tokens > 1500 usable
    setModelLimits({ context: 2_000, output: 500 });
    calibrate(0, 0);
    const messages = Array.from({ length: 6 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(`exhaust-${i}`, role as "user" | "assistant", "X".repeat(2_000));
    });
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "exhaust-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0, 0);
  });
});

describe("gradient — LTM budget coordination", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0, 0); // zero overhead for these tests
  });

  test("getLtmBudget returns fraction of usable context", () => {
    // usable = 10_000 - 2_000 - 0 (overhead) = 8_000
    // ltm fraction 0.10 → 800 tokens
    const budget = getLtmBudget(0.10);
    expect(budget).toBe(800);
  });

  test("getLtmBudget respects different fractions", () => {
    expect(getLtmBudget(0.25)).toBe(2_000);
    expect(getLtmBudget(0.05)).toBe(400);
  });

  test("setLtmTokens / getLtmTokens round-trip", () => {
    setLtmTokens(1_500);
    expect(getLtmTokens()).toBe(1_500);
    setLtmTokens(0);
    expect(getLtmTokens()).toBe(0);
  });

  test("LTM tokens are deducted from usable context in transform()", () => {
    setLtmTokens(2_000); // inject 2K LTM tokens
    // usable before LTM = 8_000; after = 6_000
    // rawBudget = floor(6_000 * 0.4) = 2_400
    const messages = [
      makeMsg("ltm-1", "user", "A".repeat(100)),
      makeMsg("ltm-2", "assistant", "B".repeat(100)),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "ltm-sess",
    });
    expect(result.usable).toBe(6_000);
    setLtmTokens(0); // reset
  });

  test("LTM token deduction triggers lower layers when budget is tight", () => {
    // Inject enough LTM tokens to leave almost no room for messages
    setLtmTokens(7_500); // usable after LTM = 500 tokens — very tight
    const messages = Array.from({ length: 6 }, (_, i) =>
      makeMsg(`tight-${i}`, i % 2 === 0 ? "user" : "assistant", "X".repeat(300)),
    );
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "tight-sess",
    });
    // Should escalate beyond layer 0 due to budget pressure
    expect(result.layer).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeGreaterThan(0);
    setLtmTokens(0); // reset
  });
});
