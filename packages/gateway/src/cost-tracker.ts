/**
 * Per-session cost accumulation and counterfactual savings estimation.
 *
 * Tracks actual spend across conversation turns and worker calls, and
 * estimates what each session *would* have cost without Lore's optimizations
 * (cache warming, 1h TTL, batch API, distillation replacing compaction).
 *
 * All estimates use the synchronous pricing cache from worker-model.ts —
 * no async or extra LLM calls. Costs are accumulated in memory and can be
 * surfaced via the /ui dashboard or emitted as Sentry metrics.
 */

import { getModelEntrySync, getWorkerModel } from "./worker-model";
import { AUTOCOMPACT_THRESHOLD } from "./compaction";
import { log, data, temporal, loadAllSessionCosts } from "@loreai/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cost breakdown for a single LLM call. */
export type CallCost = {
  /** Total USD cost of this call. */
  total: number;
  /** Uncached input cost. */
  inputCost: number;
  /** Cache read cost. */
  cacheReadCost: number;
  /** Cache write cost. */
  cacheWriteCost: number;
  /** Output token cost. */
  outputCost: number;
};

/** Accumulated costs for a session. */
export type SessionCosts = {
  // --- Conversation (user-facing turns) ---
  conversation: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    turns: number;
  };

  // --- Worker overhead (Lore background tasks) ---
  workers: {
    distillation: { cost: number; calls: number };
    curation: { cost: number; calls: number };
    compaction: { cost: number; calls: number };
    recall: { cost: number; calls: number };
    warmup: { cost: number; calls: number };
  };

  /** Dollar savings from batch API (50% discount on batched worker calls). */
  batchSavings: number;

  // --- Counterfactual savings estimation ---
  counterfactual: {
    /** Cost of cache writes that warming prevented (user returned within TTL). */
    warmupSavings: number;
    /** Number of confirmed warmup hits. */
    warmupHits: number;
    /** Cost saved by 1h TTL — cache reads that would have been writes at 5m TTL. */
    ttlSavings: number;
    /** Number of turns that benefited from 1h TTL. */
    ttlHits: number;
    /** Number of compactions that *would* have triggered without Lore distillation. */
    avoidedCompactions: number;
    /** Estimated cost of those avoided compactions. */
    avoidedCompactionCost: number;
  };

  /** Shadow context counter — tracks virtual uncompressed context growth for compaction estimation. */
  _shadowContextTokens: number;
  /** Previous turn's actual (compressed) input tokens — for delta estimation. */
  _lastActualInput: number;
  /** Previous turn's output tokens (always uncompressed) — for growth estimation. */
  _lastOutputTokens: number;
};

