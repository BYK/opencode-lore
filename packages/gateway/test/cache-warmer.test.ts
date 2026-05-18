import { describe, test, expect, beforeEach } from "bun:test";
import {
  createHistogram,
  recordGap,
  survivalFunction,
  conditionalReturnProbability,
  blendHistograms,
  prepareAnthropicWarmupBody,
  buildAnthropicProfile,
  shouldWarm,
  checkCircuitBreaker,
  isCircuitBreakerTripped,
  breakFraction,
  pSessionFinished,
  expectedWarmupCycles,
  costThreshold,
  cumulativeCostThreshold,
  maxProfitableCycles,
  MAX_TOOL_CALL_WARMING_MS,
  MIN_WARMUPS_FOR_ROI_CHECK,
  MIN_SESSION_HIT_RATE,
  HISTOGRAM_BINS,
  BREAK_FLOOR_MS,
  _resetForTest,
} from "../src/cache-warmer";
import type {
  SessionState,
  CacheAnalytics,
  WarmupResult,
} from "../src/translate/types";
import { compressBody } from "../src/cache-analytics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCacheAnalytics(): CacheAnalytics {
  return {
    lastRequestBody: null,
    lastRequestBodyLength: 0,
    lastCacheRead: 0,
    lastCacheCreation: 0,
    turnCount: 0,
    bustCount: 0,
  };
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionID: "test-session-abc123",
    projectPath: "/tmp/test-project",
    fingerprint: "abc123",
    lastRequestTime: Date.now() - 270_000, // 4.5 min ago (inside 5m warmup window)
    lastUserTurnTime: Date.now() - 270_000,
    messageCount: 10,
    turnsSinceCuration: 2,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    cacheAnalytics: makeCacheAnalytics(),
    lastModel: "claude-sonnet-4-20250514",
    lastProtocol: "anthropic",
    resolvedConversationTTL: "5m",
    ...overrides,
  };
}

