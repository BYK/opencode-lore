/**
 * Speculative cache warming — sends keepalive requests to refresh
 * Anthropic's prompt cache before it expires.
 *
 * Uses survival analysis on inter-turn gaps to predict whether the user
 * will return before the cache TTL expires. If the expected value of
 * warming (P(return) × cache_miss_savings) exceeds the warmup cost
 * (cache_read_cost), sends a max_tokens:0 request that refreshes the
 * cache without generating output.
 *
 * Key design decisions:
 *  - Cache keys are computed from tokenized prompt content (tools →
 *    system → messages), NOT raw JSON bytes. max_tokens, stream, and
 *    temperature are not part of the cache key. Confirmed by Anthropic
 *    pre-warming docs and cache invalidation table.
 *  - The normalized lastRequestBody from cache-analytics is sufficient
 *    for replay — cch/version suffix normalization doesn't affect the
 *    cache key (those are billing verification, not prompt content).
 *  - Global circuit breaker: if 3 warmup requests cause cache writes
 *    instead of reads (meaning the warmup body doesn't match the cached
 *    prefix), ALL warming is disabled for the process lifetime. This
 *    prevents burning money if our assumptions about cache key computation
 *    are wrong.
 */

import { log, config as loreConfig, db, projectId, getKV, setKV } from "@loreai/core";
import type {
  InterTurnHistogram,
  WarmupResult,
  WarmupState,
  SessionState,
} from "./translate/types";
import { decompressBody } from "./cache-analytics";
import { resolveAuth, authHeaders } from "./auth";
import { resignBody } from "./cch";
import { resolveUpstreamRoute } from "./config";
import { getModelEntrySync } from "./worker-model";
import { recordWarmupCost } from "./cost-tracker";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Log-scale histogram bin edges (ms). High resolution around the 5m and
 * 1h TTL boundaries where the warming decision matters most.
 */
export const HISTOGRAM_BINS: readonly number[] = [
  10_000,    // 10s
  20_000,    // 20s
  30_000,    // 30s
  45_000,    // 45s
  60_000,    // 1m
  90_000,    // 1.5m
  120_000,   // 2m
  180_000,   // 3m
  240_000,   // 4m
  300_000,   // 5m   ← 5m TTL boundary
  420_000,   // 7m
  600_000,   // 10m
  900_000,   // 15m
  1_200_000, // 20m
  1_800_000, // 30m
  2_700_000, // 45m
  3_600_000, // 1h   ← 1h TTL boundary
  5_400_000, // 1.5h
  7_200_000, // 2h
  14_400_000, // 4h
] as const;

/** Number of histogram bins (edges + 1 overflow bin). */
const BIN_COUNT = HISTOGRAM_BINS.length + 1;

/** Pseudocount for Bayesian blending of session vs global histograms. */
export const BLEND_PSEUDOCOUNT = 20;

/** Survival probability below which a session is marked dead. */
export const DEAD_SESSION_THRESHOLD = 0.02;

/** Minimum completed turns before warming is eligible. Filters out one-shot
 *  sessions and ensures the survival model has ≥2 gap observations. */
export const MIN_TURNS_FOR_WARMING = 3;

/** Maximum duration (ms) to keep warming during a tool call before
 *  falling back to normal survival analysis. 30 min ≈ 6 cycles at 5m TTL. */
export const MAX_TOOL_CALL_WARMING_MS = 30 * 60 * 1000;

/** Max uncached warmup responses before the global circuit breaker trips. */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;

/** Gap duration floor (ms) separating "active coding turns" from "breaks".
 *  3 minutes is well past typical agent think time (10s–60s) but before
 *  the 5m TTL warmup window (4:15–5:00). */
export const BREAK_FLOOR_MS = 180_000;

/** Minimum total warmups before session-level hit-rate ROI check kicks in. */
export const MIN_WARMUPS_FOR_ROI_CHECK = 10;

/** Minimum session-level hit rate to continue warming. Below this,
 *  warming is empirically unprofitable and we stop. 20% means at least
 *  1 in 5 warmups must result in a confirmed user return. */
export const MIN_SESSION_HIT_RATE = 0.20;

// ---------------------------------------------------------------------------
// Global circuit breaker
// ---------------------------------------------------------------------------

let circuitBreakerFailures = 0;
let circuitBreakerTripped = false;
let circuitBreakerLoaded = false;

const CB_KV_KEY = "warmup_circuit_breaker";

/** Load circuit breaker state from DB on first access. */
function ensureCircuitBreakerLoaded(): void {
  if (circuitBreakerLoaded) return;
  circuitBreakerLoaded = true;
  try {
    const raw = getKV(CB_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tripped?: boolean; failures?: number };
      circuitBreakerTripped = parsed.tripped ?? false;
      circuitBreakerFailures = parsed.failures ?? 0;
    }
  } catch {
    // Corrupted value — start fresh
  }
}

/** Persist circuit breaker state to DB. */
function saveCircuitBreaker(): void {
  setKV(CB_KV_KEY, JSON.stringify({ tripped: circuitBreakerTripped, failures: circuitBreakerFailures }));
}

/**
 * Check if the global circuit breaker has tripped.
 *
 * Once tripped, ALL cache warming is disabled for the process lifetime.
 * This is intentionally non-recoverable — if warmups are causing cache
 * writes instead of reads, something fundamental is wrong (our assumptions
 * about cache key computation, body format, auth, etc.) and we cannot
 * afford to keep trying.
 */
export function isCircuitBreakerTripped(): boolean {
  ensureCircuitBreakerLoaded();
  return circuitBreakerTripped;
}

/** Snapshot of circuit breaker state for dashboard rendering. */
export function getCircuitBreakerStatus(): {
  tripped: boolean;
  failures: number;
  maxFailures: number;
} {
  ensureCircuitBreakerLoaded();
  return {
    tripped: circuitBreakerTripped,
    failures: circuitBreakerFailures,
    maxFailures: CIRCUIT_BREAKER_MAX_FAILURES,
  };
}

/**
 * Record a warmup result and check the circuit breaker.
 *
 * A "failure" is a warmup where cacheCreationTokens > 0 AND
 * cacheReadTokens === 0 — meaning the warmup caused a fresh cache write
 * instead of refreshing an existing entry. This should never happen if
 * the warmup body matches the cached prefix.
 *
 * Returns true if the circuit breaker has tripped (warming should stop).
 */
