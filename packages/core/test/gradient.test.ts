import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db, ensureProject, loadForceMinLayer } from "../src/db";
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
  setForceMinLayer,
  getLastLayer,
  estimateMessages,
  deduplicateToolOutputs,
  laterReadCovers,
  onIdleResume,
  consumeCameOutOfIdle,
  inspectSessionState,
  setLastTurnAtForTest,
} from "../src/gradient";
import type { LoreMessage, LorePart, LoreMessageWithParts } from "../src/types";
import { isToolPart } from "../src/types";

const PROJECT = "/test/gradient/project";

function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage =
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
  calibrate(0); // zero overhead: no system prompt overhead in unit tests
});


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

  test("Layer 4 nuclear always fits (token-budget tail)", () => {
    // Each message ~1100 tokens. With 1500 usable and rawBudget = 600,
    // even a single message exceeds the budget, forcing escalation to Layer 4.
    // Post-F7: layer 4 uses a token-budget tail (clamp(usable*0.25, 2K, 8K))
    // instead of a fixed slice(-3). With usable=1500, tailBudget = max(2000,
    // min(8000, 375)) = 2000. The current turn (last user + subsequent
    // assistants) is always included even when it alone exceeds the budget.
    const messages = Array.from({ length: 10 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"detailed content about various topics and implementation details that span across multiple concerns ".repeat(40)}`;
      return makeMsg(`nuclear-${i}`, role as "user" | "assistant", text);
    });
    setModelLimits({ context: 2_000, output: 500 }); // 1500 usable, rawBudget ~600
    calibrate(0); // keep overhead at zero for this test
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);
    // Current turn is always included; budget is tight so not many extras.
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("Layer 4 includes more than 3 messages when budget allows (tiny messages)", () => {
    // With tiny messages (~15 tokens each) and usable = 10_000,
    // tailBudget = max(2000, min(8000, 2500)) = 2500 → can fit ~160 tiny messages.
    // Verify that more than the old fixed 3 are included.
    const messages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(`tiny-${i}`, role as "user" | "assistant", `Msg ${i}: short`);
    });
    setModelLimits({ context: 12_000, output: 2_000 }); // usable ~10000
    calibrate(0);
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-tiny-sess",
    });
    // Should hit layer 4 because there are no distillations and the total
    // raw exceeds rawBudget. The key assertion: more than 3 raw messages
    // are kept (the old fixed limit).
    if (result.layer === 4) {
      expect(result.messages.length).toBeGreaterThan(3);
    }
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
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
    calibrate(0);
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
    calibrate(0);
  });
});

describe("gradient — lazy raw window eviction (Approach B)", () => {
  // context=5000, output=1000 → usable=4000, rawBudget=floor(4000*0.4)=1600
  // Each ~1000-char message ≈ 354 tokens (1000 chars/3 + 20 overhead).
  // 16 messages ≈ 5664 > 4000 → gradient fires.
  const SESSION = "lazy-evict-sess";

  beforeAll(() => {
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  afterAll(() => {
    // Restore default limits so subsequent test suites aren't affected
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("raw window is stable when the new turn fits", () => {
    // Build a conversation that exhausts the context so gradient mode fires.
    // usable=4000; each message ≈ 354 tokens (1000 chars/3 + 20 overhead).
    // 16 messages ≈ 5664 > 4000 → gradient fires.
    // rawBudget=1600 → fits ~4 messages (4 × 354 = 1416 ≤ 1600).
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
    // Each 400-char message ≈ 154 tokens (400 chars/3 + 20 overhead).
    // 22 messages ≈ 3388 > 2500 → gradient fires.
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

    const SESS2 = "lazy-evict-tight";
    const base = Array.from({ length: 22 }, (_, i) =>
      makeMsg(`tight-${i}`, i % 2 === 0 ? "user" : "assistant", "B".repeat(400), SESS2),
    );

    // First call: fills window, records cutoff
    const r1 = transform({ messages: base, projectPath: PROJECT, sessionID: SESS2 });
    expect(r1.layer).toBe(1);
    const firstId1 = r1.messages.find((m) => m.info.sessionID === SESS2)?.info.id;

    // Second call: append a large message that pushes the pinned window past
    // rawBudget (1000), forcing eviction. C(2000) = 687 tokens — fits within
    // rawBudget alone, but combined with pinned base messages forces re-scan.
    const withHuge = [
      ...base,
      makeMsg(`tight-huge`, "user", "C".repeat(2_000), SESS2),
    ];
    const r2 = transform({ messages: withHuge, projectPath: PROJECT, sessionID: SESS2 });
    expect(r2.layer).toBe(1);
    const firstId2 = r2.messages.find((m) => m.info.sessionID === SESS2)?.info.id;

    // The window must have advanced (old pinned cutoff no longer fits)
    expect(firstId2).not.toBe(firstId1);

    // Reset back
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
  });

  test("raw window cache resets on session change", () => {
    resetRawWindowCache();

    // context=3000, output=500 → usable=2500
    // 22 × 400-char messages ≈ 3388 > 2500 → gradient fires
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

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
    calibrate(0);
    resetRawWindowCache();
  });
});

describe("gradient — LTM budget coordination", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0); // zero overhead for these tests
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

describe("gradient — force escalation (reactive error recovery)", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("setForceMinLayer(2) skips layers 0 and 1", () => {
    // Messages that would normally fit in layer 0 (tiny)
    const messages = [
      makeMsg("fe-1", "user", "hello", "force-sess"),
      makeMsg("fe-2", "assistant", "hi", "force-sess"),
    ];
    setForceMinLayer(2, "force-sess");
    const result = transform({ messages, projectPath: PROJECT, sessionID: "force-sess" });
    // Despite tiny messages, force min layer should push to at least layer 2
    expect(result.layer).toBeGreaterThanOrEqual(2);
    // After one use, the flag is consumed — next call should behave normally
    const result2 = transform({ messages, projectPath: PROJECT, sessionID: "force-sess" });
    expect(result2.layer).toBe(0);
  });

  test("forceMinLayer is one-shot — cleared after single use", () => {
    const messages = [
      makeMsg("os-1", "user", "test", "oneshot-sess"),
      makeMsg("os-2", "assistant", "ok", "oneshot-sess"),
    ];
    setForceMinLayer(1, "oneshot-sess");
    // First call consumes the flag
    const r1 = transform({ messages, projectPath: PROJECT, sessionID: "oneshot-sess" });
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    // Second call — no flag, tiny messages → layer 0
    const r2 = transform({ messages, projectPath: PROJECT, sessionID: "oneshot-sess" });
    expect(r2.layer).toBe(0);
  });

  test("resetCalibration clears forceMinLayer", () => {
    setForceMinLayer(3, "rc-sess");
    resetCalibration();
    calibrate(0); // re-establish zero overhead after reset
    const messages = [
      makeMsg("rc-1", "user", "hello", "rc-sess"),
      makeMsg("rc-2", "assistant", "world", "rc-sess"),
    ];
    // After reset+recalibrate, flag is gone — tiny messages → layer 0
    const result = transform({ messages, projectPath: PROJECT, sessionID: "rc-sess" });
    expect(result.layer).toBe(0);
  });
});

describe("gradient — forceMinLayer persistence (restart survival)", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("persisted forceMinLayer is loaded by getSessionState on cold start", () => {
    const SID = "persist-cold-sess";
    const messages = [
      makeMsg("pc-1", "user", "hello", SID),
      makeMsg("pc-2", "assistant", "hi", SID),
    ];

    // Ensure no in-memory state exists for this session
    resetCalibration(SID);
    calibrate(0);

    // Manually write forceMinLayer to DB (simulating a prior process's setForceMinLayer)
    db().query(
      "INSERT OR REPLACE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, ?, ?)",
    ).run(SID, 2, Date.now());

    // transform() should pick up forceMinLayer=2 from DB
    const result = transform({ messages, projectPath: PROJECT, sessionID: SID });
    expect(result.layer).toBeGreaterThanOrEqual(2);

    // One-shot: consumed — DB should be cleared
    expect(loadForceMinLayer(SID)).toBe(0);

    // Next call should be layer 0 (tiny messages, no escalation)
    const result2 = transform({ messages, projectPath: PROJECT, sessionID: SID });
    expect(result2.layer).toBe(0);
  });

  test("setForceMinLayer writes to DB and transform consumes it", () => {
    const SID = "persist-consume-sess";
    const messages = [
      makeMsg("pco-1", "user", "hello", SID),
      makeMsg("pco-2", "assistant", "hi", SID),
    ];

    resetCalibration(SID);
    calibrate(0);

    setForceMinLayer(3, SID);
    expect(loadForceMinLayer(SID)).toBe(3);

    // Transform consumes the escalation
    const result = transform({ messages, projectPath: PROJECT, sessionID: SID });
    expect(result.layer).toBeGreaterThanOrEqual(3);

    // DB row should be deleted after consumption
    expect(loadForceMinLayer(SID)).toBe(0);
  });
});

describe("gradient — exact token tracking (proactive layer 0)", () => {
  const SESSION = "exact-tok-sess";

  beforeEach(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("uses exact lastKnownInput for layer 0 check when session matches", () => {
    const messages = [
      makeMsg("et-1", "user", "A".repeat(500), SESSION),
      makeMsg("et-2", "assistant", "B".repeat(500), SESSION),
    ];
    // Simulate a prior API response: 3000 tokens in, 2 messages
    // (overhead 0 so actual = message estimate)
    calibrate(3_000, SESSION, 2);

    // Now add one new message
    const withNew = [...messages, makeMsg("et-3", "user", "C".repeat(500), SESSION)];
    // expectedInput = 3000 + ~130 = ~3130 << maxInput (8000) → layer 0
    const result = transform({ messages: withNew, projectPath: PROJECT, sessionID: SESSION });
    expect(result.layer).toBe(0);
    expect(result.messages).toBe(withNew); // same reference
  });

  test("falls back to chars/3 estimate when session changes", () => {
    // calibrate was for SESSION, but we transform a different session.
    // First zero the overhead (beforeEach resets to null → FIRST_TURN_OVERHEAD=15K).
    calibrate(0);
    calibrate(3_000, SESSION, 2);
    const messages = [
      makeMsg("diff-1", "user", "A".repeat(200), "other-sess"),
      makeMsg("diff-2", "assistant", "B".repeat(200), "other-sess"),
    ];
    // Fallback: messageTokens + overhead(0) + ltm(0) = ~174 << 8000 → still layer 0
    const result = transform({ messages, projectPath: PROJECT, sessionID: "other-sess" });
    expect(result.layer).toBe(0);
  });

  test("exact tracking prevents overflow: near-limit session stays layer 0", () => {
    // maxInput = 10000 - 2000 = 8000
    // Set lastKnownInput close to limit but within budget
    calibrate(7_800, SESSION, 10);
    // New message: very short (~25 tokens)
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`near-${i}`, i % 2 === 0 ? "user" : "assistant", "X".repeat(50), SESSION),
    );
    const withNew = [...messages, makeMsg("near-new", "user", "hi", SESSION)];
    // expectedInput ≈ 7800 + 25 = 7825 ≤ 8000 → layer 0
    const result = transform({ messages: withNew, projectPath: PROJECT, sessionID: SESSION });
    expect(result.layer).toBe(0);
  });

  test("exact tracking escalates when new messages push over limit", () => {
    // lastKnownInput = 7900, maxInput = 8000, new message ~600 tokens
    calibrate(7_900, SESSION, 10);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`over-${i}`, i % 2 === 0 ? "user" : "assistant", "X".repeat(100), SESSION),
    );
    const withHuge = [...messages, makeMsg("over-huge", "user", "Y".repeat(2_200), SESSION)];
    // expectedInput ≈ 7900 + 570 = 8470 > 8000 → escalate
    const result = transform({ messages: withHuge, projectPath: PROJECT, sessionID: SESSION });
    expect(result.layer).toBeGreaterThanOrEqual(1);
  });
});

// Helper: make an assistant message that is a "sibling step" in an agentic
// tool-call loop — same parentID as the last user message.
function makeStep(
  id: string,
  parentUserID: string,
  text: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
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

describe("gradient — current turn protection (agentic tool-call loop)", () => {
  const SESSION = "turn-protect-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    // Small context to make overflow happen with fewer messages
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0); // zero overhead
    ensureProject(PROJECT);
  });

  test("all current-turn agentic steps are included in the compressed window", () => {
    // context=10000, output=2000, maxInput=8000, rawBudget ≈ 5600
    // Old messages: 40 × 600 chars ≈ 6000 tokens — exceeds rawBudget alone
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(`old-${i}`, i % 2 === 0 ? "user" : "assistant", "X".repeat(600), SESSION),
    );
    // Current turn: user + 4 agentic steps × 400 chars ≈ 450 tokens — must all be kept
    const currentUser = makeMsg("cur-user", "user", "do the thing", SESSION);
    const steps = Array.from({ length: 4 }, (_, i) =>
      makeStep(`step-${i}`, "cur-user", "tool result " + "Y".repeat(380), SESSION),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({ messages, projectPath: PROJECT, sessionID: SESSION });

    // Should be in gradient mode (too many messages to fit raw)
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // The current user message must be in the window
    const ids = result.messages.map((m) => m.info.id);
    expect(ids).toContain("cur-user");

    // All 4 steps must be in the window — none dropped
    for (let i = 0; i < 4; i++) {
      expect(ids).toContain(`step-${i}`);
    }
  });

  test("current turn steps are not evicted even when budget is tight", () => {
    // context=10000, output=2000, maxInput=8000, rawBudget ≈ 5600
    // Old messages: 50 × 600 chars ≈ 7500 tokens — way over budget alone
    // Current turn: user + 8 steps × 400 chars ≈ 850 tokens — must all be kept
    const oldMsgs = Array.from({ length: 50 }, (_, i) =>
      makeMsg(`tight-old-${i}`, i % 2 === 0 ? "user" : "assistant", "Z".repeat(600), SESSION),
    );
    const currentUser = makeMsg("tight-user", "user", "go", SESSION);
    const steps = Array.from({ length: 8 }, (_, i) =>
      makeStep(`tight-step-${i}`, "tight-user", "R".repeat(400), SESSION),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({ messages, projectPath: PROJECT, sessionID: SESSION });
    expect(result.layer).toBeGreaterThanOrEqual(1);

    const ids = result.messages.map((m) => m.info.id);
    // All 8 steps must be present
    for (let i = 0; i < 8; i++) {
      expect(ids).toContain(`tight-step-${i}`);
    }
    // Old messages should be partially evicted (some dropped to make room)
    const oldCount = ids.filter((id) => id.startsWith("tight-old-")).length;
    const totalOld = 50;
    expect(oldCount).toBeLessThan(totalOld);
  });

  test("current turn steps survive compression — never evicted", () => {
    // Verify that even when gradient fires and evicts old messages, all steps
    // in the current agentic turn are preserved as an atomic unit.
    // context=3000, output=500 → usable=2500, rawBudget=floor(2500*0.4)=1000
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

    const currentUser = makeMsg("huge-user", "user", "massive task", SESSION);
    // 8 steps × ~87 tokens (200 chars/3 + 20) = 696, + user 24 = 720 ≤ rawBudget(1000)
    const steps = Array.from({ length: 8 }, (_, i) =>
      makeStep(`huge-step-${i}`, "huge-user", "W".repeat(200), SESSION),
    );
    // 22 old messages to force gradient mode: 22 × 87 = 1914
    // Total = 1914 + 720 = 2634 > maxInput(2500) → gradient fires
    const oldMsgs = Array.from({ length: 22 }, (_, i) =>
      makeMsg(`huge-old-${i}`, i % 2 === 0 ? "user" : "assistant", "V".repeat(200), SESSION),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({ messages, projectPath: PROJECT, sessionID: SESSION });

    // Must be in gradient mode
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // Current turn steps must always be present regardless of layer
    const ids = result.messages.map((m) => m.info.id);
    for (let i = 0; i < 8; i++) {
      expect(ids).toContain(`huge-step-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Trailing-message-drop safety: tool-bearing steps must survive compression
// (index.ts fix: only drop pure-text trailing assistant messages, not tool ones)
// ---------------------------------------------------------------------------

// Helper: make an assistant step that has a completed tool call.
// These steps MUST NOT be dropped by index.ts's trailing-message-drop loop
// because their tool parts produce user-role tool_result messages at the
// Anthropic API level — so the conversation already ends with a user message.
function makeStepWithTool(
  id: string,
  parentUserID: string,
  toolName: string,
  toolOutput: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
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
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "completed",
          title: toolName,
          input: { command: "ls" },
          output: toolOutput,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as unknown as LorePart,
      {
        id: `step-finish-${id}`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "tool_use",
        cost: 0,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as LorePart,
    ],
  };
}

// ---------------------------------------------------------------------------
// sanitizeToolParts: pending/running tool parts → error state
// Prevents orphaned tool_use blocks (no matching tool_result) from reaching the
// Anthropic API. When a session errors mid-tool-execution, the tool part stays in
// pending/running state. sanitizeToolParts() converts these to error state so the
// SDK generates both tool_use + tool_result(is_error=true).
// ---------------------------------------------------------------------------

function makeStepWithPendingTool(
  id: string,
  parentUserID: string,
  toolName: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
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
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "pending",
          input: { command: "ls" },
          raw: '{"command": "ls"}',
        },
      } as unknown as LorePart,
    ],
  };
}