/** Backdated historical estimates from stored data. */
export type HistoricalEstimates = {
  /** Per-session backdated estimates. */
  sessions: Array<{
    projectPath: string;
    projectName: string | null;
    projectId: string;
    sessionId: string;
    messageCount: number;
    firstMessage: number;
    lastMessage: number;
    /** Estimated distillation overhead from stored records. */
    distillationCost: number;
    distillationCalls: number;
    distillationBatchCalls: number;
    distillationDirectCalls: number;
    /** Estimated avoided compactions from shadow context simulation. */
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    /** Model used (from metadata of first message, or fallback). */
    model: string;
    /** Persisted live-session cost data (null if not available for this session). */
    persisted: {
      conversationCost: number;
      workerCost: number;
      conversationTurns: number;
      warmupSavings: number;
      warmupHits: number;
      ttlSavings: number;
      ttlHits: number;
      batchSavings: number;
      avoidedCompactions: number;
      avoidedCompactionCost: number;
    } | null;
  }>;
  /** Totals across all sessions. */
  totals: {
    distillationCost: number;
    distillationCalls: number;
    distillationBatchCalls: number;
    distillationDirectCalls: number;
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    warmupSavings: number;
    warmupHits: number;
    ttlSavings: number;
    ttlHits: number;
    batchSavings: number;
    sessionCount: number;
    messageCount: number;
    /**
     * Total worker cost using persisted real API data where available,
     * falling back to heuristic distillation estimates for sessions
     * without a persisted snapshot.
     */
    totalWorkerCost: number;
    /** Persisted conversation cost (from sessions that went idle). */
    persistedConversationCost: number;
  };
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Per-session cost accumulators. Keyed by internal sessionID. */
const sessions = new Map<string, SessionCosts>();

/** Cached historical estimates (computed once, refreshed on demand). */
let historicalCache: HistoricalEstimates | null = null;
let historicalCacheAt = 0;
const HISTORICAL_CACHE_TTL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function emptyCosts(): SessionCosts {
  return {
    conversation: {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    },
    workers: {
      distillation: { cost: 0, calls: 0 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0, calls: 0 },
      warmup: { cost: 0, calls: 0 },
    },
    batchSavings: 0,
    counterfactual: {
      warmupSavings: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    },
    _shadowContextTokens: 0,
    _lastActualInput: 0,
    _lastOutputTokens: 0,
  };
}

function getOrCreate(sessionID: string): SessionCosts {
  let costs = sessions.get(sessionID);
  if (!costs) {
    costs = emptyCosts();
    sessions.set(sessionID, costs);
  }
  return costs;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type Pricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

/**
 * Get pricing for a model from the sync cache.
 * Falls back to sensible defaults (same logic as sentry.ts getPricing).
 */
export function getPricingSync(model: string): Pricing {
  const entry = getModelEntrySync(model);
  const input = entry.cost?.input ?? 3;
  return {
    input,
    output: entry.cost?.output ?? 15,
    cache_read: entry.cost?.cache_read ?? input * 0.1,
    cache_write: entry.cost?.cache_write ?? input * 1.25,
  };
}

/**
 * Compute the USD cost breakdown for an LLM call.
 *
 * This is the single source of truth for cost computation — used by both
 * the accumulator (sync, hot path) and Sentry metrics emission.
 */
export function computeCallCost(
  model: string,
  usage: Usage,
  callType: "conversation" | "direct" | "batch",
): CallCost {
  const pricing = getPricingSync(model);
  const batchMultiplier = callType === "batch" ? 0.5 : 1.0;

  const inputCost =
    ((usage.input_tokens ?? 0) / 1_000_000) * pricing.input * batchMultiplier;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cache_read;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cache_write;
  const outputCost =
    ((usage.output_tokens ?? 0) / 1_000_000) * pricing.output * batchMultiplier;

  return {
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
  };
}

// ---------------------------------------------------------------------------
// Accumulation — called from pipeline, LLM adapter, batch queue, warmup
// ---------------------------------------------------------------------------

/**
 * Record a conversation turn's cost (called from postResponse).
 */
export function recordConversationCost(
  sessionID: string,
  model: string,
  usage: Usage,
): void {
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, "conversation");
  costs.conversation.cost += call.total;
  costs.conversation.inputTokens += usage.input_tokens ?? 0;
  costs.conversation.outputTokens += usage.output_tokens ?? 0;
  costs.conversation.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  costs.conversation.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  costs.conversation.turns++;
}

/** Worker ID → cost bucket mapping. */
type WorkerBucket = keyof SessionCosts["workers"];

const WORKER_BUCKETS: Record<string, WorkerBucket> = {
  "lore-distill": "distillation",
  "lore-curator": "curation",
  "lore-compact": "compaction",
  "lore-query-expand": "recall",
};

/**
 * Record a worker LLM call's cost (called from LLM adapter / batch queue).
 */
export function recordWorkerCost(
  sessionID: string | undefined,
  model: string,
  usage: Usage,
  callType: "direct" | "batch",
  workerID?: string,
): void {
  if (!sessionID) return;
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, callType);

  const bucket = WORKER_BUCKETS[workerID ?? ""] ?? "distillation";
  costs.workers[bucket].cost += call.total;
  costs.workers[bucket].calls++;

  // Track batch savings: how much more this would have cost at full price
  if (callType === "batch") {
    const fullCost = computeCallCost(model, usage, "direct");
    costs.batchSavings += fullCost.total - call.total;
  }
}

/**
 * Record a cache warmup cost (called from executeWarmup).
 *
 * @param ttl - Cache TTL for this session. Anthropic charges 2× cache_write
 *   for 1h TTL; without this parameter the cost is undercounted by 50%.
 */
export function recordWarmupCost(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  ttl?: "5m" | "1h",
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  const readCost = (cacheReadTokens / 1_000_000) * pricing.cache_read;
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate = ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
  const writeCost = (cacheCreationTokens / 1_000_000) * cacheWriteRate;
  costs.workers.warmup.cost += readCost + writeCost;
  costs.workers.warmup.calls++;
}

// ---------------------------------------------------------------------------
// Counterfactual tracking
// ---------------------------------------------------------------------------