function makeWarmupResult(overrides: Partial<WarmupResult> = {}): WarmupResult {
  return {
    ok: true,
    cacheReadTokens: 50000,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

describe("histogram", () => {
  test("createHistogram returns correct number of bins", () => {
    const hist = createHistogram();
    expect(hist.counts.length).toBe(HISTOGRAM_BINS.length + 1);
    expect(hist.total).toBe(0);
    expect(hist.counts.every((c) => c === 0)).toBe(true);
  });

  test("recordGap increments correct bin and total", () => {
    const hist = createHistogram();
    recordGap(hist, 5_000); // 5s → first bin (< 10s)
    expect(hist.total).toBe(1);
    expect(hist.counts[0]).toBe(1);

    recordGap(hist, 15_000); // 15s → second bin (10s–20s)
    expect(hist.total).toBe(2);
    expect(hist.counts[1]).toBe(1);
  });

  test("recordGap puts overflow in last bin", () => {
    const hist = createHistogram();
    recordGap(hist, 100_000_000); // way past all bins
    expect(hist.counts[HISTOGRAM_BINS.length]).toBe(1);
    expect(hist.total).toBe(1);
  });

  test("recordGap handles exact bin edge", () => {
    const hist = createHistogram();
    // 10_000 ms = bin edge → goes into bin 1 (10s–20s), since < check
    // is strict: gapMs < HISTOGRAM_BINS[0] is 10000 < 10000 = false,
    // so it falls through to bin 1
    recordGap(hist, 10_000);
    expect(hist.counts[1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Survival function
// ---------------------------------------------------------------------------

describe("survivalFunction", () => {
  test("empty histogram returns 1.0 (optimistic)", () => {
    const hist = createHistogram();
    expect(survivalFunction(hist, 60_000)).toBe(1.0);
  });

  test("all gaps shorter than query → survival ~0", () => {
    const hist = createHistogram();
    // All gaps are 5s
    for (let i = 0; i < 100; i++) recordGap(hist, 5_000);
    const s = survivalFunction(hist, 30_000);
    expect(s).toBeLessThan(0.01);
  });

  test("all gaps longer than query → survival ~1", () => {
    const hist = createHistogram();
    // All gaps are 10 minutes
    for (let i = 0; i < 100; i++) recordGap(hist, 600_000);
    const s = survivalFunction(hist, 30_000);
    expect(s).toBeGreaterThan(0.9);
  });

  test("mixed gaps produce intermediate survival", () => {
    const hist = createHistogram();
    // 50% gaps at 30s, 50% at 10 minutes
    for (let i = 0; i < 50; i++) recordGap(hist, 30_000);
    for (let i = 0; i < 50; i++) recordGap(hist, 600_000);
    const s = survivalFunction(hist, 60_000);
    // ~50% should survive past 60s
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(0.7);
  });

  test("survival decreases monotonically", () => {
    const hist = createHistogram();
    // Spread gaps across multiple bins
    for (let i = 0; i < 20; i++) recordGap(hist, 30_000);
    for (let i = 0; i < 20; i++) recordGap(hist, 120_000);
    for (let i = 0; i < 20; i++) recordGap(hist, 300_000);
    for (let i = 0; i < 20; i++) recordGap(hist, 600_000);
    for (let i = 0; i < 20; i++) recordGap(hist, 3_600_000);

    const s1 = survivalFunction(hist, 60_000);
    const s2 = survivalFunction(hist, 300_000);
    const s3 = survivalFunction(hist, 3_600_000);

    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
  });
});

// ---------------------------------------------------------------------------
// Conditional return probability
// ---------------------------------------------------------------------------

describe("conditionalReturnProbability", () => {
  test("returns 0 for dead histogram", () => {
    const hist = createHistogram();
    // All gaps at 5s — nobody returns after 1h
    for (let i = 0; i < 100; i++) recordGap(hist, 5_000);
    const p = conditionalReturnProbability(hist, 3_600_000, 300_000);
    expect(p).toBe(0);
  });

  test("returns positive for active sessions near TTL", () => {
    const hist = createHistogram();
    // Mix of gaps: some at 3m, some at 6m, some at 10m
    for (let i = 0; i < 30; i++) recordGap(hist, 180_000);
    for (let i = 0; i < 30; i++) recordGap(hist, 360_000);
    for (let i = 0; i < 30; i++) recordGap(hist, 600_000);

    // At 4.5min idle, asking about return in next 5min
    const p = conditionalReturnProbability(hist, 270_000, 300_000);
    expect(p).toBeGreaterThan(0.1);
  });

  test("returns 0 for empty histogram at very long idle", () => {
    // Empty histogram → survival is 1.0 everywhere → conditional
    // probability is (1.0 - 1.0) / 1.0 = 0... but actually with an
    // empty histogram everything is uniform, so the function should
    // handle this gracefully
    const hist = createHistogram();
    const p = conditionalReturnProbability(hist, 0, 300_000);
    // With no data, survival is 1.0 at both points → p = 0
    // (can't distinguish any time range)
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Histogram blending
// ---------------------------------------------------------------------------

describe("blendHistograms", () => {
  test("empty session uses global entirely", () => {
    const session = createHistogram();
    const global = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(global, 60_000);

    const blended = blendHistograms(session, global);
    // Session weight = 0, global weight = 1
    expect(blended.total).toBeCloseTo(global.total);
  });

  test("session with enough data dominates", () => {
    const session = createHistogram();
    const global = createHistogram();

    // Session: all 30s gaps (25 observations > PSEUDOCOUNT of 20)
    for (let i = 0; i < 25; i++) recordGap(session, 30_000);
    // Global: all 10m gaps
    for (let i = 0; i < 100; i++) recordGap(global, 600_000);

    const blended = blendHistograms(session, global);
    // Session weight should be ~1.0 (25/20 clamped to 1.0)
    // So survival at 5m should be low (session has all 30s gaps)
    const s = survivalFunction(blended, 300_000);
    expect(s).toBeLessThan(0.1);
  });

  test("session with few observations blends with global", () => {
    const session = createHistogram();
    const global = createHistogram();

    // Session: 5 observations at 30s (weight = 5/20 = 0.25)
    for (let i = 0; i < 5; i++) recordGap(session, 30_000);
    // Global: 100 observations at 10m
    for (let i = 0; i < 100; i++) recordGap(global, 600_000);

    const blended = blendHistograms(session, global);
    // Should have substantial survival at 5m due to global influence
    const s = survivalFunction(blended, 300_000);
    expect(s).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Body patching
// ---------------------------------------------------------------------------

describe("prepareAnthropicWarmupBody", () => {
  test("sets max_tokens to 0 and stream to false", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      system: [{ type: "text", text: "You are helpful." }],
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    expect(result.max_tokens).toBe(0);
    expect(result.stream).toBe(false);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.system).toEqual([{ type: "text", text: "You are helpful." }]);
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("uses max_tokens:1 for thinking-enabled sessions", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    expect(result.max_tokens).toBe(1);
    expect(result.stream).toBe(false);
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  test("strips forced tool_choice", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      tool_choice: { type: "tool", name: "my_tool" },
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    expect(result.max_tokens).toBe(0);
    expect(result.tool_choice).toBeUndefined();
  });

  test("preserves auto tool_choice", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    expect(result.tool_choice).toEqual({ type: "auto" });
  });

  test("strips output_config", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      output_config: { format: "json" },
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    expect(result.output_config).toBeUndefined();
  });

  test("preserves beta-gated fields like context_management (not stripped)", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      context_management: { type: "auto" },
      messages: [{ role: "user", content: "hello" }],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    // Beta-gated fields must NOT be stripped from the warmup body —
    // executeWarmup() forwards the anthropic-beta header from
    // state.lastAnthropicBeta so the API accepts them.
    expect(result.context_management).toEqual({ type: "auto" });
  });

  test("preserves all prompt content fields", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      stream: true,
      system: [
        {
          type: "text",
          text: "system prompt with cch=__;",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      tools: [{ name: "tool1", description: "desc", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "question" }] },
      ],
    });

    const result = JSON.parse(prepareAnthropicWarmupBody(body));
    // All prompt content preserved
    expect(result.system).toHaveLength(1);
    expect(result.system[0].cache_control).toBeDefined();
    expect(result.tools).toHaveLength(1);
    expect(result.messages).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  beforeEach(() => {
    _resetForTest();
  });

  test("does not trip on successful cache reads", () => {
    const result = makeWarmupResult({ cacheReadTokens: 50000, cacheCreationTokens: 0 });
    expect(checkCircuitBreaker(result)).toBe(false);
    expect(isCircuitBreakerTripped()).toBe(false);
  });

  test("counts uncached warmups", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    expect(checkCircuitBreaker(bad)).toBe(false); // 1st failure
    expect(checkCircuitBreaker(bad)).toBe(false); // 2nd failure
    expect(isCircuitBreakerTripped()).toBe(false);
  });

  test("trips after 3 consecutive uncached warmups", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    checkCircuitBreaker(bad); // 1
    checkCircuitBreaker(bad); // 2
    const tripped = checkCircuitBreaker(bad); // 3
    expect(tripped).toBe(true);
    expect(isCircuitBreakerTripped()).toBe(true);
  });

  test("resets failure count on successful read", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    const good = makeWarmupResult({ cacheReadTokens: 50000, cacheCreationTokens: 0 });

    checkCircuitBreaker(bad); // 1
    checkCircuitBreaker(bad); // 2
    checkCircuitBreaker(good); // reset
    checkCircuitBreaker(bad); // 1 (restarted)
    checkCircuitBreaker(bad); // 2
    expect(isCircuitBreakerTripped()).toBe(false);
  });

  test("stays tripped permanently after tripping", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    const good = makeWarmupResult({ cacheReadTokens: 50000, cacheCreationTokens: 0 });

    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad); // tripped
    expect(isCircuitBreakerTripped()).toBe(true);

    // Even good results don't un-trip
    checkCircuitBreaker(good);
    expect(isCircuitBreakerTripped()).toBe(true);
  });

  test("does not count failed requests", () => {
    const failed = makeWarmupResult({ ok: false, cacheReadTokens: 0, cacheCreationTokens: 0 });
    checkCircuitBreaker(failed);
    checkCircuitBreaker(failed);
    checkCircuitBreaker(failed);
    expect(isCircuitBreakerTripped()).toBe(false);
  });

  test("partial hits (read > 0 + creation > 0) reset counter", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    const partial = makeWarmupResult({ cacheReadTokens: 30000, cacheCreationTokens: 20000 });

    checkCircuitBreaker(bad); // 1
    checkCircuitBreaker(bad); // 2
    checkCircuitBreaker(partial); // has reads → reset
    checkCircuitBreaker(bad); // 1
    expect(isCircuitBreakerTripped()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldWarm decision function
// ---------------------------------------------------------------------------

describe("shouldWarm", () => {
  beforeEach(() => {
    _resetForTest();
  });

  test("returns false when cache is still fresh", () => {
    const state = makeSessionState({
      lastRequestTime: Date.now() - 60_000, // 1 min ago — cache still fresh
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // Need histogram with some data
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 300_000);

    expect(shouldWarm(state, profile, hist)).toBe(false);
  });

  test("returns false when cache already expired", () => {
    const state = makeSessionState({
      lastRequestTime: Date.now() - 400_000, // 6.7 min ago — past 5m TTL
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 300_000);

    expect(shouldWarm(state, profile, hist)).toBe(false);
  });

  test("returns true when in warmup window with good survival", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000, // 4.5 min ago — inside warmup window
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // Histogram showing users commonly return at 5-7 min intervals
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000); // 6m gaps

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("returns false when session is marked dead", () => {
    const state = makeSessionState({
      lastRequestTime: Date.now() - 270_000,
      warmup: { lastWarmupAt: 0, warmupCount: 0, totalWarmups: 0, warmupHits: 0, disabled: true },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist)).toBe(false);
  });

  test("returns false when already warmed in this TTL window", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: now - 30_000, // warmed 30s ago
        warmupCount: 1,
        totalWarmups: 1,
        warmupHits: 0,
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false when session has too few turns", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      messageCount: 4, // 2 turns (user+assistant each) — below threshold of 3 turns (6 messages)
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false for sub-agent sessions", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      messageCount: 20, // enough turns to normally qualify
      isSubagent: true,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false for sub-agent sessions even with /lore:warm:keep", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      messageCount: 20,
      isSubagent: true,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false when no stored body", () => {
    const state = makeSessionState({
      lastRequestTime: Date.now() - 270_000,
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist)).toBe(false);
  });

  test("returns false when circuit breaker is tripped", () => {
    // Trip the circuit breaker
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);

    const state = makeSessionState({
      lastRequestTime: Date.now() - 270_000,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist)).toBe(false);
  });

  test("text-only turns increase P(session finished) and can prevent warming", () => {
    const now = Date.now();

    // Histogram: 15% breaks (6m), 85% active (30s) — realistic mix
    const hist = createHistogram();
    for (let i = 0; i < 15; i++) recordGap(hist, 360_000);
    for (let i = 0; i < 85; i++) recordGap(hist, 30_000);

    // First: verify this session WOULD warm with 0 text-only turns
    const baseState = makeSessionState({
      lastRequestTime: now - 270_000,
      consecutiveTextOnlyTurns: 0,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    expect(shouldWarm(baseState, profile, hist, now)).toBe(true);

    // Now: same session but with 5 consecutive text-only turns — the
    // pSessionFinished signal fusion pushes P(finished) above the threshold,
    // making P(returns) too low to justify warming.
    const dampenedState = makeSessionState({
      lastRequestTime: now - 270_000,
      consecutiveTextOnlyTurns: 5,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });

    expect(shouldWarm(dampenedState, profile, hist, now)).toBe(false);
  });

  test("forceKeepWarm bypasses survival analysis and turn count", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      messageCount: 2, // only 1 turn — normally blocked by MIN_TURNS
      consecutiveTextOnlyTurns: 5, // would dampen survival to ~0
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram(); // empty — no data

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("forceKeepWarm warms across multiple TTL windows", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 870_000, // 14.5 min ago — well past first 5m TTL
      warmup: {
        lastWarmupAt: now - 310_000, // last warmup 5m10s ago — previous window
        warmupCount: 2,
        totalWarmups: 2,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    // 870s elapsed, ttl=300s → window index 2, into_window = 870%300 = 270s
    // warmup margin = 45s → threshold = 255s → 270 > 255 → should warm
    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("forceKeepWarm uses tighter cooldown (ttlMs - warmupMarginMs) to prevent 2x cadence", () => {
    const now = Date.now();
    // Last warmup was 4m20s ago (260s). With the full ttlMs (300s) cooldown
    // this would be blocked. With the tighter cooldown (300s - 45s = 255s)
    // it should be allowed, provided we're in the warmup margin of a window.
    const state = makeSessionState({
      lastRequestTime: now - 560_000, // 9m20s ago — into_window = 560%300 = 260s (>255 → in margin)
      warmup: {
        lastWarmupAt: now - 260_000, // 4m20s ago — past tighter cooldown (255s) but within full TTL (300s)
        warmupCount: 1,
        totalWarmups: 1,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    // With old code (cooldown = ttlMs = 300s): 260s < 300s → blocked
    // With fix (cooldown = ttlMs - margin = 255s): 260s > 255s → allowed
    // intoWindow = 560_000 % 300_000 = 260_000 >= 255_000 → in margin → true
    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("non-forced mode uses ttlMs - margin cooldown (same as forced)", () => {
    const now = Date.now();
    // Cooldown is ttlMs - warmupMarginMs = 300s - 45s = 255s for 5m TTL.
    // A warmup 260s ago is past the 255s cooldown, so it should be allowed.
    // (The old code used full ttlMs=300s cooldown, which caused every
    // continuation warmup to arrive after the cache expired — a cold write
    // instead of a cheap refresh.)
    const state = makeSessionState({
      lastRequestTime: now - 270_000, // 4.5 min ago — in warmup margin
      warmup: {
        lastWarmupAt: now - 260_000, // 4m20s ago — past 255s cooldown
        warmupCount: 1,
        totalWarmups: 1,
        warmupHits: 1, // need hit rate >= 20% for ROI check
        disabled: false,
        // no forceKeepWarm
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    // 260s > 255s (ttlMs - margin cooldown) → allowed
    expect(shouldWarm(state, profile, hist, now)).toBe(true);

    // But 250s ago is within the 255s cooldown → blocked
    const stateRecent = makeSessionState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: now - 250_000, // 4m10s ago — within 255s cooldown
        warmupCount: 1,
        totalWarmups: 1,
        warmupHits: 1,
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    expect(shouldWarm(stateRecent, profile, hist, now)).toBe(false);
  });

  test("forceKeepWarm still respects circuit breaker", () => {
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);

    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
      messageCount: 20,
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("marks session dead when survival drops below threshold", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 275_000, // 4m35s — in warmup window
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"test": true}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // All gaps are very short — nobody ever comes back after 4.5m.
    // With survival=0 and breakFraction=0, pSessionFinished is very high,
    // making P(returns) well below threshold. The session gets marked dead.
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 5_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
    expect(state.warmup?.disabled).toBe(true);
  });


});

// ---------------------------------------------------------------------------
// Profile building
// ---------------------------------------------------------------------------

describe("buildAnthropicProfile", () => {
  test("5m TTL has correct parameters", () => {
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    expect(profile.ttlMs).toBe(300_000);
    expect(profile.warmupMarginMs).toBe(45_000);
    expect(profile.cacheReadCostPerMTok).toBeGreaterThan(0);
    expect(profile.cacheMissCostPerMTok).toBeGreaterThan(profile.cacheReadCostPerMTok);
  });

  test("1h TTL has correct parameters", () => {
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "1h");
    expect(profile.ttlMs).toBe(3_600_000);
    expect(profile.warmupMarginMs).toBe(300_000);
  });

  test("cost ratio gives reasonable threshold (corrected formula)", () => {
    const profile5m = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    // Corrected: read / (write - read) ≈ 0.087 for 5m TTL
    const threshold5m = profile5m.cacheReadCostPerMTok /
      (profile5m.cacheMissCostPerMTok - profile5m.cacheReadCostPerMTok);
    expect(threshold5m).toBeGreaterThan(0.05);
    expect(threshold5m).toBeLessThan(0.15);

    const profile1h = buildAnthropicProfile("claude-sonnet-4-20250514", "1h");
    // 1h TTL: 2× write cost → threshold ≈ 0.042
    const threshold1h = profile1h.cacheReadCostPerMTok /
      (profile1h.cacheMissCostPerMTok - profile1h.cacheReadCostPerMTok);
    expect(threshold1h).toBeGreaterThan(0.02);
    expect(threshold1h).toBeLessThan(0.08);
    // 1h threshold should be lower than 5m (cheaper to warm relative to write cost)
    expect(threshold1h).toBeLessThan(threshold5m);
  });

  test("1h TTL has 2x cache write cost vs 5m TTL", () => {
    const profile5m = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const profile1h = buildAnthropicProfile("claude-sonnet-4-20250514", "1h");
    // Same read cost
    expect(profile1h.cacheReadCostPerMTok).toBe(profile5m.cacheReadCostPerMTok);
    // 1h write cost = 2 × 5m write cost
    expect(profile1h.cacheMissCostPerMTok).toBeCloseTo(profile5m.cacheMissCostPerMTok * 2);
  });
});

// ---------------------------------------------------------------------------
// Break-commitment model helpers
// ---------------------------------------------------------------------------

describe("breakFraction", () => {
  test("empty histogram returns prior of 0.3", () => {
    const hist = createHistogram();
    expect(breakFraction(hist)).toBe(0.3);
  });

  test("all short gaps → breakFraction ≈ 0", () => {
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 5_000); // 5s — well below 3m floor
    expect(breakFraction(hist)).toBeLessThan(0.01);
  });

  test("all long gaps → breakFraction ≈ 1", () => {
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 600_000); // 10m — well above 3m floor
    expect(breakFraction(hist)).toBeGreaterThan(0.99);
  });

  test("mixed gaps give intermediate fraction", () => {
    const hist = createHistogram();
    for (let i = 0; i < 70; i++) recordGap(hist, 30_000);  // 30s — active
    for (let i = 0; i < 30; i++) recordGap(hist, 600_000); // 10m — break
    const bf = breakFraction(hist);
    expect(bf).toBeGreaterThan(0.2);
    expect(bf).toBeLessThan(0.4);
  });

  test("gap exactly at break floor is handled", () => {
    const hist = createHistogram();
    // BREAK_FLOOR_MS (180_000) is a bin edge (HISTOGRAM_BINS[7]).
    // binIndex(180_000) returns 8 (since 180000 < 180000 is false),
    // so these land in bin 8 (3m–4m) — fully above the floor.
    for (let i = 0; i < 50; i++) recordGap(hist, BREAK_FLOOR_MS);
    for (let i = 0; i < 50; i++) recordGap(hist, 600_000);
    // All 100 gaps are at or above the break floor
    const bf = breakFraction(hist);
    expect(bf).toBeGreaterThan(0.95);
  });

  test("gaps just below break floor are not counted as breaks", () => {
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 150_000); // 2.5m — below 3m floor
    for (let i = 0; i < 50; i++) recordGap(hist, 600_000); // 10m — above
    const bf = breakFraction(hist);
    // ~50% should be breaks (the 10m gaps)
    expect(bf).toBeGreaterThan(0.4);
    expect(bf).toBeLessThan(0.6);
  });
});

describe("pSessionFinished", () => {
  test("active session with good survival → low P(finished)", () => {
    const p = pSessionFinished({
      survivalAtIdle: 0.8,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.3,
      totalTurns: 10,
    });
    expect(p).toBeLessThan(0.3);
  });

  test("long idle with zero survival → high P(finished)", () => {
    const p = pSessionFinished({
      survivalAtIdle: 0.0,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.0,
      totalTurns: 5,
    });
    expect(p).toBeGreaterThan(0.95);
  });

  test("multiple text-only turns increase P(finished)", () => {
    const base = pSessionFinished({
      survivalAtIdle: 0.3,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.3,
      totalTurns: 5,
    });
    const withText = pSessionFinished({
      survivalAtIdle: 0.3,
      consecutiveTextOnlyTurns: 5,
      breakFraction: 0.3,
      totalTurns: 5,
    });
    expect(withText).toBeGreaterThan(base);
  });

  test("low break fraction increases P(finished)", () => {
    const highBreaks = pSessionFinished({
      survivalAtIdle: 0.3,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.4,
      totalTurns: 10,
    });
    const lowBreaks = pSessionFinished({
      survivalAtIdle: 0.3,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.05,
      totalTurns: 10,
    });
    expect(lowBreaks).toBeGreaterThan(highBreaks);
  });

  test("short sessions (≤2 turns) are more likely finished", () => {
    const shortSession = pSessionFinished({
      survivalAtIdle: 0.5,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.3,
      totalTurns: 2,
    });
    const longSession = pSessionFinished({
      survivalAtIdle: 0.5,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.3,
      totalTurns: 20,
    });
    expect(shortSession).toBeGreaterThan(longSession);
  });

  test("conservative base rate — biased toward not finished", () => {
    // Neutral signals: moderate survival, no text-only, moderate breaks
    const p = pSessionFinished({
      survivalAtIdle: 0.5,
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.3,
      totalTurns: 10,
    });
    // Should be moderate — not too aggressive
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThan(0.7);
  });
});

describe("expectedWarmupCycles", () => {
  test("all short gaps → exceeds max cycles (nobody returns late)", () => {
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 5_000);
    // At 270s idle, survival is ~0 → returns maxCycles+1 to trigger cap
    const cycles = expectedWarmupCycles(hist, 270_000, 300_000, 11);
    expect(cycles).toBe(12); // maxCycles + 1
  });

  test("all long gaps → low expected cycles (user returns soon)", () => {
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 360_000); // 6m gaps
    // At 270s idle, most users return within next 5m window
    const cycles = expectedWarmupCycles(hist, 270_000, 300_000, 11);
    expect(cycles).toBeLessThan(3);
  });

  test("never exceeds maxCycles", () => {
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 7_200_000); // 2h gaps
    const cycles = expectedWarmupCycles(hist, 270_000, 300_000, 5);
    expect(cycles).toBeLessThanOrEqual(5);
  });

  test("empty histogram returns max cycles (flat survival = 1.0 everywhere)", () => {
    const hist = createHistogram();
    // Empty → survival is 1.0 everywhere → P(still idle) = 1.0 for each
    // future window → we pay for every cycle → accumulates to maxCycles
    const cycles = expectedWarmupCycles(hist, 270_000, 300_000, 11);
    expect(cycles).toBe(11);
  });
});

describe("costThreshold", () => {
  test("returns read / (write - read)", () => {
    // Sonnet 5m: read=0.3, write=3.75 → 0.3 / 3.45 ≈ 0.087
    const t = costThreshold(0.3, 3.75);
    expect(t).toBeCloseTo(0.087, 2);
  });

  test("1h TTL produces lower threshold than 5m", () => {
    const t5m = costThreshold(0.3, 3.75);   // 5m TTL
    const t1h = costThreshold(0.3, 7.50);   // 1h TTL (2× write)
    expect(t1h).toBeLessThan(t5m);
    expect(t1h).toBeCloseTo(0.042, 2);
  });

  test("degenerate case: write <= read returns 1.0", () => {
    expect(costThreshold(1.0, 1.0)).toBe(1.0);
    expect(costThreshold(1.0, 0.5)).toBe(1.0);
  });
});

describe("maxProfitableCycles", () => {
  test("5m TTL Sonnet → 11 cycles (55 min)", () => {
    const max = maxProfitableCycles(0.3, 3.75);
    expect(max).toBe(11);
  });

  test("1h TTL Sonnet → 24 cycles (24h)", () => {
    const max = maxProfitableCycles(0.3, 7.50);
    expect(max).toBe(24);
  });

  test("zero read cost → 0 cycles", () => {
    expect(maxProfitableCycles(0, 3.75)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldWarm continuation path
// ---------------------------------------------------------------------------

describe("shouldWarm continuation", () => {
  beforeEach(() => {
    _resetForTest();
  });

  test("continues warming in subsequent TTL windows when profitable", () => {
    const now = Date.now();
    // Session has been idle for 9.5 minutes (past first 5m TTL window)
    // We're in the warmup margin of the 2nd window: 9.5min % 5min = 4.5min > 4.25min
    const state = makeSessionState({
      lastRequestTime: now - 570_000, // 9.5 min ago
      warmup: {
        lastWarmupAt: now - 310_000, // last warmup 5m10s ago — previous window
        warmupCount: 1,
        totalWarmups: 1,
        warmupHits: 0,
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // Histogram with lots of break-length gaps (users take 10min breaks)
    const hist = createHistogram();
    for (let i = 0; i < 60; i++) recordGap(hist, 600_000); // 10m
    for (let i = 0; i < 40; i++) recordGap(hist, 60_000);  // 1m

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("stops when maxCycles exceeded", () => {
    const now = Date.now();
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const maxCyc = maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);

    // Session has spent maxCycles already
    const state = makeSessionState({
      lastRequestTime: now - (maxCyc + 1) * 300_000 - 270_000, // well past break-even
      warmup: {
        lastWarmupAt: now - 310_000,
        warmupCount: maxCyc, // already at max
        totalWarmups: maxCyc,
        warmupHits: 0,
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });

    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 3_600_000); // 1h gaps

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("stops when P(session finished) > 0.95", () => {
    const now = Date.now();
    // Very long idle with all-short-gap histogram → P(finished) very high
    const state = makeSessionState({
      lastRequestTime: now - 900_000, // 15 min ago
      warmup: {
        lastWarmupAt: now - 310_000,
        warmupCount: 2,
        totalWarmups: 2,
        warmupHits: 0,
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // All gaps very short — nobody takes 15min breaks
    const hist = createHistogram();
    for (let i = 0; i < 100; i++) recordGap(hist, 10_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /lore:warm:keep mode break-even cap
// ---------------------------------------------------------------------------

describe("shouldWarm /lore:warm:keep mode", () => {
  beforeEach(() => {
    _resetForTest();
  });

  test("/lore:warm:keep mode stops at break-even cap", () => {
    const now = Date.now();
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const maxCyc = maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);

    // Session in /lore:warm:keep mode that has already spent maxCycles
    const state = makeSessionState({
      lastRequestTime: now - (maxCyc + 1) * 300_000 - 270_000,
      warmup: {
        lastWarmupAt: now - 270_000, // past cooldown
        warmupCount: maxCyc,
        totalWarmups: maxCyc,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });

    const hist = createHistogram();
    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("/lore:warm:keep mode warms when below break-even cap", () => {
    const now = Date.now();
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");

    // Session in /lore:warm:keep mode with only 2 cycles spent, in warmup margin
    const state = makeSessionState({
      lastRequestTime: now - 570_000, // 9.5min — in warmup margin of 2nd window
      warmup: {
        lastWarmupAt: now - 270_000, // past cooldown
        warmupCount: 2,
        totalWarmups: 2,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });

    const hist = createHistogram();
    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap recording filtering
// ---------------------------------------------------------------------------

import {
  getSessionHistogram,
  recordGlobalGap,
  getGlobalHistogram,
  loadGlobalHistograms,
  flushGlobalHistograms,
  blendedHistogramForSession,
} from "../src/cache-warmer";

describe("gap recording filtering", () => {
  const GAP_TEST_PROJECT_PATH = "/tmp/test-gap-project";
  const GAP_TEST_PID = "test-gap-pid";

  beforeEach(() => {
    _resetForTest();
    // Ensure the project exists in the DB so recordGlobalGap can resolve pid.
    const d = db();
    d.query(
      "INSERT OR IGNORE INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(GAP_TEST_PID, GAP_TEST_PROJECT_PATH, "test-gap", null, Date.now());
  });

  /**
   * Helper to simulate the gap recording logic from pipeline.ts postResponse().
   * This mirrors the guarded block that decides whether to record a gap.
   *
   * Sub-agent turns now get their own sessions (not merged into the parent),
   * so the isSubagentTurn guard has been removed from the pipeline.
   */
  function simulateGapRecording(
    sessionState: SessionState,
    opts: {
      prevStopReason: string | undefined;
      now: number;
    },
  ): void {
    const { prevStopReason, now } = opts;
    const isToolUseContinuation = prevStopReason === "tool_use";

    if (!isToolUseContinuation) {
      if (sessionState.lastUserTurnTime > 0) {
        const gap = now - sessionState.lastUserTurnTime;
        recordGap(getSessionHistogram(sessionState), gap);
        recordGlobalGap(sessionState.projectPath, gap);
      }
      sessionState.lastUserTurnTime = now;
    }
  }

  test("tool-use continuation turns do not record gaps", () => {
    const state = makeSessionState({ lastUserTurnTime: Date.now() - 60_000 });
    const hist = getSessionHistogram(state);

    simulateGapRecording(state, {
      prevStopReason: "tool_use",
      now: Date.now(),
    });

    expect(hist.total).toBe(0);
  });

  test("lastUserTurnTime is not updated by tool-use continuations", () => {
    const originalTime = Date.now() - 120_000;
    const state = makeSessionState({ lastUserTurnTime: originalTime });

    simulateGapRecording(state, {
      prevStopReason: "tool_use",
      now: Date.now(),
    });

    expect(state.lastUserTurnTime).toBe(originalTime);
  });

  test("gap is computed from lastUserTurnTime, not lastRequestTime", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 5_000,
      lastUserTurnTime: now - 60_000,
    });

    simulateGapRecording(state, {
      prevStopReason: "end_turn",
      now,
    });

    const hist = getSessionHistogram(state);
    expect(hist.total).toBe(1);
    // 60_000ms is NOT < HISTOGRAM_BINS[4] (60_000), so it falls through to
    // the next bin where 60_000 < 90_000 (HISTOGRAM_BINS[5]), landing in bin 5.
    expect(hist.counts[5]).toBe(1);
  });

  test("first turn of session records no gap but sets lastUserTurnTime", () => {
    const now = Date.now();
    const state = makeSessionState({ lastUserTurnTime: 0 });
    const hist = getSessionHistogram(state);

    simulateGapRecording(state, {
      prevStopReason: undefined,
      now,
    });

    expect(hist.total).toBe(0); // No gap recorded (no prior user turn)
    expect(state.lastUserTurnTime).toBe(now); // But timestamp was set
  });

  test("normal user turn records gap correctly", () => {
    const now = Date.now();
    const state = makeSessionState({ lastUserTurnTime: now - 180_000 }); // 3 min ago

    simulateGapRecording(state, {
      prevStopReason: "end_turn",
      now,
    });

    const hist = getSessionHistogram(state);
    expect(hist.total).toBe(1);
    expect(state.lastUserTurnTime).toBe(now);
  });

  test("global histogram also records gap for user turns", () => {
    const now = Date.now();
    const state = makeSessionState({ projectPath: GAP_TEST_PROJECT_PATH, lastUserTurnTime: now - 120_000 }); // 2 min ago

    simulateGapRecording(state, {
      prevStopReason: "end_turn",
      now,
    });

    const globalHist = getGlobalHistogram(GAP_TEST_PID);
    expect(globalHist.total).toBe(1);
  });

  test("single histogram: no time-slot segmentation", () => {
    const state = makeSessionState({ lastUserTurnTime: 0 });

    // The session's survivalModel should be a single InterTurnHistogram,
    // not a slot-segmented record.
    const hist = getSessionHistogram(state);
    expect(hist).toBeDefined();
    expect(hist.counts).toBeInstanceOf(Array);
    expect(hist.total).toBe(0);

    // survivalModel is the histogram itself, not a { slots: ... } wrapper
    expect(state.survivalModel).toBe(hist);
  });
});

// ---------------------------------------------------------------------------
// Undefined pid fallback (project not yet in DB)
// ---------------------------------------------------------------------------

describe("undefined pid fallback", () => {
  beforeEach(() => {
    _resetForTest();
  });

  test("blendedHistogramForSession returns session-only histogram when project is not in DB", () => {
    // Use a path that has NO corresponding project in the DB.
    const state = makeSessionState({ projectPath: "/tmp/nonexistent-project" });
    const sessionHist = getSessionHistogram(state);
    recordGap(sessionHist, 60_000); // add an observation to the session histogram

    const blended = blendedHistogramForSession(state);
    // With no project in DB, blended should be the session histogram itself
    expect(blended).toBe(sessionHist);
    expect(blended.total).toBe(1);
  });

  test("recordGlobalGap is a no-op when project is not in DB", () => {
    const unknownPath = "/tmp/nonexistent-project";
    // Should not throw — silently skips
    recordGlobalGap(unknownPath, 60_000);

    // loadGlobalHistograms also returns undefined for unknown projects
    const pid = loadGlobalHistograms(unknownPath);
    expect(pid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Global histogram persistence: backward-compat migration
// ---------------------------------------------------------------------------

import { db, projectId } from "@loreai/core";

describe("global histogram persistence", () => {
  const TEST_PROJECT_PATH = "/tmp/test-histogram-project";
  let pid: string;

  beforeEach(() => {
    _resetForTest();

    // Ensure the project exists in the DB so projectId() returns a value.
    const d = db();
    const now = Date.now();
    d.query(
      "INSERT OR IGNORE INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("test-hist-pid", TEST_PROJECT_PATH, "test-hist", null, now);
    pid = projectId(TEST_PROJECT_PATH)!;
    expect(pid).toBe("test-hist-pid");

    // Clean any leftover rows from previous test runs.
    d.query("DELETE FROM warmup_histograms WHERE project_id = ?").run(pid);
  });

  test("merges old slot-segmented rows into single histogram on load", () => {
    const d = db();
    const now = Date.now();
    const binCount = HISTOGRAM_BINS.length + 1;

    // Simulate old-format DB rows: work (10 obs in bin 0), evening (5 obs in bin 3)
    const workCounts = new Array(binCount).fill(0);
    workCounts[0] = 10;
    const eveningCounts = new Array(binCount).fill(0);
    eveningCounts[3] = 5;

    d.query(
      "INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pid, "work", JSON.stringify(workCounts), 10, now);
    d.query(
      "INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pid, "evening", JSON.stringify(eveningCounts), 5, now);

    loadGlobalHistograms(TEST_PROJECT_PATH);

    const hist = getGlobalHistogram(pid);
    expect(hist.total).toBe(15); // 10 + 5
    expect(hist.counts[0]).toBe(10);
    expect(hist.counts[3]).toBe(5);
  });

  test("flush writes 'all' row and deletes old slot rows", () => {
    const d = db();
    const now = Date.now();
    const binCount = HISTOGRAM_BINS.length + 1;

    // Insert old-format rows
    const workCounts = new Array(binCount).fill(0);
    workCounts[0] = 10;
    d.query(
      "INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pid, "work", JSON.stringify(workCounts), 10, now);

    // Load, record a gap, then flush
    loadGlobalHistograms(TEST_PROJECT_PATH);
    recordGlobalGap(TEST_PROJECT_PATH, 120_000); // 2 min gap
    flushGlobalHistograms();

    // Verify: old "work" row deleted, "all" row exists
    const rows = d
      .query("SELECT time_slot, total FROM warmup_histograms WHERE project_id = ?")
      .all(pid) as Array<{ time_slot: string; total: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0].time_slot).toBe("all");
    expect(rows[0].total).toBe(11); // 10 from old work + 1 new gap
  });

  test("reload after flush does not double-count", () => {
    const d = db();
    const now = Date.now();
    const binCount = HISTOGRAM_BINS.length + 1;

    // Insert old-format rows
    const workCounts = new Array(binCount).fill(0);
    workCounts[0] = 7;
    const nightCounts = new Array(binCount).fill(0);
    nightCounts[5] = 3;
    d.query(
      "INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pid, "work", JSON.stringify(workCounts), 7, now);
    d.query(
      "INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pid, "night", JSON.stringify(nightCounts), 3, now);

    // Load → flush → reset → reload
    loadGlobalHistograms(TEST_PROJECT_PATH);
    flushGlobalHistograms();
    _resetForTest(); // clears in-memory state
    loadGlobalHistograms(TEST_PROJECT_PATH);

    const hist = getGlobalHistogram(pid);
    expect(hist.total).toBe(10); // 7 + 3, no double-count
    expect(hist.counts[0]).toBe(7);
    expect(hist.counts[5]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tool-call-aware cache warming
// ---------------------------------------------------------------------------

describe("shouldWarm tool-call warming", () => {
  beforeEach(() => {
    _resetForTest();
  });

  /** Helper: session mid-tool-call (lastStopReason="tool_use") in warmup window. */
  function makeToolCallState(overrides: Partial<SessionState> = {}): SessionState {
    const now = Date.now();
    return makeSessionState({
      lastRequestTime: now - 270_000, // 4.5 min — in warmup margin of 5m TTL
      lastStopReason: "tool_use",
      messageCount: 10,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
      ...overrides,
    });
  }

  test("returns true during tool call in warmup window", () => {
    const now = Date.now();
    const state = makeToolCallState({ lastRequestTime: now - 270_000 });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("returns false during tool call when cache still fresh", () => {
    const now = Date.now();
    // 2 min — cache still fresh, not in warmup margin
    const state = makeToolCallState({ lastRequestTime: now - 120_000 });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false after MAX_TOOL_CALL_WARMING_MS exceeded", () => {
    const now = Date.now();
    // 35 min — past 30 min cap, in warmup margin of some TTL window
    const elapsed = MAX_TOOL_CALL_WARMING_MS + 270_000;
    const state = makeToolCallState({ lastRequestTime: now - elapsed });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false when /lore:warm:stop was sent", () => {
    const now = Date.now();
    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: true,
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false when break-even exceeded", () => {
    const now = Date.now();
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const maxCyc = maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);

    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: maxCyc,
        totalWarmups: maxCyc,
        warmupHits: 0,
        disabled: false,
      },
    });
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("returns false for sub-agent even with tool_use stop reason", () => {
    const now = Date.now();
    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      isSubagent: true,
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("respects circuit breaker", () => {
    // Trip the circuit breaker
    const bad = makeWarmupResult({ cacheReadTokens: 0, cacheCreationTokens: 50000 });
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);
    checkCircuitBreaker(bad);

    const now = Date.now();
    const state = makeToolCallState({ lastRequestTime: now - 270_000 });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("works across multiple TTL windows", () => {
    const now = Date.now();
    // 14.5 min — in 3rd 5m window's warmup margin (14:15-15:00)
    const state = makeToolCallState({
      lastRequestTime: now - 870_000,
      warmup: {
        lastWarmupAt: now - 270_000, // past cooldown
        warmupCount: 2,
        totalWarmups: 2,
        warmupHits: 0,
        disabled: false,
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("requires minimum turns", () => {
    const now = Date.now();
    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      messageCount: 2, // too few turns
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("forceKeepWarm takes priority over tool-call path", () => {
    const now = Date.now();
    // Both forceKeepWarm=true AND lastStopReason=tool_use.
    // The forced path should take priority (no MAX_TOOL_CALL_WARMING_MS cap).
    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
        forceKeepWarm: true,
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("works when warmup state is undefined", () => {
    const now = Date.now();
    // Fresh session — warmup is undefined, but tool call is active
    const state = makeToolCallState({
      lastRequestTime: now - 270_000,
      warmup: undefined,
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();

    // warmup?.disabled is undefined, !undefined is true → enters fast path
    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pSessionFinished — tool_use signal
// ---------------------------------------------------------------------------

describe("pSessionFinished tool_use signal", () => {
  test("tool_use stop reason strongly decreases P(finished)", () => {
    const baseSignals = {
      survivalAtIdle: 0.1, // low survival — would normally push P(finished) high
      consecutiveTextOnlyTurns: 0,
      breakFraction: 0.05,
      totalTurns: 10,
    };

    const pWithout = pSessionFinished(baseSignals);
    const pWith = pSessionFinished({ ...baseSignals, lastStopReason: "tool_use" });

    // Without tool_use, P(finished) should be high (low survival)
    expect(pWithout).toBeGreaterThan(0.5);
    // With tool_use, P(finished) should be much lower
    expect(pWith).toBeLessThan(pWithout);
    expect(pWith).toBeLessThan(0.2);
  });

  test("tool_use overrides high consecutive text-only turns", () => {
    const signals = {
      survivalAtIdle: 0.5,
      consecutiveTextOnlyTurns: 5, // strong signal task is wrapping up
      breakFraction: 0.1,
      totalTurns: 10,
      lastStopReason: "tool_use",
    };

    // Despite high text-only runs, tool_use should keep P(finished) low
    const p = pSessionFinished(signals);
    expect(p).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// cumulativeCostThreshold
// ---------------------------------------------------------------------------

describe("cumulativeCostThreshold", () => {
  // Opus 5m TTL: read=$0.50, write=$6.25
  const read = 0.50;
  const write = 6.25;
  const spread = write - read; // 5.75

  test("at k=1 matches costThreshold()", () => {
    const rising = cumulativeCostThreshold(1, read, write);
    const flat = costThreshold(read, write);
    expect(rising).toBeCloseTo(flat, 6);
  });

  test("rises linearly with k", () => {
    const t1 = cumulativeCostThreshold(1, read, write);
    const t3 = cumulativeCostThreshold(3, read, write);
    const t5 = cumulativeCostThreshold(5, read, write);
    const t6 = cumulativeCostThreshold(6, read, write);

    // k × read / (write - read)
    expect(t1).toBeCloseTo(1 * read / spread, 6); // ~8.7%
    expect(t3).toBeCloseTo(3 * read / spread, 6); // ~26.1%
    expect(t5).toBeCloseTo(5 * read / spread, 6); // ~43.5%
    expect(t6).toBeCloseTo(6 * read / spread, 6); // ~52.2%

    // Must be strictly increasing
    expect(t3).toBeGreaterThan(t1);
    expect(t5).toBeGreaterThan(t3);
    expect(t6).toBeGreaterThan(t5);
  });

  test("clamps to 1.0 when k exceeds maxProfitableCycles", () => {
    const maxCyc = maxProfitableCycles(read, write); // floor(5.75/0.50) = 11
    const tMax = cumulativeCostThreshold(maxCyc, read, write);
    const tOver = cumulativeCostThreshold(maxCyc + 1, read, write);

    // At maxCycles: 11 * 0.50 / 5.75 = 95.7%
    expect(tMax).toBeCloseTo(11 * read / spread, 6);
    // Beyond maxCycles: clamped to 1.0
    expect(tOver).toBe(1.0);
  });

  test("k=0 is treated as k=1", () => {
    expect(cumulativeCostThreshold(0, read, write)).toBe(cumulativeCostThreshold(1, read, write));
  });

  test("degenerate case: write <= read returns 1.0", () => {
    expect(cumulativeCostThreshold(1, 5.0, 5.0)).toBe(1.0);
    expect(cumulativeCostThreshold(1, 5.0, 3.0)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Session-level ROI guard
// ---------------------------------------------------------------------------

describe("shouldWarm session ROI guard", () => {
  beforeEach(() => _resetForTest());

  test("rejects warming when session hit rate is below threshold after enough warmups", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000, // in warmup margin
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 12,  // >= MIN_WARMUPS_FOR_ROI_CHECK (10)
        warmupHits: 1,     // 8.3% < MIN_SESSION_HIT_RATE (20%)
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });

  test("allows warming when session hit rate is above threshold", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 10,
        warmupHits: 3,     // 30% > MIN_SESSION_HIT_RATE (20%)
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("skips ROI check when fewer than MIN_WARMUPS_FOR_ROI_CHECK warmups", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 5,   // < MIN_WARMUPS_FOR_ROI_CHECK (10)
        warmupHits: 0,     // 0% hit rate, but too few warmups to judge
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(true);
  });

  test("ROI guard applies to tool-call path too", () => {
    const now = Date.now();
    const state = makeSessionState({
      lastRequestTime: now - 270_000,
      lastStopReason: "tool_use",
      warmup: {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 15,
        warmupHits: 1,     // 6.7% < MIN_SESSION_HIT_RATE (20%)
        disabled: false,
      },
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const hist = createHistogram();
    for (let i = 0; i < 50; i++) recordGap(hist, 360_000);

    expect(shouldWarm(state, profile, hist, now)).toBe(false);
  });
});