function makeStepWithRunningTool(
  id: string,
  parentUserID: string,
  toolName: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
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
  const startTime = Date.now() - 5000;
  return {
    info,
    parts: [
      {
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "running",
          input: { command: "build" },
          title: toolName,
          metadata: { cwd: "/test" },
          time: { start: startTime },
        },
      } as unknown as LorePart,
    ],
  };
}

describe("gradient — sanitizeToolParts (orphaned tool_use fix)", () => {
  const SESSION = "sanitize-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("no-op when all tool parts are completed — returns same array reference", () => {
    const msgs = [
      makeMsg("san-u1", "user", "build it", SESSION),
      makeStepWithTool("san-a1", "san-u1", "bash", "done", SESSION),
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    // Layer 0 for small session — messages should be the same reference
    expect(result.layer).toBe(0);
    // The tool part should still be completed
    const toolPart = result.messages[1]!.parts.find((p) => p.type === "tool")!;
    expect((toolPart as any).state.status).toBe("completed");
  });

  test("pending tool part is converted to error state", () => {
    const msgs = [
      makeMsg("san-u2", "user", "run something", SESSION),
      makeStepWithPendingTool("san-a2", "san-u2", "bash", SESSION),
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    const toolPart = result.messages[1]!.parts.find((p) => p.type === "tool")! as any;
    expect(toolPart.state.status).toBe("error");
    expect(toolPart.state.error).toBe("[tool execution interrupted — session recovered]");
    expect(toolPart.state.input).toEqual({ command: "ls" });
    // Pending has no time field — both start and end should be fabricated
    expect(typeof toolPart.state.time.start).toBe("number");
    expect(typeof toolPart.state.time.end).toBe("number");
  });

  test("running tool part is converted to error state, preserving time.start", () => {
    const msgs = [
      makeMsg("san-u3", "user", "build the project", SESSION),
      makeStepWithRunningTool("san-a3", "san-u3", "bash", SESSION),
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    const toolPart = result.messages[1]!.parts.find((p) => p.type === "tool")! as any;
    expect(toolPart.state.status).toBe("error");
    expect(toolPart.state.error).toBe("[tool execution interrupted — session recovered]");
    expect(toolPart.state.input).toEqual({ command: "build" });
    // Running has time.start — should be preserved
    expect(toolPart.state.time.start).toBeLessThan(Date.now());
    expect(toolPart.state.time.end).toBeGreaterThanOrEqual(toolPart.state.time.start);
    // Metadata from running state should be carried over
    expect(toolPart.state.metadata).toEqual({ cwd: "/test" });
  });

  test("mixed parts: text + completed tool + pending tool — only pending converted", () => {
    const msgs = [
      makeMsg("san-u4", "user", "do stuff", SESSION),
      {
        ...makeStepWithTool("san-a4", "san-u4", "bash", "first output", SESSION),
        parts: [
          // text part
          {
            id: "text-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "text",
            text: "Let me run two commands",
            time: { start: Date.now(), end: Date.now() },
          } as LorePart,
          // completed tool part
          {
            id: "tool-completed-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "tool",
            callID: "call-completed",
            tool: "bash",
            state: {
              status: "completed",
              title: "bash",
              input: { command: "ls" },
              output: "file1.ts file2.ts",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          } as unknown as LorePart,
          // pending tool part
          {
            id: "tool-pending-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { command: "cat file1.ts" },
              raw: '{"command": "cat file1.ts"}',
            },
          } as unknown as LorePart,
        ],
      },
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    const parts = result.messages[1]!.parts;
    // Text part unchanged
    const textPart = parts.find((p) => p.type === "text")!;
    expect((textPart as any).text).toBe("Let me run two commands");
    // Completed tool part unchanged
    const completedTool = parts.find(
      (p) => p.type === "tool" && (p as any).callID === "call-completed",
    )! as any;
    expect(completedTool.state.status).toBe("completed");
    expect(completedTool.state.output).toBe("file1.ts file2.ts");
    // Pending tool part → error
    const pendingTool = parts.find(
      (p) => p.type === "tool" && (p as any).callID === "call-pending",
    )! as any;
    expect(pendingTool.state.status).toBe("error");
    expect(pendingTool.state.error).toBe("[tool execution interrupted — session recovered]");
  });

  test("user messages are untouched", () => {
    const userMsg = makeMsg("san-u5", "user", "hello", SESSION);
    const msgs = [userMsg, makeStepWithPendingTool("san-a5", "san-u5", "bash", SESSION)];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    // User message should be the same object reference (not cloned)
    expect(result.messages[0]!.info.id).toBe("san-u5");
    expect(result.messages[0]!.parts[0]!.type).toBe("text");
  });

  test("multiple messages: only affected messages are cloned", () => {
    const msgs = [
      makeMsg("san-u6", "user", "first task", SESSION),
      makeStepWithTool("san-a6", "san-u6", "bash", "done", SESSION), // completed — untouched
      makeMsg("san-u7", "user", "second task", SESSION),
      makeStepWithPendingTool("san-a7", "san-u7", "edit", SESSION), // pending — converted
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    // Completed tool message untouched
    const completedMsg = result.messages.find((m) => m.info.id === "san-a6")!;
    const completedTool = completedMsg.parts.find((p) => p.type === "tool")! as any;
    expect(completedTool.state.status).toBe("completed");

    // Pending tool message converted
    const pendingMsg = result.messages.find((m) => m.info.id === "san-a7")!;
    const pendingTool = pendingMsg.parts.find((p) => p.type === "tool")! as any;
    expect(pendingTool.state.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Layer 0 trailing-drop: pure-text trailing assistant messages must be dropped
// even when gradient is not active (layer 0 passthrough). This is the fix for
// the "does not support assistant message prefill" error that recurred on small
// sessions. The hook in index.ts now runs the drop loop unconditionally, before
// the layer > 0 guard. At layer 0, result.messages === output.messages (same
// reference), so mutating it in place trims output.messages too.
// ---------------------------------------------------------------------------

describe("gradient — layer 0 trailing assistant message drop (index.ts prefill fix)", () => {
  const SESSION = "layer0-drop-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 200_000, output: 32_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("transform returns layer 0 for a small session ending with trailing assistant message", () => {
    // Tiny session — well within context budget, must be layer 0.
    const msgs = [
      makeMsg("l0-u1", "user", "hello", SESSION),
      makeMsg("l0-a1", "assistant", "hi there", SESSION),
      makeMsg("l0-u2", "user", "thanks", SESSION),
      makeMsg("l0-a2", "assistant", "no problem", SESSION), // trailing pure-text — prefill error
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    // Must be layer 0 — tiny messages easily fit
    expect(result.layer).toBe(0);

    // result.messages is the same reference as the input array at layer 0.
    // The hook's drop loop mutates this in place. Simulate what the hook does:
    while (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1]!;
      if (last.info.role === "user") break;
      const hasToolParts = last.parts.some((p) => p.type === "tool");
      if (hasToolParts) break;
      result.messages.pop();
    }

    // After drop: last message must be user-role
    const afterLast = result.messages[result.messages.length - 1]!;
    expect(afterLast.info.role).toBe("user");
    expect(afterLast.info.id).toBe("l0-u2");
    // And since result.messages === msgs at layer 0, msgs is also trimmed
    expect(msgs[msgs.length - 1]!.info.id).toBe("l0-u2");
  });

  test("tool-bearing trailing assistant message at layer 0 is preserved (no infinite tool loop)", () => {
    // Same tiny session, but last message has a tool part.
    // Must NOT be dropped — tool parts produce user-role tool_result at the API level.
    const msgs = [
      makeMsg("l0t-u1", "user", "run the build", SESSION),
      makeStepWithTool("l0t-a1", "l0t-u1", "bash", "ok", SESSION), // trailing tool-bearing
    ];

    const result = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });

    // Must be layer 0 — tiny messages
    expect(result.layer).toBe(0);

    // Simulate the hook's drop loop — must stop immediately at tool-bearing message
    const beforeLen = result.messages.length;
    while (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1]!;
      if (last.info.role === "user") break;
      const hasToolParts = last.parts.some((p) => p.type === "tool");
      if (hasToolParts) break;
      result.messages.pop();
    }

    // Nothing dropped — length unchanged
    expect(result.messages.length).toBe(beforeLen);
    expect(result.messages[result.messages.length - 1]!.info.id).toBe("l0t-a1");
  });
});

describe("gradient — tool-bearing steps survive compression (index.ts trailing-drop fix)", () => {
  const SESSION = "tool-drop-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("gradient output includes tool-bearing agentic steps (not dropped by tryFit)", () => {
    // Old messages: 40 × 400 chars — forces gradient mode
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(`td-old-${i}`, i % 2 === 0 ? "user" : "assistant", "X".repeat(400), SESSION),
    );
    // Current turn: user + 5 tool-bearing steps
    const currentUser = makeMsg("td-user", "user", "run the build", SESSION);
    const steps = Array.from({ length: 5 }, (_, i) =>
      makeStepWithTool(`td-step-${i}`, "td-user", "bash", "output ".repeat(30) + i, SESSION),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({ messages, projectPath: PROJECT, sessionID: SESSION });

    // Must be in gradient mode
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // All 5 tool-bearing steps must appear in gradient output.
    // If they're present here, index.ts's new 'hasToolParts' check preserves
    // them (tool parts → tool_result at API level → no prefill error).
    const ids = result.messages.map((m) => m.info.id);
    for (let i = 0; i < 5; i++) {
      expect(ids).toContain(`td-step-${i}`);
    }
  });

  test("tool-bearing trailing steps have tool parts in the gradient output", () => {
    // Verify the step messages in gradient output actually carry their tool parts
    // (not stripped), so index.ts can inspect them for the hasToolParts check.
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(`tp-old-${i}`, i % 2 === 0 ? "user" : "assistant", "Y".repeat(400), SESSION),
    );
    const currentUser = makeMsg("tp-user", "user", "do work", SESSION);
    const lastStep = makeStepWithTool("tp-step-last", "tp-user", "bash", "final output", SESSION);
    const messages = [...oldMsgs, currentUser, lastStep];

    const result = transform({ messages, projectPath: PROJECT, sessionID: SESSION });
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // The last step in the gradient output should retain its tool part
    const lastInResult = result.messages[result.messages.length - 1]!;
    expect(lastInResult.info.id).toBe("tp-step-last");
    const toolParts = lastInResult.parts.filter((p) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Calibration oscillation fix (Options C + B)
// ---------------------------------------------------------------------------

describe("gradient — calibration oscillation fix", () => {
  const SESSION = "osc-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    // Context: 10K, output: 2K → usable 8K, rawBudget ~3200, maxInput 8000
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("sticky layer: does not oscillate between layer 0 and layer 1 on consecutive steps", () => {
    // Build a session that is too large for layer 0.
    // 60 messages × 600 chars ≈ 60 × 150 tokens = 9000 tokens > maxInput (8000).
    // maxInput = 10000 - 2000 = 8000. The full session exceeds maxInput,
    // so gradient must activate.
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(`osc-${i}`, i % 2 === 0 ? "user" : "assistant", "A".repeat(600), SESSION),
    );
    // Add final user message to make it a proper conversation end
    msgs.push(makeMsg("osc-user-final", "user", "next step", SESSION));

    // First transform: should compress (layer >= 1)
    const r1 = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Simulate calibration: model saw the compressed window.
    // transform() already stored lastTransformEstimate, so calibrate() uses it.
    const compressedCount = r1.messages.length;
    const actualInput = estimateMessages(r1.messages); // approximate actual tokens
    calibrate(actualInput, SESSION, compressedCount);

    // Add one more message (one agentic step)
    const msgs2 = [...msgs, makeMsg("osc-step-1", "assistant", "working on it", SESSION)];

    // Second transform: sticky layer guard must prevent layer 0
    const r2 = transform({ messages: msgs2, projectPath: PROJECT, sessionID: SESSION });
    expect(r2.layer).toBeGreaterThanOrEqual(1);
    expect(getLastLayer(SESSION)).toBeGreaterThanOrEqual(1);
  });

  test("sticky layer: allows layer 0 re-entry after compaction shrinks message count", () => {
    // Same setup: force gradient mode (60 × 600 chars ≈ 9000 tokens > maxInput 8000)
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(`comp-${i}`, i % 2 === 0 ? "user" : "assistant", "B".repeat(600), SESSION),
    );
    msgs.push(makeMsg("comp-user-final", "user", "compact", SESSION));

    const r1 = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate from the compressed result
    const compressedCount = r1.messages.length;
    calibrate(estimateMessages(r1.messages), SESSION, compressedCount);

    // Simulate compaction: session now has only 3 messages (much smaller than lastKnownMessageCount)
    const postCompaction = [
      makeMsg("post-1", "user", "fresh start", SESSION),
      makeMsg("post-2", "assistant", "ready", SESSION),
      makeMsg("post-3", "user", "go", SESSION),
    ];

    // With fewer messages than lastKnownMessageCount, sticky guard is bypassed
    const r2 = transform({ messages: postCompaction, projectPath: PROJECT, sessionID: SESSION });
    // Should be layer 0 — 3 tiny messages easily fit
    expect(r2.layer).toBe(0);
  });

  test("ID-based delta: accurately counts new messages after compression", () => {
    // Build a large session (60 × 600 chars ≈ 9000 tokens > maxInput 8000)
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(`id-${i}`, i % 2 === 0 ? "user" : "assistant", "C".repeat(600), SESSION),
    );
    msgs.push(makeMsg("id-user-end", "user", "step", SESSION));

    const r1 = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate with the compressed window count.
    // transform() already stored lastTransformEstimate.
    const compressedCount = r1.messages.length;
    const actualInput = estimateMessages(r1.messages);
    calibrate(actualInput, SESSION, compressedCount);

    // Add one truly new message
    const newMsg = makeMsg("id-new-step", "assistant", "new work: " + "D".repeat(100), SESSION);
    const msgs2 = [...msgs, newMsg];

    // The delta should only include the one new message (id-new-step),
    // not the ~50 evicted messages. Sticky guard keeps us at layer >= 1,
    // so we don't oscillate to a passthrough that would send 300K tokens.
    const r2 = transform({ messages: msgs2, projectPath: PROJECT, sessionID: SESSION });
    expect(r2.layer).toBeGreaterThanOrEqual(1);

    // The new message must be in the output
    const ids2 = r2.messages.map((m) => m.info.id);
    expect(ids2).toContain("id-new-step");
  });

  test("layer 0 still works for genuinely small sessions", () => {
    // A fresh small session should always use layer 0 with no interference
    const msgs = [
      makeMsg("small-1", "user", "hello", SESSION),
      makeMsg("small-2", "assistant", "hi", SESSION),
      makeMsg("small-3", "user", "how are you", SESSION),
    ];
    const r = transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });
    expect(r.layer).toBe(0);
    expect(r.messages).toBe(msgs); // same reference — truly untouched
  });

  test("worker session transform does NOT reset main session sticky layer guard", () => {
    // Reproduces the root cause of calibration oscillation:
    // Before per-session state, a worker session (lore-distill/curator) calling
    // transform() would set module-level lastLayer=0, which reset the main session's
    // sticky layer guard. The main session then passed through at layer 0 (175K),
    // followed by compression at layer 1 (62K), oscillating indefinitely.
    //
    // With per-session state, worker transforms are isolated and cannot affect
    // the main session's state.
    const MAIN = "osc-sess";        // reuse the SESSION constant
    const WORKER = "worker-distill-sess";

    // Set up the main session in gradient mode: 60 large messages
    const mainMsgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(`main-${i}`, i % 2 === 0 ? "user" : "assistant", "A".repeat(600), MAIN),
    );
    mainMsgs.push(makeMsg("main-user-final", "user", "step 1", MAIN));

    // First main transform: gradient activates (layer >= 1)
    const r1 = transform({ messages: mainMsgs, projectPath: PROJECT, sessionID: MAIN });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate main session as compressed
    const actualInput = estimateMessages(r1.messages);
    calibrate(actualInput, MAIN, r1.messages.length);

    // WORKER SESSION: tiny messages → transform returns layer 0
    const workerMsgs = [
      makeMsg("w-1", "user", "distill this", WORKER),
      makeMsg("w-2", "assistant", "done", WORKER),
      makeMsg("w-3", "user", "ok", WORKER),
    ];
    const workerResult = transform({ messages: workerMsgs, projectPath: PROJECT, sessionID: WORKER });
    expect(workerResult.layer).toBe(0); // worker is small → layer 0

    // After worker transform, main session state must be unaffected.
    // The sticky layer guard must still fire for the main session.
    mainMsgs.push(makeMsg("main-step-2", "assistant", "doing work", MAIN));
    const r2 = transform({ messages: mainMsgs, projectPath: PROJECT, sessionID: MAIN });

    // Before the fix: worker's layer 0 reset module-level lastLayer=0,
    // so r2 would be layer 0 passthrough (sending all 175K tokens).
    // After the fix: per-session state — r2 must stay at layer >= 1.
    expect(r2.layer).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Content-aware deduplication tests
// ---------------------------------------------------------------------------

function makeMsgWithTool(
  id: string,
  role: "user" | "assistant",
  toolName: string,
  input: string,
  output: string,
  sessionID = "dedup-sess",
): LoreMessageWithParts {
  const base = makeMsg(id, role, "", sessionID);
  return {
    info: base.info,
    parts: [
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        tool: toolName,
        callID: `call-${id}`,
        title: toolName,
        state: {
          status: "completed" as const,
          input: JSON.parse(input) as { [key: string]: unknown },
          output,
          title: toolName,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
        time: { start: Date.now(), end: Date.now() },
      } as LorePart,
    ],
  };
}

/** Helper to extract output from a completed tool part. */
function getToolOutput(part: LorePart): string | undefined {
  if (isToolPart(part) && part.state.status === "completed") {
    return part.state.output;
  }
  return undefined;
}

describe("deduplicateToolOutputs", () => {
  const LARGE_CONTENT = "x".repeat(800); // above DEDUP_MIN_CHARS (600)

  test("deduplicates identical tool outputs, keeps latest", () => {
    const msgs = [
      makeMsg("u1", "user", "read file A"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"src/foo.ts"}', LARGE_CONTENT),
      makeMsg("u2", "user", "now edit"),
      makeMsg("a2", "assistant", "done editing"),
      makeMsg("u3", "user", "read file A again"),
      makeMsgWithTool("a3", "assistant", "read_file", '{"path":"src/foo.ts"}', LARGE_CONTENT),
      makeMsg("u4", "user", "looks good"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First read (index 1) should be deduplicated
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/foo.ts");

    // Latest read (index 5) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(LARGE_CONTENT);
  });

  test("deduplicates same-file reads with different content", () => {
    const oldContent = "old version " + "y".repeat(800);
    const newContent = "new version " + "z".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read file"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"src/bar.ts"}', oldContent),
      makeMsg("u2", "user", "edit it"),
      makeMsg("a2", "assistant", "edited"),
      makeMsg("u3", "user", "read it again"),
      makeMsgWithTool("a3", "assistant", "read_file", '{"path":"src/bar.ts"}', newContent),
      makeMsg("u4", "user", "verify"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First read (old content) should be replaced — same file, not latest
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/bar.ts");

    // Latest read (new content) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(newContent);
  });

  test("does not touch current turn messages", () => {
    const msgs = [
      makeMsg("u1", "user", "first"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"src/foo.ts"}', LARGE_CONTENT),
      makeMsg("u2", "user", "read again"), // current turn starts here (index 2)
      makeMsgWithTool("a2", "assistant", "read_file", '{"path":"src/foo.ts"}', LARGE_CONTENT),
    ];

    const result = deduplicateToolOutputs(msgs, 2);

    // Earlier read (index 1) should be deduped since latest is in current turn
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");

    // Current-turn read (index 3) should NOT be touched
    expect(getToolOutput(result[3].parts[0])).toBe(LARGE_CONTENT);
  });

  test("skips small outputs (below threshold)", () => {
    const smallContent = "short"; // well below DEDUP_MIN_CHARS
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"small.txt"}', smallContent),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool("a2", "assistant", "read_file", '{"path":"small.txt"}', smallContent),
      makeMsg("u3", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);

    // Both small outputs should be untouched
    expect(getToolOutput(result[1].parts[0])).toBe(smallContent);
    expect(getToolOutput(result[3].parts[0])).toBe(smallContent);
  });

  test("returns same array reference when no duplicates", () => {
    const msgs = [
      makeMsg("u1", "user", "hello"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"a.ts"}', LARGE_CONTENT),
      makeMsg("u2", "user", "read different"),
      makeMsgWithTool("a2", "assistant", "read_file", '{"path":"b.ts"}', "different " + LARGE_CONTENT),
      makeMsg("u3", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);
    expect(result).toBe(msgs); // same reference — no copy
  });

  test("deduplicates non-read tools by exact content hash", () => {
    const bashOutput = "npm test\n" + "PASS ".repeat(200); // large enough
    const msgs = [
      makeMsg("u1", "user", "run tests"),
      makeMsgWithTool("a1", "assistant", "bash", '{"command":"npm test"}', bashOutput),
      makeMsg("u2", "user", "run tests again"),
      makeMsgWithTool("a2", "assistant", "bash", '{"command":"npm test"}', bashOutput),
      makeMsg("u3", "user", "ok"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);

    // First bash (index 1) should be deduped — exact same output
    const firstOut = getToolOutput(result[1].parts[0])!;
    expect(firstOut).toContain("duplicate output");
    expect(firstOut).toContain("bash");

    // Latest bash (index 3) should be intact
    expect(getToolOutput(result[3].parts[0])).toBe(bashOutput);
  });

  test("handles three reads of the same file — only latest survives", () => {
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"path":"src/x.ts"}', LARGE_CONTENT),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool("a2", "assistant", "read_file", '{"path":"src/x.ts"}', LARGE_CONTENT),
      makeMsg("u3", "user", "read third time"),
      makeMsgWithTool("a3", "assistant", "read_file", '{"path":"src/x.ts"}', LARGE_CONTENT),
      makeMsg("u4", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First two reads should be deduped
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");
    expect(getToolOutput(result[3].parts[0])).toContain("earlier read");

    // Third (latest) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(LARGE_CONTENT);
  });
});

describe("laterReadCovers", () => {
  test("full-file covers full-file same path", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: undefined, limit: undefined },
      { path: "src/foo.ts", offset: undefined, limit: undefined },
    )).toBe(true);
  });

  test("full-file covers ranged read", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: undefined, limit: undefined },
      { path: "src/foo.ts", offset: 10, limit: 40 },
    )).toBe(true);
  });

  test("ranged read does NOT cover full-file", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 10, limit: 40 },
      { path: "src/foo.ts", offset: undefined, limit: undefined },
    )).toBe(false);
  });

  test("exact same range covers", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 10, limit: 50 },
      { path: "src/foo.ts", offset: 10, limit: 50 },
    )).toBe(true);
  });

  test("wider range covers narrower range", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 5, limit: 60 },
      { path: "src/foo.ts", offset: 10, limit: 40 },
    )).toBe(true);
  });

  test("narrower range does NOT cover wider range", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 10, limit: 40 },
      { path: "src/foo.ts", offset: 5, limit: 60 },
    )).toBe(false);
  });

  test("non-overlapping ranges do not cover", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 100, limit: 50 },
      { path: "src/foo.ts", offset: 1, limit: 50 },
    )).toBe(false);
  });

  test("different paths never cover", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: undefined, limit: undefined },
      { path: "src/bar.ts", offset: undefined, limit: undefined },
    )).toBe(false);
  });

  test("open-ended later covers bounded earlier with lower start", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 10, limit: undefined },
      { path: "src/foo.ts", offset: 20, limit: 30 },
    )).toBe(true);
  });

  test("bounded later does NOT cover open-ended earlier", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 10, limit: 50 },
      { path: "src/foo.ts", offset: 10, limit: undefined },
    )).toBe(false);
  });

  test("offset-only later covers offset-only earlier with lower start", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 5, limit: undefined },
      { path: "src/foo.ts", offset: 10, limit: undefined },
    )).toBe(true);
  });

  test("offset-only later does NOT cover earlier with lower start", () => {
    expect(laterReadCovers(
      { path: "src/foo.ts", offset: 20, limit: undefined },
      { path: "src/foo.ts", offset: 10, limit: undefined },
    )).toBe(false);
  });
});