/** Estimated post-compaction context size in tokens. */
const POST_COMPACTION_CONTEXT = 30_000;

/**
 * Estimate the total cost of a single compaction event.
 *
 * Includes three components:
 * 1. Force-distill pass: ~10K input, ~2K output (at worker model rates)
 * 2. Compaction LLM call: ~20K input, ~5K output (at worker model rates)
 * 3. Cache bust penalty: after compaction, the entire post-compaction context
 *    (~30K tokens) must be re-written to the prompt cache at cache_write rates
 *    on the conversation model. Without compaction, these tokens would have
 *    been served from cache_read.
 */
function estimateCompactionCost(
  workerModel: string,
  conversationModel?: string,
): number {
  const wPricing = getPricingSync(workerModel);
  // Force-distill: ~10K input, ~2K output
  const distillCost =
    (10_000 / 1_000_000) * wPricing.input + (2_000 / 1_000_000) * wPricing.output;
  // Compaction LLM call: ~20K input, ~5K output
  const compactCost =
    (20_000 / 1_000_000) * wPricing.input + (5_000 / 1_000_000) * wPricing.output;

  // Cache bust: post-compaction context (~POST_COMPACTION_CONTEXT tokens) must
  // be re-written to cache. The penalty is the difference between cache_write
  // and cache_read pricing on the conversation model.
  let cacheBustCost = 0;
  if (conversationModel) {
    const cPricing = getPricingSync(conversationModel);
    cacheBustCost =
      (POST_COMPACTION_CONTEXT / 1_000_000) *
      (cPricing.cache_write - cPricing.cache_read);
  }

  return distillCost + compactCost + cacheBustCost;
}

/**
 * Update the shadow context counter after a conversation turn.
 *
 * Maintains a virtual "what would context size be without Lore?" counter
 * using additive growth tracking. Instead of snapshotting the compressed
 * API token count (which underestimates because Lore's gradient manager
 * already trimmed the context), we accumulate per-turn growth from
 * uncompressed signals:
 *
 * - Output tokens are always uncompressed (the model's full response).
 * - The previous turn's output becomes part of the next turn's context.
 * - New user input is estimated from the delta in actual input tokens.
 *
 * When the shadow counter crosses the compaction threshold, a
 * counterfactual compaction event is recorded and the counter resets.
 *
 * @param totalInputTokens - Total input tokens for this turn (input + cache_read + cache_write)
 * @param outputTokens - Output tokens for this turn (always uncompressed)
 * @param workerModel - Model ID used for worker calls (for compaction cost estimation)
 */
export function updateShadowContext(
  sessionID: string,
  totalInputTokens: number,
  outputTokens: number,
  workerModel: string,
  conversationModel?: string,
): void {
  const costs = getOrCreate(sessionID);

  // On first turn, initialize shadow context to the actual input size.
  // No compression has happened yet, so the actual count is accurate.
  // NOTE: this check relies on recordConversationCost() having already
  // incremented turns for this turn (called earlier in postResponse).
  if (costs.conversation.turns <= 1) {
    costs._shadowContextTokens = totalInputTokens;
    costs._lastActualInput = totalInputTokens;
    costs._lastOutputTokens = outputTokens;
    return;
  }

  // Estimate uncompressed context growth since the last turn.
  // Growth is at least prevOutput (the assistant's response is always
  // added to context, uncompressed) and at most inputDelta (when new
  // user content exceeds the response size). If gradient compression
  // makes the delta negative, we fall back to prevOutput as the floor.
  const inputDelta = totalInputTokens - costs._lastActualInput;
  const prevOutput = costs._lastOutputTokens;
  const growth = Math.max(inputDelta, prevOutput);

  costs._shadowContextTokens += growth;
  costs._lastActualInput = totalInputTokens;
  costs._lastOutputTokens = outputTokens;

  if (costs._shadowContextTokens > AUTOCOMPACT_THRESHOLD) {
    costs.counterfactual.avoidedCompactions++;
    costs.counterfactual.avoidedCompactionCost +=
      estimateCompactionCost(workerModel, conversationModel);
    costs._shadowContextTokens = POST_COMPACTION_CONTEXT;
    log.info(
      `cost-tracker: shadow compaction #${costs.counterfactual.avoidedCompactions} ` +
        `for session=${sessionID.slice(0, 16)} — est. cost=$${costs.counterfactual.avoidedCompactionCost.toFixed(4)}`,
    );
  }
}

