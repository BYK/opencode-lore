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

import { log, config as loreConfig, db, projectId } from "@loreai/core";
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

/** Max uncached warmup responses before the global circuit breaker trips. */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;

// ---------------------------------------------------------------------------
// Global circuit breaker
// ---------------------------------------------------------------------------

let circuitBreakerFailures = 0;
let circuitBreakerTripped = false;

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
  return circuitBreakerTripped;
}

/** Snapshot of circuit breaker state for dashboard rendering. */
export function getCircuitBreakerStatus(): {
  tripped: boolean;
  failures: number;
  maxFailures: number;
} {
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
  if (circuitBreakerTripped) return true;

  if (result.ok && result.cacheCreationTokens > 0 && result.cacheReadTokens === 0) {
    circuitBreakerFailures++;
    log.error(
      `cache-warmer CIRCUIT BREAKER: warmup caused uncached write ` +
        `(${circuitBreakerFailures}/${CIRCUIT_BREAKER_MAX_FAILURES}). ` +
        `cacheCreation=${result.cacheCreationTokens} cacheRead=${result.cacheReadTokens}`,
    );
    if (circuitBreakerFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      circuitBreakerTripped = true;
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

/** Global histograms keyed by projectPath. */
const globalHistograms = new Map<string, InterTurnHistogram>();

export function getGlobalHistogram(
  projectPath: string,
): InterTurnHistogram {
  let hist = globalHistograms.get(projectPath);
  if (!hist) {
    hist = createHistogram();
    globalHistograms.set(projectPath, hist);
  }
  return hist;
}

/** Get blended histogram for a session (session + global). */
export function blendedHistogramForSession(
  state: SessionState,
): InterTurnHistogram {
  const sessionHist = getSessionHistogram(state);
  const globalHist = getGlobalHistogram(state.projectPath);
  return blendHistograms(sessionHist, globalHist);
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
  const cacheWriteCost = entry.cost?.cache_write ?? (entry.cost?.input ?? 3) * 1.25;

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
 * Returns true if all conditions are met:
 *  1. Cache is about to expire (within warmupMargin of TTL)
 *  2. Cache hasn't already expired (past TTL)
 *  3. Session has enough turns (≥3) for reliable survival prediction
 *  4. Session is not marked dead
 *  5. Session hasn't been warmed in this TTL window
 *  6. Survival probability exceeds cost threshold
 *  7. Global circuit breaker hasn't tripped
 */
export function shouldWarm(
  state: SessionState,
  profile: CacheWarmingProfile,
  blendedHist: InterTurnHistogram,
  now: number = Date.now(),
): boolean {
  // Global kill switch — always respected, even with /keep
  if (circuitBreakerTripped) return false;

  const cfg = loreConfig();
  if (!cfg.cache.warming.enabled) return false;

  // No stored body to replay — nothing to warm
  if (!state.cacheAnalytics.lastRequestBody) return false;

  const elapsed = now - state.lastRequestTime;
  const { ttlMs, warmupMarginMs } = profile;
  const forced = state.warmup?.forceKeepWarm === true;

  // Already warmed recently — prevent double-warming.
  // For /keep mode, use a tighter cooldown (ttlMs - warmupMarginMs) so the
  // next warmup fires before the current cache expires. Without this, the
  // full-ttlMs guard combined with margin positioning produces a ~2x TTL
  // cadence (e.g. 10 min on a 5 min TTL), leaving a dead zone each cycle.
  const cooldownMs = forced ? Math.max(ttlMs - warmupMarginMs, 0) : ttlMs;
  if (state.warmup?.lastWarmupAt && (now - state.warmup.lastWarmupAt) < cooldownMs) {
    return false;
  }

  if (forced) {
    // /keep mode: only requirement is that we're within the warmup margin
    // of *some* TTL window. Compute which window we're in relative to
    // lastRequestTime (each window is ttlMs wide) and check if we're in
    // the last warmupMarginMs of that window.
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;
    return true;
  }

  // --- Normal (non-forced) path ---

  // Cache still fresh — no warmup needed yet
  if (elapsed < ttlMs - warmupMarginMs) return false;

  // Cache already expired — warmup is pointless (would cause a write, not a read)
  if (elapsed >= ttlMs) return false;

  // Not enough turns — survival model has insufficient data and the
  // session may be a one-shot question not worth warming ($0.30 per
  // wasted warmup at 200K Opus tokens).
  if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) return false;

  // Session marked dead
  if (state.warmup?.disabled) return false;

  // Survival check: P(return within next TTL window | idle for `elapsed`)
  let pReturn = conditionalReturnProbability(blendedHist, elapsed, ttlMs);

  // Dampen survival estimate based on consecutive text-only end_turn
  // responses. Each consecutive text-only turn halves the probability —
  // the model finishing with text (no tool calls) multiple times in a
  // row suggests the task is wrapping up.
  const textOnlyRuns = state.consecutiveTextOnlyTurns ?? 0;
  if (textOnlyRuns > 0) {
    pReturn *= Math.pow(0.5, textOnlyRuns);
  }

  // Cost threshold: warm if P(return) > cacheReadCost / cacheMissCost
  // This is the break-even point where expected savings = 0.
  const autoThreshold =
    profile.cacheReadCostPerMTok / profile.cacheMissCostPerMTok;
  const threshold = cfg.cache.warming.minReturnProbability ?? autoThreshold;

  if (pReturn <= threshold) {
    // Check if session should be marked dead
    const survival = survivalFunction(blendedHist, elapsed);
    if (survival < DEAD_SESSION_THRESHOLD) {
      if (!state.warmup) {
        state.warmup = { lastWarmupAt: 0, warmupCount: 0, warmupHits: 0, disabled: true };
      } else {
        state.warmup.disabled = true;
      }
      log.info(
        `cache-warmer: session=${state.sessionID.slice(0, 16)} marked dead ` +
          `(survival=${(survival * 100).toFixed(1)}% < ${(DEAD_SESSION_THRESHOLD * 100).toFixed(0)}%)`,
      );
    }
    return false;
  }

  return true;
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
  pReturn: number;
  pReturnDampened: number;
  costThreshold: number;
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
  loadGlobalHistograms(state.projectPath);
  const globalHist = getGlobalHistogram(state.projectPath);
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

  const pReturn = conditionalReturnProbability(blendedHist, idleMs, ttlMs);
  const textOnlyRuns = state.consecutiveTextOnlyTurns ?? 0;
  const pReturnDampened =
    textOnlyRuns > 0 ? pReturn * Math.pow(0.5, textOnlyRuns) : pReturn;

  // Threshold
  const autoThreshold = profile
    ? profile.cacheReadCostPerMTok / profile.cacheMissCostPerMTok
    : 0.1;
  const costThreshold = cfg.cache.warming.minReturnProbability ?? autoThreshold;

  // Decision + reason
  const warmNow =
    profile != null &&
    shouldWarm(state, profile, blendedHist, now);

  let notWarmingReason: string | null = null;
  if (!warmNow) {
    if (circuitBreakerTripped) {
      notWarmingReason = "Circuit breaker tripped";
    } else if (!cfg.cache.warming.enabled) {
      notWarmingReason = "Warming disabled in config";
    } else if (!state.cacheAnalytics.lastRequestBody) {
      notWarmingReason = "No stored request body";
    } else if (!profile) {
      notWarmingReason = "No warming profile (non-Anthropic or unknown model)";
    } else if (state.warmup?.forceKeepWarm) {
      const intoWindow = idleMs % ttlMs;
      if (intoWindow < ttlMs - warmupMarginMs) {
        notWarmingReason = "Force-keep: not in warmup window yet";
      }
    } else if (state.warmup?.lastWarmupAt && now - state.warmup.lastWarmupAt < ttlMs) {
      notWarmingReason = "Already warmed in this TTL window";
    } else if (idleMs < ttlMs - warmupMarginMs) {
      notWarmingReason = "Cache still fresh";
    } else if (idleMs >= ttlMs) {
      notWarmingReason = "Cache already expired";
    } else if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) {
      notWarmingReason = `Too few turns (${state.messageCount} < ${MIN_TURNS_FOR_WARMING * 2})`;
    } else if (state.warmup?.disabled) {
      notWarmingReason = "Session marked dead";
    } else if (pReturnDampened <= costThreshold) {
      notWarmingReason = `P(return) ${(pReturnDampened * 100).toFixed(1)}% <= threshold ${(costThreshold * 100).toFixed(1)}%`;
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
    warmupCount: state.warmup?.warmupCount ?? 0,
    warmupHits: state.warmup?.warmupHits ?? 0,
    lastWarmupAt: state.warmup?.lastWarmupAt ?? 0,
    disabled: state.warmup?.disabled ?? false,
    forceKeepWarm: state.warmup?.forceKeepWarm ?? false,
    sessionHistogram: sessionHist,
    globalHistogram: globalHist,
    blendedHistogram: blendedHist,
    sessionWeight,
    survivalAtIdle,
    pReturn,
    pReturnDampened,
    costThreshold,
    shouldWarmNow: warmNow,
    notWarmingReason,
    circuitBreaker: getCircuitBreakerStatus(),
  };
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
    recordWarmupCost(
      state.sessionID,
      state.lastModel ?? "unknown",
      cacheReadTokens,
      cacheCreationTokens,
    );

    // Update session warmup state
    if (!state.warmup) {
      state.warmup = { lastWarmupAt: 0, warmupCount: 0, warmupHits: 0, disabled: false };
    }
    state.warmup.lastWarmupAt = Date.now();
    state.warmup.warmupCount++;

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

/** Tracks which projects have been modified since last flush. */
const dirtyProjects = new Set<string>();

/**
 * Load persisted global histograms for a project from SQLite.
 *
 * Called once per project on first access. Populates the in-memory
 * globalHistograms map so survival analysis has data immediately after
 * a gateway restart.
 *
 * Backward compatibility: if the DB contains old time-slot-segmented rows
 * (work/evening/night), they are merged by summing bin counts into a single
 * histogram. New data is written under the "all" time_slot key.
 */
export function loadGlobalHistograms(projectPath: string): void {
  if (globalHistograms.has(projectPath)) return; // already loaded

  const merged = createHistogram();
  const pid = projectId(projectPath);
  if (!pid) {
    globalHistograms.set(projectPath, merged);
    return;
  }

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

  globalHistograms.set(projectPath, merged);
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

  for (const projectPath of dirtyProjects) {
    const pid = projectId(projectPath);
    if (!pid) continue;

    const hist = globalHistograms.get(projectPath);
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
  loadGlobalHistograms(projectPath); // ensure loaded
  const hist = getGlobalHistogram(projectPath);
  recordGap(hist, gapMs);
  dirtyProjects.add(projectPath);
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

/** Read-only snapshot of all loaded global histograms (for dashboard). */
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
  globalHistograms.clear();
  dirtyProjects.clear();
}