export function checkCircuitBreaker(result: WarmupResult): boolean {
  ensureCircuitBreakerLoaded();
  if (circuitBreakerTripped) return true;

  if (result.ok && result.cacheCreationTokens > 0 && result.cacheReadTokens === 0) {
    circuitBreakerFailures++;
    log.error(
      `cache-warmer CIRCUIT BREAKER: warmup caused uncached write ` +
        `(${circuitBreakerFailures}/${CIRCUIT_BREAKER_MAX_FAILURES}). ` +
        `cacheCreation=${result.cacheCreationTokens} cacheRead=${result.cacheReadTokens}`,
    );
    saveCircuitBreaker();
    if (circuitBreakerFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      circuitBreakerTripped = true;
      saveCircuitBreaker();
      log.error(
        `cache-warmer CIRCUIT BREAKER TRIPPED: ${CIRCUIT_BREAKER_MAX_FAILURES} consecutive ` +
          `uncached warmups detected. ALL cache warming disabled for this process. ` +
          `This indicates warmup bodies don't match the cached prefix — ` +
          `investigate cache key computation assumptions.`,
      );
      return true;
    }
  } else if (result.ok && result.cacheReadTokens > 0) {
    // Successful cache read — reset the failure counter
    circuitBreakerFailures = 0;
    saveCircuitBreaker();
  }

  return circuitBreakerTripped;
}

// ---------------------------------------------------------------------------
// Histogram operations
// ---------------------------------------------------------------------------

/** Create an empty histogram with the right number of bins. */
export function createHistogram(): InterTurnHistogram {
  return { counts: new Array(BIN_COUNT).fill(0), total: 0 };
}

/**
 * Find the bin index for a gap duration.
 * Returns 0..HISTOGRAM_BINS.length (last index is the overflow bin).
 */
function binIndex(gapMs: number): number {
  for (let i = 0; i < HISTOGRAM_BINS.length; i++) {
    if (gapMs < HISTOGRAM_BINS[i]) return i;
  }
  return HISTOGRAM_BINS.length; // overflow
}

/** Record an inter-turn gap in a histogram. */
export function recordGap(histogram: InterTurnHistogram, gapMs: number): void {
  const idx = binIndex(gapMs);
  histogram.counts[idx]++;
  histogram.total++;
}

// ---------------------------------------------------------------------------
// Survival function
// ---------------------------------------------------------------------------

/**
 * Compute the survival function S(t) = P(gap > t) from a histogram.
 *
 * S(t) = (# observations with gap > t) / total
 *
 * For an empty histogram, returns 1.0 (optimistic — assume user returns).
 */
export function survivalFunction(
  histogram: InterTurnHistogram,
  tMs: number,
): number {
  if (histogram.total === 0) return 1.0;

  const idx = binIndex(tMs);
  // Sum counts in bins > idx (gaps strictly larger than tMs)
  let surviving = 0;
  for (let i = idx + 1; i < BIN_COUNT; i++) {
    surviving += histogram.counts[i];
  }
  // Include a fraction of the current bin proportionally
  // (linear interpolation within the bin)
  const binStart = idx > 0 ? HISTOGRAM_BINS[idx - 1] : 0;
  const binEnd = idx < HISTOGRAM_BINS.length ? HISTOGRAM_BINS[idx] : Infinity;
  const binWidth = binEnd - binStart;
  if (binWidth > 0 && isFinite(binWidth)) {
    const fractionPast = Math.min(1, Math.max(0, (tMs - binStart) / binWidth));
    surviving += histogram.counts[idx] * (1 - fractionPast);
  }

  return surviving / histogram.total;
}

/**
 * Conditional return probability: P(return within [idle, idle+window] | idle for `idleMs`).
 *
 * Uses the survival function:
 *   P = (S(idleMs) - S(idleMs + windowMs)) / S(idleMs)
 *
 * Returns 0 if survival at idleMs is already ~0 (dead session).
 */
export function conditionalReturnProbability(
  histogram: InterTurnHistogram,
  idleMs: number,
  windowMs: number,
): number {
  const sNow = survivalFunction(histogram, idleMs);
  if (sNow < 0.001) return 0; // effectively dead
  const sFuture = survivalFunction(histogram, idleMs + windowMs);
  return Math.max(0, (sNow - sFuture) / sNow);
}

// ---------------------------------------------------------------------------
// Survival model helpers
// ---------------------------------------------------------------------------

/**
 * Get (or create) the session-level histogram.
 */
export function getSessionHistogram(
  state: SessionState,
): InterTurnHistogram {
  if (!state.survivalModel) {
    state.survivalModel = createHistogram();
  }
  return state.survivalModel;
}

/**
 * Blend a session histogram with a global histogram using Bayesian weighting.
 *
 * When the session has few observations, lean on the global prior.
 * As the session accumulates data, its own distribution dominates.
 *
 * effective_count[i] = session_weight × session[i] + global_weight × global[i]
 * where session_weight = min(session.total / PSEUDOCOUNT, 1.0)
 */
export function blendHistograms(
  session: InterTurnHistogram,
  global: InterTurnHistogram,
): InterTurnHistogram {
  const sessionWeight = Math.min(session.total / BLEND_PSEUDOCOUNT, 1.0);
  const globalWeight = 1.0 - sessionWeight;

  const blended = createHistogram();
  for (let i = 0; i < BIN_COUNT; i++) {
    blended.counts[i] =
      sessionWeight * session.counts[i] + globalWeight * global.counts[i];
  }
  blended.total =
    sessionWeight * session.total + globalWeight * global.total;
  return blended;
}

// ---------------------------------------------------------------------------
// Global histograms (per-project, in-memory)
// ---------------------------------------------------------------------------

/** Global histograms keyed by project_id (UUID). */
const globalHistograms = new Map<string, InterTurnHistogram>();

/**
 * Get the global histogram for a project by its ID.
 *
 * Creates an empty histogram if none exists for the given pid.
 */
export function getGlobalHistogram(
  pid: string,
): InterTurnHistogram {
  let hist = globalHistograms.get(pid);
  if (!hist) {
    hist = createHistogram();
    globalHistograms.set(pid, hist);
  }
  return hist;
}

/** Get blended histogram for a session (session + global). */
export function blendedHistogramForSession(
  state: SessionState,
): InterTurnHistogram {
  const sessionHist = getSessionHistogram(state);
  const pid = projectId(state.projectPath);
  if (!pid) return sessionHist; // no project in DB yet — session-only
  const globalHist = getGlobalHistogram(pid);
  return blendHistograms(sessionHist, globalHist);
}

// ---------------------------------------------------------------------------
// Break-commitment model helpers
// ---------------------------------------------------------------------------

/**
 * Fraction of observed inter-turn gaps that are "breaks" (≥ BREAK_FLOOR_MS).
 *
 * Logically splits the histogram at query time — no structural changes to
 * the histogram itself. Uses linear interpolation within the floor bin,
 * same technique as survivalFunction().
 *
 * For an empty histogram, returns 0.3 (prior: ~30% of gaps are breaks).
 */