/**
 * Record a confirmed warmup hit — user returned after a cache warming ping.
 *
 * The counterfactual: without warming, the cache would have expired and
 * the next request would pay full cache_write cost instead of cache_read.
 *
 * @param cacheReadTokens - Cache read tokens from the turn that confirmed the hit
 * @param ttl - Cache TTL for this session. Anthropic charges 2× cache_write
 *   for 1h TTL; without this parameter savings are undercounted.
 */
export function recordWarmupHit(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
  ttl?: "5m" | "1h",
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate = ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
  // Without warming, these reads would have been writes
  const savings =
    (cacheReadTokens / 1_000_000) * (cacheWriteRate - pricing.cache_read);
  costs.counterfactual.warmupSavings += savings;
  costs.counterfactual.warmupHits++;
}

/**
 * Record a turn where 1h TTL saved a cache write.
 *
 * Called when a turn has cache reads but the gap since the last request
 * exceeds 5 minutes — meaning the 5m TTL would have expired, but the
 * 1h TTL kept the cache alive.
 *
 * The counterfactual is against 5m TTL (base cache_write rate), NOT 1h —
 * the saving comes from having 1h TTL instead of 5m, so the write cost
 * avoided is the 5m rate. The 1h surcharge is the price we paid to get
 * the longer TTL in the first place.
 */
export function recordTTLSavings(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  // Counterfactual: without 1h TTL, the 5m cache would have expired and
  // these reads would have been 5m-rate writes. Use base cache_write.
  const savings =
    (cacheReadTokens / 1_000_000) * (pricing.cache_write - pricing.cache_read);
  costs.counterfactual.ttlSavings += savings;
  costs.counterfactual.ttlHits++;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get the cost accumulator for a session (or null if not tracked). */
export function getSessionCosts(sessionID: string): SessionCosts | null {
  return sessions.get(sessionID) ?? null;
}

/** Get all tracked sessions (for UI dashboard). */
export function getAllSessionCosts(): Map<string, SessionCosts> {
  return sessions;
}

/** Total actual spend for a session. */
export function totalActualCost(costs: SessionCosts): number {
  return (
    costs.conversation.cost +
    costs.workers.distillation.cost +
    costs.workers.curation.cost +
    costs.workers.compaction.cost +
    costs.workers.recall.cost +
    costs.workers.warmup.cost
  );
}

/** Total worker overhead cost. */
export function totalWorkerCost(costs: SessionCosts): number {
  return (
    costs.workers.distillation.cost +
    costs.workers.curation.cost +
    costs.workers.compaction.cost +
    costs.workers.recall.cost +
    costs.workers.warmup.cost
  );
}

/** Total counterfactual savings. */
export function totalSavings(costs: SessionCosts): number {
  return (
    costs.counterfactual.warmupSavings +
    costs.counterfactual.ttlSavings +
    costs.batchSavings +
    costs.counterfactual.avoidedCompactionCost -
    totalWorkerCost(costs) // Net: subtract Lore's own overhead
  );
}

/** Estimated cost without Lore. */
export function costWithoutLore(costs: SessionCosts): number {
  return totalActualCost(costs) + totalSavings(costs);
}

/** Delete a session's cost data (cleanup on session expiry). */
export function deleteSessionCosts(sessionID: string): void {
  sessions.delete(sessionID);
}

/** Clear all sessions (for testing). */
export function clearAllCosts(): void {
  sessions.clear();
}

// ---------------------------------------------------------------------------
// Historical backdating — estimates from stored DB data
// ---------------------------------------------------------------------------

/**
 * Extract model ID from a temporal message's metadata JSON.
 * Returns null if metadata is missing or unparseable.
 */
function extractModelFromMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    // Assistant messages: { modelID, providerID, ... }
    if (parsed.modelID && parsed.modelID !== "unknown") return parsed.modelID;
    // User messages: { agent, model: { providerID, modelID } }
    if (parsed.model?.modelID && parsed.model.modelID !== "unknown") return parsed.model.modelID;
    return null;
  } catch {
    return null;
  }
}

/** Default model for cost estimation when metadata is unavailable. */
const DEFAULT_ESTIMATION_MODEL = "claude-sonnet-4-20250514";