describe("deduplicateToolOutputs — range-aware", () => {
  const LARGE_CONTENT = "x".repeat(800);

  test("full-file read covers earlier full-file read (baseline)", () => {
    const msgs = [
      makeMsg("u1", "user", "read file"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts"}', LARGE_CONTENT),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts"}', LARGE_CONTENT),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/foo.ts");
    expect(getToolOutput(result[3].parts[0])).toBe(LARGE_CONTENT);
  });

  test("full-file read covers earlier ranged read", () => {
    const rangedContent = "lines 10-50 content " + "y".repeat(800);
    const fullContent = "full file content " + "z".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read part of file"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":40}', rangedContent),
      makeMsg("u2", "user", "read full file"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts"}', fullContent),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Earlier ranged read should be deduped — full-file covers it
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/foo.ts");
    expect(getToolOutput(result[1].parts[0])).toContain("lines 10-49");
    // Full-file read should be intact
    expect(getToolOutput(result[3].parts[0])).toBe(fullContent);
  });

  test("ranged read does NOT cover earlier full-file read", () => {
    const fullContent = "full file content " + "y".repeat(800);
    const rangedContent = "lines 10-50 content " + "z".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read full file"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts"}', fullContent),
      makeMsg("u2", "user", "read part"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":40}', rangedContent),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Full-file read should NOT be deduped — narrow later read can't cover it
    expect(getToolOutput(result[1].parts[0])).toBe(fullContent);
    // Ranged read is latest for its range — kept
    expect(getToolOutput(result[3].parts[0])).toBe(rangedContent);
  });

  test("wider range covers narrower range", () => {
    const narrowContent = "narrow range " + "a".repeat(800);
    const wideContent = "wide range " + "b".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read narrow"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":20,"limit":30}', narrowContent),
      makeMsg("u2", "user", "read wider"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":60}', wideContent),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Narrow earlier read should be deduped — wider later covers it
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/foo.ts");
    // Wider read is latest — kept
    expect(getToolOutput(result[3].parts[0])).toBe(wideContent);
  });

  test("narrower range does NOT cover wider range", () => {
    const wideContent = "wide range " + "a".repeat(800);
    const narrowContent = "narrow range " + "b".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read wide"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":60}', wideContent),
      makeMsg("u2", "user", "read narrow"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts","offset":20,"limit":30}', narrowContent),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Wide earlier read should NOT be deduped — narrow later can't cover it
    expect(getToolOutput(result[1].parts[0])).toBe(wideContent);
    // Narrow read is kept
    expect(getToolOutput(result[3].parts[0])).toBe(narrowContent);
  });

  test("non-overlapping ranges both kept", () => {
    const contentA = "range A " + "a".repeat(800);
    const contentB = "range B " + "b".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read top"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":1,"limit":50}', contentA),
      makeMsg("u2", "user", "read bottom"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts","offset":100,"limit":50}', contentB),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Neither covers the other — both kept
    expect(getToolOutput(result[1].parts[0])).toBe(contentA);
    expect(getToolOutput(result[3].parts[0])).toBe(contentB);
  });

  test("annotation includes range info for ranged reads", () => {
    const content = "ranged " + "x".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read part"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":40}', content),
      makeMsg("u2", "user", "read full"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts"}', "full " + "y".repeat(800)),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    const annotation = getToolOutput(result[1].parts[0])!;
    expect(annotation).toContain("lines 10-49");
    expect(annotation).toContain("src/foo.ts");
  });

  test("content-hash dedup still works for non-read tools", () => {
    const bashOutput = "npm test\n" + "PASS ".repeat(200);
    const msgs = [
      makeMsg("u1", "user", "run tests"),
      makeMsgWithTool("a1", "assistant", "bash", '{"command":"npm test"}', bashOutput),
      makeMsg("u2", "user", "run again"),
      makeMsgWithTool("a2", "assistant", "bash", '{"command":"npm test"}', bashOutput),
      makeMsg("u3", "user", "ok"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain("duplicate output");
    expect(getToolOutput(result[3].parts[0])).toBe(bashOutput);
  });

  test("same exact ranged reads deduplicates", () => {
    const content = "exact range " + "x".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool("a1", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":50}', content),
      makeMsg("u2", "user", "read same range"),
      makeMsgWithTool("a2", "assistant", "read", '{"path":"src/foo.ts","offset":10,"limit":50}', content),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Earlier read deduped (both content hash and range match)
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");
    // Latest kept
    expect(getToolOutput(result[3].parts[0])).toBe(content);
  });

  test("read_file tool name works with ranges", () => {
    const content = "read_file content " + "x".repeat(800);
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool("a1", "assistant", "read_file", '{"filePath":"src/bar.ts","offset":5,"limit":20}', content),
      makeMsg("u2", "user", "read full"),
      makeMsgWithTool("a2", "assistant", "read_file", '{"filePath":"src/bar.ts"}', "full " + "y".repeat(800)),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read of src/bar.ts");
    expect(getToolOutput(result[1].parts[0])).toContain("lines 5-24");
  });
});

describe("onIdleResume", () => {
  const SID = "idle-resume-sess";
  const ONE_HOUR_MS = 60 * 60_000;

  beforeEach(() => {
    resetCalibration(SID);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("first turn — no lastTurnAt yet, never triggers", () => {
    const result = onIdleResume(SID, ONE_HOUR_MS);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state).not.toBeNull();
    expect(state!.cameOutOfIdle).toBe(false);
  });

  test("under threshold — does not trigger or reset caches", () => {
    // Seed a recent last-turn timestamp.
    const now = 1_000_000_000_000; // arbitrary epoch ms
    setLastTurnAtForTest(SID, now - 30 * 60_000); // 30 min ago
    // Run a transform first to populate prefix/raw caches (best effort).
    transform({
      messages: [
        {
          info: {
            id: "u1",
            sessionID: SID,
            role: "user",
            time: { created: now },
            agent: "build",
            model: { providerID: "anthropic", modelID: "x" },
          },
          parts: [
            {
              id: "p1",
              sessionID: SID,
              messageID: "u1",
              type: "text",
              text: "hi",
              time: { start: now, end: now },
            },
          ],
        },
      ],
      projectPath: PROJECT,
      sessionID: SID,
    });
    // Re-seed lastTurnAt (transform overwrote it to Date.now()).
    setLastTurnAtForTest(SID, now - 30 * 60_000);

    const result = onIdleResume(SID, ONE_HOUR_MS, now);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state!.cameOutOfIdle).toBe(false);
  });

  test("over threshold — triggers, resets caches, sets cameOutOfIdle", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS); // 2 hours ago

    // Force at least one cache to be populated so we can observe the reset.
    // We use the testing inspector path: directly induce state by calling
    // transform() so the prefix cache might populate. But for a deterministic
    // assertion we just check the post-call state — onIdleResume itself sets
    // them to null regardless of whether they were populated.
    const result = onIdleResume(SID, ONE_HOUR_MS, now);
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.idleMs).toBe(2 * ONE_HOUR_MS);
    }
    const state = inspectSessionState(SID);
    expect(state!.hasPrefixCache).toBe(false);
    expect(state!.hasRawWindowCache).toBe(false);
    expect(state!.cameOutOfIdle).toBe(true);
  });

  test("threshold of 0 disables the feature entirely", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 30 * 24 * 60 * 60_000); // 30 days ago
    const result = onIdleResume(SID, 0, now);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state!.cameOutOfIdle).toBe(false);
  });

  test("consumeCameOutOfIdle is one-shot", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS);
    onIdleResume(SID, ONE_HOUR_MS, now);
    expect(inspectSessionState(SID)!.cameOutOfIdle).toBe(true);

    expect(consumeCameOutOfIdle(SID)).toBe(true);
    expect(inspectSessionState(SID)!.cameOutOfIdle).toBe(false);

    // Second call returns false — flag was cleared.
    expect(consumeCameOutOfIdle(SID)).toBe(false);
  });

  test("consumeCameOutOfIdle on unknown session returns false", () => {
    expect(consumeCameOutOfIdle("never-existed-session")).toBe(false);
  });

  test("transform() updates lastTurnAt — subsequent calls see no idle gap", () => {
    const before = Date.now();
    transform({
      messages: [
        {
          info: {
            id: "u1",
            sessionID: SID,
            role: "user",
            time: { created: before },
            agent: "build",
            model: { providerID: "anthropic", modelID: "x" },
          },
          parts: [
            {
              id: "p1",
              sessionID: SID,
              messageID: "u1",
              type: "text",
              text: "hello world",
              time: { start: before, end: before },
            },
          ],
        },
      ],
      projectPath: PROJECT,
      sessionID: SID,
    });
    const state = inspectSessionState(SID);
    expect(state!.lastTurnAt).toBeGreaterThanOrEqual(before);
    // Without a real idle gap, onIdleResume should not trigger.
    const result = onIdleResume(SID, ONE_HOUR_MS);
    expect(result.triggered).toBe(false);
  });
});