export function breakFraction(hist: InterTurnHistogram): number {
  if (hist.total === 0) return 0.3;

  const floorIdx = binIndex(BREAK_FLOOR_MS);

  // Sum all observations in bins strictly above the floor bin
  let breakCount = 0;
  for (let i = floorIdx + 1; i < BIN_COUNT; i++) {
    breakCount += hist.counts[i];
  }

  // Fractional inclusion of the floor bin via linear interpolation
  const binStart = floorIdx > 0 ? HISTOGRAM_BINS[floorIdx - 1] : 0;
  const binEnd = floorIdx < HISTOGRAM_BINS.length ? HISTOGRAM_BINS[floorIdx] : Infinity;
  const binWidth = binEnd - binStart;
  if (binWidth > 0 && isFinite(binWidth)) {
    const fractionAbove = Math.max(0, Math.min(1, (binEnd - BREAK_FLOOR_MS) / binWidth));
    breakCount += hist.counts[floorIdx] * fractionAbove;
  }

  return breakCount / hist.total;
}

/**
 * Signals used by the session-finished estimator.
 */
export type SessionEndSignals = {
  /** Survival function value S(elapsed) from the blended histogram. */
  survivalAtIdle: number;
  /** Consecutive assistant turns ending with text-only (no tool calls). */
  consecutiveTextOnlyTurns: number;
  /** Fraction of all observed gaps that are breaks (≥ BREAK_FLOOR_MS). */
  breakFraction: number;
  /** Total completed turns (messageCount / 2). */
  totalTurns: number;
  /** Last stop reason from the assistant response. "tool_use" means the
   *  agent is actively executing a tool and will return with the result. */
  lastStopReason?: string;
};

/**
 * Estimate P(session is finished | signals).
 *
 * Log-linear model combining four independent signals into a probability
 * via sigmoid(logOdds). Conservative bias (low base rate) because the cost
 * of a false positive (one unnecessary warmup, ~$0.01) is much smaller
 * than the cost of a false negative (cache miss, ~$0.70 at 200K tokens).
 */
export function pSessionFinished(signals: SessionEndSignals): number {
  // Base rate: ~12% — most checks happen when the session is NOT finished
  let logOdds = -2.0;

  // Signal 1: Survival function — low survival = unprecedented idle
  //   S ≈ 0    → +4.0 (almost certainly done)
  //   S ≈ 0.5  → +0.5
  //   S ≈ 1.0  → -0.5 (no evidence of end)
  if (signals.survivalAtIdle < 0.01) {
    logOdds += 4.0;
  } else {
    logOdds += 2.0 * (1.0 - signals.survivalAtIdle) - 0.5;
  }

  // Signal 2: Consecutive text-only turns — task wrapping up
  //   0 runs → 0, 1 run → +0.5, capped at +3.5
  //   At 5 runs: +2.5, at 7 runs: +3.5 (strong signal — model finished with text repeatedly)
  logOdds += Math.min(3.5, signals.consecutiveTextOnlyTurns * 0.5);

  // Signal 3: Break fraction from histogram
  //   If breaks are rare for this user/project, a long idle is more
  //   likely a session end than a break.
  //   breakFraction = 0   → +1.5 (no breaks ever observed — very likely session end)
  //   breakFraction = 5%  → +0.85
  //   breakFraction = 40% → -0.2
  logOdds += 1.5 - 3.0 * Math.min(signals.breakFraction, 0.5);

  // Signal 4: Very short sessions are more likely one-shots
  if (signals.totalTurns <= 2) {
    logOdds += 1.0;
  } else if (signals.totalTurns <= 5) {
    logOdds += 0.3;
  }

  // Signal 5: Active tool call — strong evidence session is NOT finished.
  // The agent is executing a tool and will return with the result.
  if (signals.lastStopReason === "tool_use") {
    logOdds -= 4.0;
  }

  // Sigmoid: p = 1 / (1 + exp(-logOdds))
  return 1.0 / (1.0 + Math.exp(-logOdds));
}

/**
 * Expected number of warmup cycles during a break, given elapsed idle time.
 *
 * Uses the survival function conditioned on the current idle time to walk
 * forward through TTL windows and accumulate the expected cycle count.
 * Stops when P(still idle) drops below 1% or maxCycles is reached.
 */
export function expectedWarmupCycles(
  hist: InterTurnHistogram,
  elapsedMs: number,
  ttlMs: number,
  maxCycles: number,
): number {
  // S(elapsed) — probability of still being idle at current time
  const sNow = survivalFunction(hist, elapsedMs);
  if (sNow < 0.001) return maxCycles + 1; // essentially dead — exceeds budget to trigger cap

  let expected = 0;

  for (let k = 1; k <= maxCycles; k++) {
    const futureMs = elapsedMs + k * ttlMs;
    const sFuture = survivalFunction(hist, futureMs);

    // P(still idle at window k | idle at elapsed) = S(futureMs) / S(elapsedMs)
    const pStillIdle = sFuture / sNow;

    // We pay for this cycle if we're still idle when it fires
    expected += pStillIdle;

    // Negligible probability of reaching further windows
    if (pStillIdle < 0.01) break;
  }

  return Math.min(expected, maxCycles);
}

/**
 * Compute the corrected cost threshold for a warming decision.
 *
 * Accounts for the fact that a successful warmup sequence costs
 * cache_read twice: once for the keepalive and once when the user
 * returns. Break-even: read / (write - read).
 */
export function costThreshold(
  cacheReadCostPerMTok: number,
  cacheMissCostPerMTok: number,
): number {
  const denominator = cacheMissCostPerMTok - cacheReadCostPerMTok;
  if (denominator <= 0) return 1.0; // degenerate — never warm
  return cacheReadCostPerMTok / denominator;
}

/**
 * Rising cost threshold that accounts for accumulated warmup costs.
 *
 * After k warmup cycles, the total cost is k × read. A hit saves
 * (write - read). Break-even: P × (write - read) ≥ k × read, so:
 *   P(returns) > k × read / (write - read)
 *
 * This rises linearly with k — the more cycles spent, the higher
 * P(returns) must be to justify the next warmup. For Opus 5m TTL
 * (read=$0.50, write=$6.25):
 *   k=1: 8.7%,  k=3: 26%,  k=5: 43%,  k=6: 52%,  k=11: 96%
 *
 * At k=1 this matches costThreshold() exactly.
 * Clamped to 1.0 so we never require > 100% probability.
 */
export function cumulativeCostThreshold(
  cyclesSpent: number,
  cacheReadCostPerMTok: number,
  cacheMissCostPerMTok: number,
): number {
  const k = Math.max(cyclesSpent, 1);
  const denominator = cacheMissCostPerMTok - cacheReadCostPerMTok;
  if (denominator <= 0) return 1.0;
  return Math.min((k * cacheReadCostPerMTok) / denominator, 1.0);
}

/**
 * Maximum profitable warmup cycles before total warming cost exceeds
 * the savings from avoiding a cache write on user return.
 *
 * maxCycles = floor((write - read) / read)
 */
export function maxProfitableCycles(
  cacheReadCostPerMTok: number,
  cacheMissCostPerMTok: number,
): number {
  if (cacheReadCostPerMTok <= 0) return 0;
  return Math.floor((cacheMissCostPerMTok - cacheReadCostPerMTok) / cacheReadCostPerMTok);
}