/**
 * Compute backdated historical estimates from stored DB data.
 *
 * Walks through all projects and sessions in the database to estimate:
 * 1. **Distillation overhead** — each distillation record represents an LLM
 *    call whose input was the source messages and output was the observations.
 * 2. **Avoided compactions** — simulates a shadow context counter by walking
 *    temporal messages chronologically. When the running total crosses the
 *    auto-compact threshold, counts a counterfactual compaction and resets.
 *
  * Cache/TTL/warmup/batch savings are loaded from persisted session cost
  * snapshots (saved on idle) when available.
 *
 * Results are cached for 1 minute to avoid repeated DB scans.
 */
export function computeHistoricalEstimates(): HistoricalEstimates {
  // Return cache if fresh
  if (historicalCache && Date.now() - historicalCacheAt < HISTORICAL_CACHE_TTL_MS) {
    return historicalCache;
  }

  const totals: HistoricalEstimates["totals"] = {
    distillationCost: 0,
    distillationCalls: 0,
    distillationBatchCalls: 0,
    distillationDirectCalls: 0,
    avoidedCompactions: 0,
    avoidedCompactionCost: 0,
    warmupSavings: 0,
    warmupHits: 0,
    ttlSavings: 0,
    ttlHits: 0,
    batchSavings: 0,
    sessionCount: 0,
    messageCount: 0,
    totalWorkerCost: 0,
    persistedConversationCost: 0,
  };

  const sessionEstimates: HistoricalEstimates["sessions"] = [];

  // Resolve the worker model used for distillation calls.
  // Distillations run on the worker model (e.g. claude-sonnet-4-6), not the
  // conversation model (e.g. claude-opus-4-6). Use worker pricing for overhead.
  const workerResult = getWorkerModel();
  const workerModelID = workerResult?.modelID ?? DEFAULT_ESTIMATION_MODEL;
  const workerPricing = getPricingSync(workerModelID);

  // Load persisted cost snapshots from DB (saved on idle).
  const persistedCosts = loadAllSessionCosts();

  try {
    const projects = data.listProjects();

    for (const project of projects) {
      // Skip test sessions (created by the test suite)
      if (project.path.includes("__tmp_agents_file__")) continue;

      const projectSessions = data.listSessions(project.path, 500);

      for (const sess of projectSessions) {
        // Skip sessions that are currently tracked live
        if (sessions.has(sess.session_id)) continue;

        totals.sessionCount++;
        totals.messageCount += sess.message_count;

        // --- Determine model for this session ---
        // Look at assistant messages' metadata for model info (user messages have "unknown")
        const messages = temporal.bySession(project.path, sess.session_id);
        let model = DEFAULT_ESTIMATION_MODEL;
        for (const msg of messages) {
          const m = extractModelFromMetadata(msg.metadata);
          if (m) {
            model = m;
            break;
          }
        }

        // --- 1. Estimate distillation overhead ---
        // Use worker model pricing — distillations run on the worker, not conversation model
        const distillations = data.listDistillations(project.path, {
          sessionId: sess.session_id,
          limit: 500,
        });
        let sessionDistillCost = 0;
        for (const d of distillations) {
          // Estimate: input tokens = source message tokens (typically 2-5x output)
          // We use 3x the output token count as a rough input estimate
          const estInputTokens = d.token_count * 3;
          const estOutputTokens = d.token_count;
          // Use recorded call_type for accurate pricing. Batch API gets 50%
          // discount. Pre-migration rows (NULL call_type) default to 'direct'
          // for conservative estimates.
          const batchMultiplier = d.call_type === "batch" ? 0.5 : 1.0;
          const callCost =
            ((estInputTokens / 1_000_000) * workerPricing.input +
            (estOutputTokens / 1_000_000) * workerPricing.output) * batchMultiplier;
          sessionDistillCost += callCost;
        }
        const sessionBatchCalls = distillations.filter((d) => d.call_type === "batch").length;
        const sessionDirectCalls = distillations.length - sessionBatchCalls;
        totals.distillationCost += sessionDistillCost;
        totals.distillationCalls += distillations.length;
        totals.distillationBatchCalls += sessionBatchCalls;
        totals.distillationDirectCalls += sessionDirectCalls;

        // --- 2. Simulate shadow context for avoided compactions ---
        let shadowContext = 0;
        let avoidedCompactions = 0;

        for (const msg of messages) {
          // Each message adds its tokens to the running context
          shadowContext += msg.tokens;

          if (shadowContext > AUTOCOMPACT_THRESHOLD) {
            avoidedCompactions++;
            shadowContext = POST_COMPACTION_CONTEXT;
          }
        }

        const sessionCompactionCost = avoidedCompactions * estimateCompactionCost(workerModelID, model);

        // --- 3. Look up persisted live-session cost data ---
        // Avoided compaction and worker cost totals are accumulated here
        // (not above) because persisted real data is preferred over simulation.
        const persisted = persistedCosts.get(sess.session_id);
        let sessionPersisted: HistoricalEstimates["sessions"][number]["persisted"] = null;
        if (persisted) {
          sessionPersisted = {
            conversationCost: persisted.conversationCost,
            workerCost: persisted.workerCost,
            conversationTurns: persisted.conversationTurns,
            warmupSavings: persisted.warmupSavings,
            warmupHits: persisted.warmupHits,
            ttlSavings: persisted.ttlSavings,
            ttlHits: persisted.ttlHits,
            batchSavings: persisted.batchSavings,
            avoidedCompactions: persisted.avoidedCompactions,
            avoidedCompactionCost: persisted.avoidedCompactionCost,
          };
          totals.warmupSavings += persisted.warmupSavings;
          totals.warmupHits += persisted.warmupHits;
          totals.ttlSavings += persisted.ttlSavings;
          totals.ttlHits += persisted.ttlHits;
          totals.batchSavings += persisted.batchSavings;
          totals.persistedConversationCost += persisted.conversationCost;

          // Prefer persisted real worker cost over heuristic distillation estimate.
          // The persisted workerCost includes all 5 buckets (distillation, curation,
          // compaction, recall, warmup) from exact API-reported usage.
          totals.totalWorkerCost += persisted.workerCost;

          // Prefer persisted avoided compaction data over re-simulation.
          // Live tracking uses real API-reported total input tokens; the
          // simulation uses chars/3 estimates that miss system prompt and
          // tool definition overhead.
          if (persisted.avoidedCompactions > 0) {
            totals.avoidedCompactions += persisted.avoidedCompactions;
            totals.avoidedCompactionCost += persisted.avoidedCompactionCost;
          } else {
            // No persisted compaction data — use simulation fallback
            totals.avoidedCompactions += avoidedCompactions;
            totals.avoidedCompactionCost += sessionCompactionCost;
          }
        } else {
          // No persisted snapshot — use heuristic distillation estimate as
          // worker cost and simulation for avoided compactions.
          totals.totalWorkerCost += sessionDistillCost;
          totals.avoidedCompactions += avoidedCompactions;
          totals.avoidedCompactionCost += sessionCompactionCost;
        }

        sessionEstimates.push({
          projectPath: project.path,
          projectName: project.name,
          projectId: project.id,
          sessionId: sess.session_id,
          messageCount: sess.message_count,
          firstMessage: sess.first_message_at,
          lastMessage: sess.last_message_at,
          distillationCost: sessionDistillCost,
          distillationCalls: distillations.length,
          distillationBatchCalls: sessionBatchCalls,
          distillationDirectCalls: sessionDirectCalls,
          avoidedCompactions: persisted?.avoidedCompactions || avoidedCompactions,
          avoidedCompactionCost: persisted?.avoidedCompactionCost || sessionCompactionCost,
          model,
          persisted: sessionPersisted,
        });
      }
    }
  } catch (e) {
    log.error("cost-tracker: historical estimate computation failed:", e);
  }

  // Sort by most recent first
  sessionEstimates.sort((a, b) => b.lastMessage - a.lastMessage);

  historicalCache = { sessions: sessionEstimates, totals };
  historicalCacheAt = Date.now();

  log.info(
    `cost-tracker: computed historical estimates for ${totals.sessionCount} sessions — ` +
      `worker overhead=$${totals.totalWorkerCost.toFixed(4)} (distillation-only=$${totals.distillationCost.toFixed(4)}), ` +
      `conversation=$${totals.persistedConversationCost.toFixed(4)}, ` +
      `avoided compactions=${totals.avoidedCompactions} ($${totals.avoidedCompactionCost.toFixed(4)}), ` +
      `warmup=$${totals.warmupSavings.toFixed(4)} (${totals.warmupHits} hits), ` +
      `ttl=$${totals.ttlSavings.toFixed(4)} (${totals.ttlHits} hits), ` +
      `batch=$${totals.batchSavings.toFixed(4)}`,
  );

  return historicalCache;
}

/** Invalidate the historical estimates cache. */
export function invalidateHistoricalCache(): void {
  historicalCache = null;
  historicalCacheAt = 0;
}
