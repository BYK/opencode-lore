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
  resetRawWindowCache,
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

describe("gradient — lazy raw window eviction (Approach B)", () => {
  // context=5000, output=1000 → usable=4000, rawBudget=floor(4000*0.4)=1600
  // Each ~300-char message ≈ 95 tokens (75 chars/4 + 20 overhead).
  // 10 messages ≈ 950 tokens — fits in 1600 raw budget, so gradient mode
  // is reached only when we push things over with large messages.
  const SESSION = "lazy-evict-sess";

  beforeAll(() => {
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0, 0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("raw window is stable when the new turn fits", () => {
    // Build a conversation that exhausts the context so gradient mode fires.
    // usable=4000; each message ≈ 270 tokens (1000 chars / 4 + 20 overhead).
    // 16 messages ≈ 4320 > 4000 → gradient fires.
    // rawBudget=floor(4000*0.4)=1600 → fits ~5 messages (5 × 270 = 1350 ≤ 1600).
    const base = Array.from({ length: 16 }, (_, i) =>
      makeMsg(`le-${i}`, i % 2 === 0 ? "user" : "assistant", "A".repeat(1_000), SESSION),
    );

    const result1 = transform({ messages: base, projectPath: PROJECT, sessionID: SESSION });
    expect(result1.layer).toBe(1);

    // Identify the first raw message from turn 1
    const firstRawId1 = result1.messages.find(
      (m) => m.info.sessionID === SESSION,
    )?.info.id;
    expect(firstRawId1).toBeDefined();

    // Turn 2: append one small new message — should NOT evict anything
    const withNewSmall = [
      ...base,
      makeMsg(`le-new-small`, "user", "short", SESSION),
    ];
    const result2 = transform({ messages: withNewSmall, projectPath: PROJECT, sessionID: SESSION });
    expect(result2.layer).toBe(1);

    const firstRawId2 = result2.messages.find(
      (m) => m.info.sessionID === SESSION,
    )?.info.id;

    // The raw window should start at the same message — no eviction
    expect(firstRawId2).toBe(firstRawId1);
  });

  test("raw window advances only when the new message forces eviction", () => {
    resetRawWindowCache();

    // context=3000, output=500 → usable=2500, rawBudget=floor(2500*0.4)=1000
    // Each 400-char message ≈ 120 tokens (400/4 + 20 overhead).
    // 22 messages ≈ 2640 > 2500 → gradient fires.
    // rawBudget=1000 → fits ~8 messages (8 × 120 = 960 ≤ 1000).
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0, 0);

    const SESS2 = "lazy-evict-tight";
    const base = Array.from({ length: 22 }, (_, i) =>
      makeMsg(`tight-${i}`, i % 2 === 0 ? "user" : "assistant", "B".repeat(400), SESS2),
    );

    // First call: fills window, records cutoff
    const r1 = transform({ messages: base, projectPath: PROJECT, sessionID: SESS2 });
    expect(r1.layer).toBe(1);
    const firstId1 = r1.messages.find((m) => m.info.sessionID === SESS2)?.info.id;

    // Second call: append a huge message that definitely pushes the pinned window
    // past rawBudget, forcing eviction of the oldest message.
    const withHuge = [
      ...base,
      makeMsg(`tight-huge`, "user", "C".repeat(3_500), SESS2),
    ];
    const r2 = transform({ messages: withHuge, projectPath: PROJECT, sessionID: SESS2 });
    expect(r2.layer).toBe(1);
    const firstId2 = r2.messages.find((m) => m.info.sessionID === SESS2)?.info.id;

    // The window must have advanced (old pinned cutoff no longer fits)
    expect(firstId2).not.toBe(firstId1);

    // Reset back
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0, 0);
  });

  test("raw window cache resets on session change", () => {
    resetRawWindowCache();

    // context=3000, output=500 → usable=2500, rawBudget=1000
    // 22 × 400-char messages ≈ 2640 > 2500 → gradient fires
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0, 0);

    const SESS_A = "lazy-sess-a";
    const SESS_B = "lazy-sess-b";

    const msgsA = Array.from({ length: 22 }, (_, i) =>
      makeMsg(`sa-${i}`, i % 2 === 0 ? "user" : "assistant", "D".repeat(400), SESS_A),
    );
    const msgsB = Array.from({ length: 22 }, (_, i) =>
      makeMsg(`sb-${i}`, i % 2 === 0 ? "user" : "assistant", "E".repeat(400), SESS_B),
    );

    const rA = transform({ messages: msgsA, projectPath: PROJECT, sessionID: SESS_A });
    expect(rA.layer).toBe(1);
    const firstIdA = rA.messages.find((m) => m.info.sessionID === SESS_A)?.info.id;

    // Switch to a different session — cache must not bleed over
    const rB = transform({ messages: msgsB, projectPath: PROJECT, sessionID: SESS_B });
    expect(rB.layer).toBe(1);
    const firstIdB = rB.messages.find((m) => m.info.sessionID === SESS_B)?.info.id;

    expect(firstIdB).not.toBe(firstIdA);
    expect(firstIdB?.startsWith("sb-")).toBe(true);

    // Reset
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0, 0);
    resetRawWindowCache();
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