// ---------------------------------------------------------------------------
// Cache warming profiles
// ---------------------------------------------------------------------------

/** Provider-agnostic cache warming profile. */
export type CacheWarmingProfile = {
  /** Cache TTL in ms for this session's configuration. */
  ttlMs: number;
  /** Per-MTok cost to read from cache ($). */
  cacheReadCostPerMTok: number;
  /** Per-MTok cost on a full miss (write) ($). */
  cacheMissCostPerMTok: number;
  /** How early before TTL expiry to send the warmup (ms). */
  warmupMarginMs: number;
  /** Prepare the stored body for a warmup request. */
  prepareWarmupBody: (storedBody: string) => string;
  /** Upstream URL to send the warmup to. */
  upstreamUrl: string;
};

/**
 * Prepare an Anthropic request body for cache warming.
 *
 * Sets max_tokens to 0 (or 1 for thinking-enabled sessions), disables
 * streaming, and strips fields incompatible with max_tokens:0.
 *
 * The cache key is computed from tokenized prompt content (tools → system
 * → messages), NOT raw JSON bytes. max_tokens, stream, and temperature
 * are not part of the cache key, so changing them doesn't affect cache
 * hit/miss. Confirmed by Anthropic's pre-warming docs.
 */
export function prepareAnthropicWarmupBody(storedBody: string): string {
  const body = JSON.parse(storedBody);
  const hasThinking = "thinking" in body;

  // max_tokens: 0 is the ideal warmup (zero output cost), but it's
  // incompatible with extended thinking. Fall back to max_tokens: 1
  // for thinking-enabled sessions (~$0.000015 output cost, negligible).
  body.max_tokens = hasThinking ? 1 : 0;
  body.stream = false;

  // Strip forced tool_choice (incompatible with max_tokens: 0;
  // also avoids generating a tool call on max_tokens: 1)
  if (body.tool_choice?.type === "tool" || body.tool_choice?.type === "any") {
    delete body.tool_choice;
  }

  // Strip structured output format (incompatible with max_tokens: 0)
  delete body.output_config;

  return JSON.stringify(body);
}

/**
 * Build an Anthropic warming profile for a given model and TTL.
 */
export function buildAnthropicProfile(
  model: string,
  ttl: "5m" | "1h",
  upstreamBase?: string,
): CacheWarmingProfile {
  const entry = getModelEntrySync(model);
  const cacheReadCost = entry.cost?.cache_read ?? (entry.cost?.input ?? 3) * 0.1;
  // Base cache_write is the 5m TTL price. Anthropic charges 2× for 1h TTL writes.
  const baseCacheWrite = entry.cost?.cache_write ?? (entry.cost?.input ?? 3) * 1.25;
  const cacheWriteCost = ttl === "1h" ? baseCacheWrite * 2 : baseCacheWrite;

  const ttlMs = ttl === "1h" ? 3_600_000 : 300_000;
  // For 5m TTL: warm in the last 45s (4:15–5:00)
  // For 1h TTL: warm in the last 5m (55:00–60:00)
  const warmupMarginMs = ttl === "1h" ? 300_000 : 45_000;

  const route = resolveUpstreamRoute(model);
  const base = upstreamBase ?? route?.url ?? "https://api.anthropic.com";

  return {
    ttlMs,
    cacheReadCostPerMTok: cacheReadCost,
    cacheMissCostPerMTok: cacheWriteCost,
    warmupMarginMs,
    prepareWarmupBody: prepareAnthropicWarmupBody,
    upstreamUrl: `${base}/v1/messages`,
  };
}

/**
 * Resolve a warming profile for a session.
 *
 * Returns null if warming is not applicable (unknown provider, warming
 * disabled, etc.).
 */