describe("reasoning preservation (F-REASONING-AUDIT mini-pin)", () => {
  // Fast structural check — full coverage lives in gradient-reasoning.test.ts.
  // This guards against an accidental change to estimateParts/cleanParts that
  // would silently drop reasoning blocks across all gradient layers.
  test("layer 0 preserves reasoning parts unchanged", () => {
    const SID = "reasoning-mini-sess";
    resetCalibration(SID);
    setModelLimits({ context: 100_000, output: 4_000 });
    calibrate(0);

    const messages: LoreMessageWithParts[] = [
      makeMsg("rm-u1", "user", "Plan something."),
      {
        info: {
          id: "rm-a1",
          sessionID: SID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: "parent-rm-a1",
          modelID: "claude-opus-4-7",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 200,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "rm-r1",
            sessionID: SID,
            messageID: "rm-a1",
            type: "reasoning",
            text: "I should consider the trade-offs carefully here.",
            time: { start: Date.now(), end: Date.now() },
          } as LorePart,
          {
            id: "rm-t1",
            sessionID: SID,
            messageID: "rm-a1",
            type: "text",
            text: "Here is my plan.",
            time: { start: Date.now(), end: Date.now() },
          },
        ],
      },
    ];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    expect(result.layer).toBe(0);
    // Layer 0 returns the input array by reference
    expect(result.messages).toBe(messages);
    // Reasoning part still present, byte-identical
    const assistantParts = result.messages[1].parts;
    const reasoningPart = assistantParts.find((p) => p.type === "reasoning") as
      | { type: "reasoning"; text: string }
      | undefined;
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe(
      "I should consider the trade-offs carefully here.",
    );
  });
});
