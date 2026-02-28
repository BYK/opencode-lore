import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db, close, ensureProject, loadForceMinLayer } from "../src/db";
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
  calibrate(0); // zero overhead: no system prompt overhead in unit tests
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
    calibrate(0); // keep overhead at zero for this test
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);
    expect(result.messages.length).toBeLessThanOrEqual(6); // layer 4: up to 3 prefix + 3 raw
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
): { info: Message; parts: Part[] } {
  const info: Message = {
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
): { info: Message; parts: Part[] } {
  const info: Message = {
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
      } as Part,
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
      } as unknown as Part,
      {
        id: `step-finish-${id}`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "tool_use",
        cost: 0,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as Part,
    ],
  };
}

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