export function resolveProfile(
  model: string | undefined,
  protocol: "anthropic" | "openai" | "openai-responses" | undefined,
  ttl: "5m" | "1h" | undefined,
  upstreamBase?: string,
): CacheWarmingProfile | null {
  if (!model || !protocol) return null;

  // Only Anthropic for now — OpenAI has automatic prefix caching
  // with no explicit warming API
  if (protocol !== "anthropic") return null;

  return buildAnthropicProfile(model, ttl ?? "5m", upstreamBase);
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Determine whether to warm a session's cache right now.
 *
 * Uses a commitment-based model instead of per-window survival analysis:
 *  1. Asks "Is this session finished?" via signal fusion (pSessionFinished)
 *  2. Computes expected warming cost across a potential break
 *  3. Compares P(returns) against the corrected cost threshold
 *
 * Gate checks (circuit breaker, config, body, /lore:warm:keep, cooldown) are unchanged.
 *
 * Two phases for the normal path:
 *  - Initial commitment (first TTL window): full ROI analysis
 *  - Continuation (subsequent windows): check break-even cap + re-evaluate
 */
export function shouldWarm(
  state: SessionState,
  profile: CacheWarmingProfile,
  blendedHist: InterTurnHistogram,
  now: number = Date.now(),
): boolean {
  // Global kill switch — always respected, even with /lore:warm:keep
  if (circuitBreakerTripped) return false;

  // Sub-agent sessions are always exempt — they are too short-lived
  // for warming to be profitable, even with /lore:warm:keep force.
  if (state.isSubagent) return false;

  const cfg = loreConfig();
  if (!cfg.cache.warming.enabled) return false;

  // No stored body to replay — nothing to warm
  if (!state.cacheAnalytics.lastRequestBody) return false;

  const elapsed = now - state.lastRequestTime;
  const { ttlMs, warmupMarginMs, cacheReadCostPerMTok, cacheMissCostPerMTok } = profile;
  const forced = state.warmup?.forceKeepWarm === true;
  const toolCallActive = state.lastStopReason === "tool_use";

  // Already warmed recently — prevent double-warming.
  // Cooldown = ttlMs - warmupMarginMs so the next warmup fires while the
  // previous cache is still alive. Using the full ttlMs as cooldown causes
  // each continuation warmup to arrive right as the cache expires, turning
  // every warmup into a cold write (~$1.25 for Opus 200K) instead of a
  // cheap refresh (~$0.10). This was the dominant cost driver: 65 warmups
  // at cold-write pricing = ~$65 vs ~$6.50 with correct timing.
  const cooldownMs = Math.max(ttlMs - warmupMarginMs, 0);
  if (state.warmup?.lastWarmupAt && (now - state.warmup.lastWarmupAt) < cooldownMs) {
    return false;
  }

  if (forced) {
    // /lore:warm:keep mode: skip survival/signal analysis but still respect
    // the break-even cap — warming beyond maxCycles is always unprofitable,
    // even when the user explicitly asked for /lore:warm:keep.
    const maxCycles = maxProfitableCycles(cacheReadCostPerMTok, cacheMissCostPerMTok);
    const cyclesSpent = state.warmup?.warmupCount ?? 0;
    if (cyclesSpent >= maxCycles) return false;

    // Check we're in the warmup margin of *some* TTL window.
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;
    return true;
  }

  // --- Tool-call fast path ---
  // When lastStopReason is "tool_use", the agent is executing a tool and
  // WILL return with the result. Bypass survival analysis (return probability
  // is ~1.0) but respect break-even cap, session ROI guard, and a maximum
  // duration to handle agent crashes gracefully.
  if (toolCallActive && !state.warmup?.disabled) {
    // Cap: don't warm indefinitely if the agent crashed mid-tool-call
    if (elapsed > MAX_TOOL_CALL_WARMING_MS) return false;

    // Session-level ROI guard applies even during tool calls
    const lifetime = state.warmup?.totalWarmups ?? 0;
    if (lifetime >= MIN_WARMUPS_FOR_ROI_CHECK) {
      const hitRate = (state.warmup?.warmupHits ?? 0) / lifetime;
      if (hitRate < MIN_SESSION_HIT_RATE) return false;
    }

    const maxCycles = maxProfitableCycles(cacheReadCostPerMTok, cacheMissCostPerMTok);
    const cyclesSpent = state.warmup?.warmupCount ?? 0;
    if (cyclesSpent >= maxCycles) return false;

    // Still require some history to have a stored body worth warming
    if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) return false;

    // Only warm in the margin window of the current TTL cycle
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;

    return true;
  }

  // --- Normal (non-forced) commitment-based path ---

  // Not enough turns — survival model has insufficient data and the
  // session may be a one-shot question not worth warming ($0.30 per
  // wasted warmup at 200K Opus tokens).
  if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) return false;

  // Session marked dead
  if (state.warmup?.disabled) return false;

  // Session-level ROI guard: after enough warmups, if the observed hit
  // rate is chronically low, stop warming. This prevents unlimited
  // spending across many short breaks where each individual break passes
  // the per-break checks but the aggregate ROI is deeply negative.
  const lifetime = state.warmup?.totalWarmups ?? 0;
  if (lifetime >= MIN_WARMUPS_FOR_ROI_CHECK) {
    const hitRate = (state.warmup?.warmupHits ?? 0) / lifetime;
    if (hitRate < MIN_SESSION_HIT_RATE) return false;
  }

  // Compute commitment model signals
  const survivalAtIdle = survivalFunction(blendedHist, elapsed);
  const breakFrac = breakFraction(blendedHist);
  const textOnlyRuns = state.consecutiveTextOnlyTurns ?? 0;
  const totalTurns = Math.floor(state.messageCount / 2);

  const pFinished = pSessionFinished({
    survivalAtIdle,
    consecutiveTextOnlyTurns: textOnlyRuns,
    breakFraction: breakFrac,
    totalTurns,
    lastStopReason: state.lastStopReason,
  });
  const pReturns = 1.0 - pFinished;

  // Corrected cost threshold: read / (write - read)
  const autoThreshold = costThreshold(cacheReadCostPerMTok, cacheMissCostPerMTok);
  const threshold = cfg.cache.warming.minReturnProbability ?? autoThreshold;

  // Max cycles before warming becomes unprofitable
  const maxCycles = maxProfitableCycles(cacheReadCostPerMTok, cacheMissCostPerMTok);

  // Determine if this is the initial commitment or a continuation
  const cyclesSpent = state.warmup?.warmupCount ?? 0;
  const isFirstWindow = elapsed < ttlMs;

  if (isFirstWindow) {
    // --- Phase A: Initial commitment ---
    // Cache is about to expire for the first time.

    // Cache still fresh — no warmup needed yet
    if (elapsed < ttlMs - warmupMarginMs) return false;

    // P(returns) too low to justify even one warmup
    if (pReturns <= threshold) {
      markDeadIfSurvivalLow(state, survivalAtIdle);
      return false;
    }

    return true;
  } else {
    // --- Phase B: Continuation ---
    // Cache already expired at least once. We're maintaining warmth
    // across a longer break. Check if still profitable.

    // Hard break-even cap: stop if we've spent too many cycles
    if (cyclesSpent >= maxCycles) {
      markDeadIfSurvivalLow(state, survivalAtIdle);
      return false;
    }

    // Session almost certainly finished — stop warming
    if (pFinished > 0.95) {
      markDeadIfSurvivalLow(state, survivalAtIdle);
      return false;
    }

    // Rising cost threshold: after k cycles, the accumulated warmup cost
    // means we need a higher P(returns) to justify the next one.
    // k=1: 8.7%, k=3: 26%, k=5: 43%, k=6: 52% for Opus 5m.
    const risingThreshold = cumulativeCostThreshold(
      cyclesSpent + 1, // +1 because we're deciding whether to do the NEXT cycle
      cacheReadCostPerMTok,
      cacheMissCostPerMTok,
    );
    if (pReturns <= risingThreshold) {
      markDeadIfSurvivalLow(state, survivalAtIdle);
      return false;
    }

    // Re-evaluate: expected remaining cycles must keep total under maxCycles
    const remaining = expectedWarmupCycles(blendedHist, elapsed, ttlMs, maxCycles - cyclesSpent);
    if (cyclesSpent + remaining > maxCycles) {
      markDeadIfSurvivalLow(state, survivalAtIdle);
      return false;
    }

    // Check we're in the warmup margin of the current TTL window
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;

    return true;
  }
}

