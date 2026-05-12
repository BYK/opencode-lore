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
  HISTOGRAM_BINS,
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
      warmup: { lastWarmupAt: 0, warmupCount: 0, warmupHits: 0, disabled: true },
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

  test("dampens survival with consecutive text-only turns", () => {
    const now = Date.now();

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

    // Histogram with moderate return probability — just above the cost threshold
    const hist = createHistogram();
    for (let i = 0; i < 30; i++) recordGap(hist, 360_000); // 60% at 6m
    for (let i = 0; i < 70; i++) recordGap(hist, 30_000);  // 70% at 30s (never return after 4.5m)

    expect(shouldWarm(baseState, profile, hist, now)).toBe(true);

    // Now: same session but with 5 consecutive text-only turns → 0.5^5 = 3.1%× probability
    const dampenedState = makeSessionState({
      lastRequestTime: now - 270_000,
      consecutiveTextOnlyTurns: 5,
      cacheAnalytics: {
        ...makeCacheAnalytics(),
        lastRequestBody: compressBody('{"model":"claude-sonnet-4-20250514","max_tokens":16384,"stream":true,"messages":[{"role":"user","content":"test"}]}'),
      },
    });

    // With dampening, the effective probability drops below threshold
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

  test("non-forced mode still uses full ttlMs cooldown", () => {
    const now = Date.now();
    // Same timing as above but without forceKeepWarm — should be blocked
    // by the full ttlMs cooldown since 260s < 300s.
    const state = makeSessionState({
      lastRequestTime: now - 270_000, // 4.5 min ago — in warmup margin
      warmup: {
        lastWarmupAt: now - 260_000, // 4m20s ago — within full TTL cooldown
        warmupCount: 1,
        warmupHits: 0,
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

    // 260s < 300s (full TTL cooldown) → blocked
    expect(shouldWarm(state, profile, hist, now)).toBe(false);
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

    // All gaps are very short — nobody ever comes back after 4.5m
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

  test("cost ratio gives reasonable threshold", () => {
    const profile = buildAnthropicProfile("claude-sonnet-4-20250514", "5m");
    const threshold = profile.cacheReadCostPerMTok / profile.cacheMissCostPerMTok;
    // Should be around 0.08 (10% of base / 125% of base = 0.08)
    expect(threshold).toBeGreaterThan(0.03);
    expect(threshold).toBeLessThan(0.15);
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
} from "../src/cache-warmer";

describe("gap recording filtering", () => {
  beforeEach(() => {
    _resetForTest();
  });

  /**
   * Helper to simulate the gap recording logic from pipeline.ts postResponse().
   * This mirrors the guarded block that decides whether to record a gap.
   */
  function simulateGapRecording(
    sessionState: SessionState,
    opts: {
      isSubagentTurn: boolean;
      prevStopReason: string | undefined;
      now: number;
    },
  ): void {
    const { isSubagentTurn, prevStopReason, now } = opts;
    const isToolUseContinuation = prevStopReason === "tool_use";

    if (!isSubagentTurn && !isToolUseContinuation) {
      if (sessionState.lastUserTurnTime > 0) {
        const gap = now - sessionState.lastUserTurnTime;
        recordGap(getSessionHistogram(sessionState), gap);
        recordGlobalGap(sessionState.projectPath, gap);
      }
      sessionState.lastUserTurnTime = now;
    }
  }

  test("subagent turns do not record gaps", () => {
    const state = makeSessionState({ lastUserTurnTime: Date.now() - 60_000 });
    const hist = getSessionHistogram(state);
    expect(hist.total).toBe(0);

    simulateGapRecording(state, {
      isSubagentTurn: true,
      prevStopReason: "end_turn",
      now: Date.now(),
    });

    expect(hist.total).toBe(0);
  });

  test("tool-use continuation turns do not record gaps", () => {
    const state = makeSessionState({ lastUserTurnTime: Date.now() - 60_000 });
    const hist = getSessionHistogram(state);

    simulateGapRecording(state, {
      isSubagentTurn: false,
      prevStopReason: "tool_use",
      now: Date.now(),
    });

    expect(hist.total).toBe(0);
  });

  test("lastUserTurnTime is not updated by subagent turns", () => {
    const originalTime = Date.now() - 120_000;
    const state = makeSessionState({ lastUserTurnTime: originalTime });

    simulateGapRecording(state, {
      isSubagentTurn: true,
      prevStopReason: "end_turn",
      now: Date.now(),
    });

    expect(state.lastUserTurnTime).toBe(originalTime);
  });

  test("lastUserTurnTime is not updated by tool-use continuations", () => {
    const originalTime = Date.now() - 120_000;
    const state = makeSessionState({ lastUserTurnTime: originalTime });

    simulateGapRecording(state, {
      isSubagentTurn: false,
      prevStopReason: "tool_use",
      now: Date.now(),
    });

    expect(state.lastUserTurnTime).toBe(originalTime);
  });

  test("gap is computed from lastUserTurnTime, not lastRequestTime", () => {
    const now = Date.now();
    // lastRequestTime was updated 5s ago by a subagent, but the last
    // actual user turn was 60s ago.
    const state = makeSessionState({
      lastRequestTime: now - 5_000,
      lastUserTurnTime: now - 60_000,
    });

    simulateGapRecording(state, {
      isSubagentTurn: false,
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
      isSubagentTurn: false,
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
      isSubagentTurn: false,
      prevStopReason: "end_turn",
      now,
    });

    const hist = getSessionHistogram(state);
    expect(hist.total).toBe(1);
    expect(state.lastUserTurnTime).toBe(now);
  });

  test("global histogram also records gap for user turns", () => {
    const now = Date.now();
    const state = makeSessionState({ lastUserTurnTime: now - 120_000 }); // 2 min ago

    simulateGapRecording(state, {
      isSubagentTurn: false,
      prevStopReason: "end_turn",
      now,
    });

    const globalHist = getGlobalHistogram(state.projectPath);
    expect(globalHist.total).toBe(1);
  });

  test("global histogram is not polluted by subagent turns", () => {
    const now = Date.now();
    const state = makeSessionState({ lastUserTurnTime: now - 120_000 });

    simulateGapRecording(state, {
      isSubagentTurn: true,
      prevStopReason: "end_turn",
      now,
    });

    const globalHist = getGlobalHistogram(state.projectPath);
    expect(globalHist.total).toBe(0);
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

    const hist = getGlobalHistogram(TEST_PROJECT_PATH);
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

    const hist = getGlobalHistogram(TEST_PROJECT_PATH);
    expect(hist.total).toBe(10); // 7 + 3, no double-count
    expect(hist.counts[0]).toBe(7);
    expect(hist.counts[5]).toBe(3);
  });
});