/** Mark session dead if survival is below the dead session threshold. */
function markDeadIfSurvivalLow(state: SessionState, survivalAtIdle: number): void {
  if (survivalAtIdle < DEAD_SESSION_THRESHOLD) {
    if (!state.warmup) {
      state.warmup = { lastWarmupAt: 0, warmupCount: 0, totalWarmups: 0, warmupHits: 0, disabled: true };
    } else {
      state.warmup.disabled = true;
    }
    log.info(
      `cache-warmer: session=${state.sessionID.slice(0, 16)} marked dead ` +
        `(survival=${(survivalAtIdle * 100).toFixed(1)}% < ${(DEAD_SESSION_THRESHOLD * 100).toFixed(0)}%)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dashboard snapshot
// ---------------------------------------------------------------------------

/** All data the dashboard needs for one session's warming visualization. */
export type WarmingSnapshot = {
  sessionId: string;
  projectPath: string;
  // State
  messageCount: number;
  idleMs: number;
  consecutiveTextOnlyTurns: number;
  ttl: "5m" | "1h" | undefined;
  // Warmup state
  warmupCount: number;
  totalWarmups: number;
  warmupHits: number;
  lastWarmupAt: number;
  disabled: boolean;
  forceKeepWarm: boolean;
  // Survival analysis
  sessionHistogram: InterTurnHistogram;
  globalHistogram: InterTurnHistogram;
  blendedHistogram: InterTurnHistogram;
  sessionWeight: number;
  survivalAtIdle: number;
  // Commitment model
  pSessionFinished: number;
  pReturns: number;
  breakFrac: number;
  expectedCycles: number;
  maxCycles: number;
  cyclesSpent: number;
  warmingPhase: "initial" | "continuation" | "none";
  threshold: number;
  // Legacy (kept for backward compat in dashboard)
  pReturn: number;
  pReturnDampened: number;
  costThreshold: number;
  // Tool-call state
  toolCallActive: boolean;
  // Decision
  shouldWarmNow: boolean;
  notWarmingReason: string | null;
  // Circuit breaker (global, same for all sessions)
  circuitBreaker: { tripped: boolean; failures: number; maxFailures: number };
};

/**
 * Compute a read-only snapshot of all warming heuristics for a session.
 *
 * Used by the dashboard to render warming state without importing
 * internal functions. All calls are pure or idempotent (read-only).
 */
export function computeWarmingSnapshot(
  state: SessionState,
  now: number = Date.now(),
): WarmingSnapshot {
  const cfg = loreConfig();
  const idleMs = now - state.lastRequestTime;

  // Histograms
  const sessionHist = state.survivalModel ?? createHistogram();
  const pid = loadGlobalHistograms(state.projectPath);
  const globalHist = pid ? getGlobalHistogram(pid) : createHistogram();
  const blendedHist = blendHistograms(sessionHist, globalHist);
  const sessionWeight = Math.min(sessionHist.total / BLEND_PSEUDOCOUNT, 1.0);

  // Survival & return probability
  const survivalAtIdle = survivalFunction(blendedHist, idleMs);

  const profile = resolveProfile(
    state.lastModel,
    state.lastProtocol,
    state.resolvedConversationTTL,
  );
  const ttlMs = profile?.ttlMs ?? 300_000;
  const warmupMarginMs = profile?.warmupMarginMs ?? 45_000;

  // Legacy: conditional return probability (kept for dashboard backward compat)
  const pReturn = conditionalReturnProbability(blendedHist, idleMs, ttlMs);
  const textOnlyRuns = state.consecutiveTextOnlyTurns ?? 0;
  const pReturnDampened =
    textOnlyRuns > 0 ? pReturn * Math.pow(0.5, textOnlyRuns) : pReturn;

  // Commitment model signals
  const breakFrac = breakFraction(blendedHist);
  const totalTurns = Math.floor(state.messageCount / 2);
  const pFinished = pSessionFinished({
    survivalAtIdle,
    consecutiveTextOnlyTurns: textOnlyRuns,
    breakFraction: breakFrac,
    totalTurns,
    lastStopReason: state.lastStopReason,
  });
  const pReturns = 1.0 - pFinished;

  // Corrected threshold
  const autoThreshold = profile
    ? costThreshold(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok)
    : 0.1;
  const thresholdVal = cfg.cache.warming.minReturnProbability ?? autoThreshold;

  // Commitment model cost analysis
  const maxCyclesVal = profile
    ? maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok)
    : 0;
  const cyclesSpent = state.warmup?.warmupCount ?? 0;
  const expectedCycles = profile
    ? expectedWarmupCycles(blendedHist, idleMs, ttlMs, maxCyclesVal)
    : 0;

  // Determine warming phase
  const isFirstWindow = idleMs < ttlMs;
  const hasWarmed = cyclesSpent > 0;
  const warmingPhase: "initial" | "continuation" | "none" =
    isFirstWindow ? "initial" : hasWarmed ? "continuation" : "none";

  // Decision + reason
  const warmNow =
    profile != null &&
    shouldWarm(state, profile, blendedHist, now);

  let notWarmingReason: string | null = null;
  if (!warmNow) {
    if (circuitBreakerTripped) {
      notWarmingReason = "Circuit breaker tripped";
    } else if (state.isSubagent) {
      notWarmingReason = "Sub-agent session (ephemeral)";
    } else if (!cfg.cache.warming.enabled) {
      notWarmingReason = "Warming disabled in config";
    } else if (!state.cacheAnalytics.lastRequestBody) {
      notWarmingReason = "No stored request body";
    } else if (!profile) {
      notWarmingReason = "No warming profile (non-Anthropic or unknown model)";
    } else if (state.warmup?.forceKeepWarm) {
      const maxCyc = maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);
      if (cyclesSpent >= maxCyc) {
        notWarmingReason = `Force-keep: break-even exceeded (${cyclesSpent} >= ${maxCyc} cycles)`;
      } else {
        const intoWindow = idleMs % ttlMs;
        if (intoWindow < ttlMs - warmupMarginMs) {
          notWarmingReason = "Force-keep: not in warmup window yet";
        } else {
          notWarmingReason = "Force-keep: cooldown active";
        }
      }
    } else if (state.lastStopReason === "tool_use") {
      if (state.warmup?.disabled) {
        notWarmingReason = "Warming stopped (/lore:warm:stop)";
      } else if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) {
        notWarmingReason = `Too few turns (${state.messageCount} < ${MIN_TURNS_FOR_WARMING * 2})`;
      } else if (idleMs > MAX_TOOL_CALL_WARMING_MS) {
        notWarmingReason = `Tool call exceeded max duration (${Math.round(idleMs / 60_000)}min > 30min)`;
      } else if ((state.warmup?.totalWarmups ?? 0) >= MIN_WARMUPS_FOR_ROI_CHECK &&
                 (state.warmup?.warmupHits ?? 0) / (state.warmup?.totalWarmups ?? 1) < MIN_SESSION_HIT_RATE) {
        const hitRate = ((state.warmup?.warmupHits ?? 0) / (state.warmup?.totalWarmups ?? 1) * 100).toFixed(0);
        notWarmingReason = `Tool call: session hit rate too low (${hitRate}% < ${(MIN_SESSION_HIT_RATE * 100).toFixed(0)}%)`;
      } else {
        const maxCyc = maxProfitableCycles(profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);
        if ((state.warmup?.warmupCount ?? 0) >= maxCyc) {
          notWarmingReason = "Tool call: break-even exceeded";
        } else {
          const intoWindow = idleMs % ttlMs;
          notWarmingReason = intoWindow < ttlMs - warmupMarginMs
            ? "Tool call: not in warmup window yet"
            : "Tool call: cooldown active";
        }
      }
    } else if (state.warmup?.lastWarmupAt && now - state.warmup.lastWarmupAt < cooldownFor(state, ttlMs, warmupMarginMs)) {
      notWarmingReason = "Already warmed in this TTL window";
    } else if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) {
      notWarmingReason = `Too few turns (${state.messageCount} < ${MIN_TURNS_FOR_WARMING * 2})`;
    } else if (state.warmup?.disabled) {
      notWarmingReason = "Warming stopped (/lore:warm:stop)";
    } else if ((state.warmup?.totalWarmups ?? 0) >= MIN_WARMUPS_FOR_ROI_CHECK &&
               (state.warmup?.warmupHits ?? 0) / (state.warmup?.totalWarmups ?? 1) < MIN_SESSION_HIT_RATE) {
      const hitRate = ((state.warmup?.warmupHits ?? 0) / (state.warmup?.totalWarmups ?? 1) * 100).toFixed(0);
      notWarmingReason = `Session hit rate too low (${hitRate}% < ${(MIN_SESSION_HIT_RATE * 100).toFixed(0)}% after ${state.warmup?.totalWarmups} warmups)`;
    } else if (isFirstWindow && idleMs < ttlMs - warmupMarginMs) {
      notWarmingReason = "Cache still fresh";
    } else if (pReturns <= thresholdVal) {
      notWarmingReason = `P(returns) ${(pReturns * 100).toFixed(1)}% <= threshold ${(thresholdVal * 100).toFixed(1)}%`;
    } else if (!isFirstWindow && cyclesSpent >= maxCyclesVal) {
      notWarmingReason = `Break-even exceeded (${cyclesSpent} >= ${maxCyclesVal} cycles)`;
    } else if (!isFirstWindow && pFinished > 0.95) {
      notWarmingReason = `Session finished (P=${(pFinished * 100).toFixed(0)}%)`;
    } else if (!isFirstWindow) {
      const risingThresh = cumulativeCostThreshold(cyclesSpent + 1, profile.cacheReadCostPerMTok, profile.cacheMissCostPerMTok);
      if (pReturns <= risingThresh) {
        notWarmingReason = `Rising threshold: P(returns) ${(pReturns * 100).toFixed(1)}% <= ${(risingThresh * 100).toFixed(1)}% at cycle ${cyclesSpent + 1}`;
      } else {
        notWarmingReason = "Unknown";
      }
    } else {
      notWarmingReason = "Unknown";
    }
  }

  return {
    sessionId: state.sessionID,
    projectPath: state.projectPath,
    messageCount: state.messageCount,
    idleMs,
    consecutiveTextOnlyTurns: textOnlyRuns,
    ttl: state.resolvedConversationTTL,
    warmupCount: cyclesSpent,
    totalWarmups: state.warmup?.totalWarmups ?? 0,
    warmupHits: state.warmup?.warmupHits ?? 0,
    lastWarmupAt: state.warmup?.lastWarmupAt ?? 0,
    disabled: state.warmup?.disabled ?? false,
    forceKeepWarm: state.warmup?.forceKeepWarm ?? false,
    sessionHistogram: sessionHist,
    globalHistogram: globalHist,
    blendedHistogram: blendedHist,
    sessionWeight,
    survivalAtIdle,
    // Commitment model
    pSessionFinished: pFinished,
    pReturns,
    breakFrac,
    expectedCycles,
    maxCycles: maxCyclesVal,
    cyclesSpent,
    warmingPhase,
    threshold: thresholdVal,
    // Legacy
    pReturn,
    pReturnDampened,
    costThreshold: thresholdVal,
    // Tool-call state
    toolCallActive: state.lastStopReason === "tool_use" && idleMs <= MAX_TOOL_CALL_WARMING_MS && !state.warmup?.disabled,
    // Decision
    shouldWarmNow: warmNow,
    notWarmingReason,
    circuitBreaker: getCircuitBreakerStatus(),
  };
}

/** Cooldown between warmups — must match shouldWarm() logic. */
function cooldownFor(_state: SessionState, ttlMs: number, warmupMarginMs: number): number {
  return Math.max(ttlMs - warmupMarginMs, 0);
}

// ---------------------------------------------------------------------------
// Warmup execution
// ---------------------------------------------------------------------------

/**
 * Extract the first user message text from a serialized request body.
 * Used for cch re-signing (version suffix depends on first user chars).
 */
function extractFirstUserText(bodyJson: string): string {
  try {
    const body = JSON.parse(bodyJson);
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role !== "user") continue;
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              return block.text;
            }
          }
        }
      }
    }
  } catch {
    // Parse failure — return empty
  }
  return "";
}

/**
 * Execute a cache warmup for a session.
 *
 * Decompresses the stored request body, patches it for warmup
 * (max_tokens:0, stream:false), re-signs the cch billing header,
 * and sends it to the upstream provider.
 *
 * Returns the result for circuit breaker checking and metrics.
 */
export async function executeWarmup(
  state: SessionState,
  profile: CacheWarmingProfile,
): Promise<WarmupResult> {
  const noResult: WarmupResult = { ok: false, cacheReadTokens: 0, cacheCreationTokens: 0 };

  const { lastRequestBody } = state.cacheAnalytics;
  if (!lastRequestBody) return noResult;

  // Decompress the stored body
  const storedBody = decompressBody(lastRequestBody);

  // Prepare for warmup (max_tokens:0, strip incompatible fields)
  const warmupBody = profile.prepareWarmupBody(storedBody);

  // Resolve auth for this session
  const cred = resolveAuth(state.sessionID);
  if (!cred) {
    log.warn(`cache-warmer: no auth for session=${state.sessionID.slice(0, 16)}, skipping`);
    return noResult;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...authHeaders(cred),
  };

  // Forward anthropic-beta from the last real request so beta-gated body
  // fields (e.g. context_management) are accepted by the upstream API.
  if (state.lastAnthropicBeta) {
    headers["anthropic-beta"] = state.lastAnthropicBeta;
  }

  // Re-sign the cch billing header. The cch hash covers the entire
  // serialized body, and we changed max_tokens/stream. The cch is
  // billing verification only — NOT part of the cache key.
  const firstUserText = extractFirstUserText(storedBody);
  const signedBody = resignBody(warmupBody, firstUserText);

  log.info(
    `cache-warmer: sending warmup for session=${state.sessionID.slice(0, 16)} ` +
      `model=${state.lastModel} ttl=${profile.ttlMs / 1000}s`,
  );

  try {
    const response = await fetch(profile.upstreamUrl, {
      method: "POST",
      headers,
      body: signedBody,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.error(
        `cache-warmer: upstream error ${response.status} for ` +
          `session=${state.sessionID.slice(0, 16)}: ${errorBody.slice(0, 300)}`,
      );
      return { ok: false, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }

    // Parse the response to extract usage
    const resp = (await response.json()) as {
      usage?: {
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        input_tokens?: number;
      };
      stop_reason?: string;
    };

    const inputTokens = resp.usage?.input_tokens ?? 0;
    const cacheReadTokens = resp.usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = resp.usage?.cache_creation_input_tokens ?? 0;
    const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;

    const result: WarmupResult = {
      ok: true,
      cacheReadTokens,
      cacheCreationTokens,
    };

    // Compute cost estimate for this warmup
    const readCost = (cacheReadTokens / 1_000_000) * profile.cacheReadCostPerMTok;
    const writeCost = (cacheCreationTokens / 1_000_000) * profile.cacheMissCostPerMTok;
    const warmupCost = readCost + writeCost;
    const costStr = `$${warmupCost.toFixed(4)}`;

    // Log the outcome with full cache statistics
    const sid = state.sessionID.slice(0, 16);
    const hitRate = totalInput > 0
      ? `${((cacheReadTokens / totalInput) * 100).toFixed(0)}%`
      : "N/A";

    if (cacheReadTokens > 0 && cacheCreationTokens === 0) {
      log.info(
        `cache-warmer: ✓ refresh session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} hit=${hitRate} cost=${costStr}`,
      );
    } else if (cacheReadTokens > 0 && cacheCreationTokens > 0) {
      // Partial hit — some breakpoints read, some written (e.g. conversation
      // breakpoint expired but system/tools still cached). This is fine.
      log.info(
        `cache-warmer: ~ partial session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} cacheWrite=${cacheCreationTokens} ` +
          `hit=${hitRate} cost=${costStr}`,
      );
    } else {
      log.warn(
        `cache-warmer: ✗ UNCACHED session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} cacheWrite=${cacheCreationTokens} ` +
          `cost=${costStr} — warmup body may not match cached prefix`,
      );
    }

    // Accumulate warmup cost for the session
    const ttl: "5m" | "1h" = profile.ttlMs >= 3_600_000 ? "1h" : "5m";
    recordWarmupCost(
      state.sessionID,
      state.lastModel ?? "unknown",
      cacheReadTokens,
      cacheCreationTokens,
      ttl,
    );

    // Update session warmup state
    if (!state.warmup) {
      state.warmup = { lastWarmupAt: 0, warmupCount: 0, totalWarmups: 0, warmupHits: 0, disabled: false };
    }
    state.warmup.lastWarmupAt = Date.now();
    state.warmup.warmupCount++;
    state.warmup.totalWarmups = (state.warmup.totalWarmups ?? 0) + 1;

    // Check circuit breaker
    checkCircuitBreaker(result);

    return result;
  } catch (e) {
    log.error(`cache-warmer: fetch error for session=${state.sessionID.slice(0, 16)}:`, e);
    return noResult;
  }
}

// ---------------------------------------------------------------------------
// Global histogram persistence (SQLite)
// ---------------------------------------------------------------------------

/** Tracks which project IDs have been modified since last flush. */
const dirtyProjects = new Set<string>();

/**
 * Load persisted global histograms for a project from SQLite.
 *
 * Called once per project on first access. Populates the in-memory
 * globalHistograms map so survival analysis has data immediately after
 * a gateway restart.
 *
 * Returns the resolved project_id (UUID) so callers can reuse it
 * without a redundant `projectId()` query, or `undefined` if the
 * project is not yet in the DB.
 *
 * Backward compatibility: if the DB contains old time-slot-segmented rows
 * (work/evening/night), they are merged by summing bin counts into a single
 * histogram. New data is written under the "all" time_slot key.
 */
export function loadGlobalHistograms(projectPath: string): string | undefined {
  const pid = projectId(projectPath);
  if (!pid) return undefined; // project not yet in DB — nothing to load

  if (globalHistograms.has(pid)) return pid; // already loaded

  const merged = createHistogram();

  try {
    const rows = db()
      .query("SELECT time_slot, counts, total FROM warmup_histograms WHERE project_id = ?")
      .all(pid) as Array<{ time_slot: string; counts: string; total: number }>;

    for (const row of rows) {
      try {
        const counts = JSON.parse(row.counts) as number[];
        if (Array.isArray(counts) && counts.length === BIN_COUNT) {
          // Merge this row into the single histogram (handles both old
          // slot-segmented rows and the new "all" row).
          for (let i = 0; i < BIN_COUNT; i++) {
            merged.counts[i] += counts[i];
          }
          merged.total += row.total;
        }
      } catch {
        // Corrupt JSON — skip this row
      }
    }

    log.info(
      `cache-warmer: loaded global histogram for project=${projectPath.slice(-30)} ` +
        `(${merged.total} observations)`,
    );
  } catch (e) {
    log.warn("cache-warmer: failed to load global histograms:", e);
  }

  globalHistograms.set(pid, merged);
  return pid;
}

/**
 * Flush dirty global histograms to SQLite.
 *
 * Designed to be called periodically (e.g. every 60s from the idle
 * scheduler) rather than on every recordGap call, to avoid write
 * amplification on a hot path.
 *
 * Writes a single row per project under time_slot="all". Old slot-segmented
 * rows (work/evening/night) are deleted on first flush to avoid double-counting
 * on the next load.
 */
export function flushGlobalHistograms(): void {
  if (dirtyProjects.size === 0) return;

  const d = db();
  const now = Date.now();

  for (const pid of dirtyProjects) {
    const hist = globalHistograms.get(pid);
    if (!hist) continue;

    try {
      // Atomic: delete old slot rows + upsert the unified "all" row.
      // Without the transaction, a crash between DELETE and INSERT
      // would lose all histogram data for this project.
      d.exec("BEGIN");
      try {
        // Delete old slot-segmented rows (backward compat cleanup)
        d.query(
          "DELETE FROM warmup_histograms WHERE project_id = ? AND time_slot != 'all'",
        ).run(pid);

        d.query(
          `INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at)
           VALUES (?, 'all', ?, ?, ?)
           ON CONFLICT(project_id, time_slot) DO UPDATE SET
             counts = excluded.counts,
             total = excluded.total,
             updated_at = excluded.updated_at`,
        ).run(pid, JSON.stringify(hist.counts), hist.total, now);
        d.exec("COMMIT");
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      log.warn(`cache-warmer: failed to flush histogram:`, e);
    }
  }

  dirtyProjects.clear();
}

/**
 * Record an inter-turn gap in a global histogram, with dirty tracking.
 *
 * Wraps the base `recordGap` to also mark the histogram for periodic
 * SQLite flush.
 */
export function recordGlobalGap(
  projectPath: string,
  gapMs: number,
): void {
  const pid = loadGlobalHistograms(projectPath); // ensure loaded; resolves pid
  if (!pid) return; // project not yet in DB — skip
  const hist = getGlobalHistogram(pid);
  recordGap(hist, gapMs);
  dirtyProjects.add(pid);
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

/** Read-only snapshot of all loaded global histograms, keyed by project_id (for dashboard). */
export function getGlobalHistogramsSnapshot(): ReadonlyMap<string, InterTurnHistogram> {
  return globalHistograms;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  circuitBreakerFailures = 0;
  circuitBreakerTripped = false;
  circuitBreakerLoaded = true; // Mark as loaded so it doesn't re-read stale DB state
  try { setKV(CB_KV_KEY, JSON.stringify({ tripped: false, failures: 0 })); } catch { /* DB may not be available in all test contexts */ }
  globalHistograms.clear();
  dirtyProjects.clear();
}
