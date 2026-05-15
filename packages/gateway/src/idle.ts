/**
 * Idle detection and background work scheduling for the Lore gateway.
 *
 * Since the gateway doesn't have host lifecycle hooks (like OpenCode's
 * `session.idle` event), it uses a timer-based approach to detect when
 * sessions go idle and trigger background work (distillation, curation,
 * pruning, AGENTS.md export, etc.).
 *
 * Also runs speculative cache warming checks on every 30s tick — separate
 * from idle work (which triggers after idleTimeoutSeconds). Warming needs
 * to fire ~45s before cache TTL expiry, not after the idle timeout.
 */

import { join } from "node:path";
import {
  temporal,
  distillation,
  curator,
  ltm,
  latReader,
  log,
  config as loreConfig,
  getLastTurnAt,
  exportToFile,
  exportLoreFile,
  saveSessionCosts,
  saveSessionTracking,
  saveGradientState,
  getConsecutiveBusts,
} from "@loreai/core";
import type { LLMClient } from "@loreai/core";
import type { GatewayConfig } from "./config";
import type { SessionState } from "./translate/types";
import { getWorkerModel } from "./worker-model";
import {
  isCircuitBreakerTripped,
  resolveProfile,
  blendedHistogramForSession,
  shouldWarm,
  executeWarmup,
  loadGlobalHistograms,
  flushGlobalHistograms,
  MIN_TURNS_FOR_WARMING,
} from "./cache-warmer";
import * as Sentry from "@sentry/bun";
import { emitWarmupMetric, emitSessionCostMetrics, emitCurationMetrics } from "./sentry";
import { getSessionCosts, totalWorkerCost } from "./cost-tracker";

const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// startIdleScheduler
// ---------------------------------------------------------------------------

/**
 * Start a periodic timer that checks each active session for idle timeout.
 *
 * Every 30 seconds, walks the sessions map and fires `doIdleWork` for any
 * session whose `lastRequestTime` is older than `config.idleTimeoutSeconds`.
 * Tracks in-progress sessions to avoid double-triggering.
 *
 * @returns A cleanup function that clears the interval timer.
 */
export function startIdleScheduler(
  config: GatewayConfig,
  sessions: Map<string, SessionState>,
  doIdleWork: (sessionID: string, state: SessionState) => Promise<void>,
): () => void {
  const inProgress = new Set<string>();
  const warmupInProgress = new Set<string>();

  const timer = setInterval(() => {
    const now = Date.now();
    const timeoutMs = config.idleTimeoutSeconds * 1000;

    // --- Idle work (distillation, curation, etc.) ---
    for (const [sessionID, state] of sessions) {
      if (inProgress.has(sessionID)) continue;
      if (now - state.lastRequestTime < timeoutMs) continue;

      inProgress.add(sessionID);
      doIdleWork(sessionID, state)
        .catch((e) => log.error(`idle work failed for session ${sessionID}:`, e))
        .finally(() => inProgress.delete(sessionID));
    }

    // --- Cache warming (separate from idle work — fires before TTL expiry) ---
    if (isCircuitBreakerTripped()) return;

    for (const [sessionID, state] of sessions) {
      if (warmupInProgress.has(sessionID)) continue;

      // Skip sub-agent sessions — ephemeral, warming is wasted work
      if (state.isSubagent) continue;

      // Skip sessions with too few turns — insufficient data for survival
      // model and not worth the warmup cost ($0.30 per wasted warmup at
      // 200K Opus tokens). Checked here to avoid expensive profile/histogram
      // work before shouldWarm() rejects them anyway.
      if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) continue;

      // Ensure global histograms are loaded from SQLite for this project
      loadGlobalHistograms(state.projectPath);

      const profile = resolveProfile(
        state.lastModel,
        state.lastProtocol,
        state.resolvedConversationTTL,
      );
      if (!profile) continue;

      const blendedHist = blendedHistogramForSession(state);
      if (!shouldWarm(state, profile, blendedHist, now)) continue;

      warmupInProgress.add(sessionID);
      executeWarmup(state, profile)
        .then((result) => emitWarmupMetric(state, result))
        .catch((e) =>
          log.error(`cache-warmer: warmup failed session=${sessionID.slice(0, 16)}:`, e),
        )
        .finally(() => warmupInProgress.delete(sessionID));
    }

    // Flush dirty global histograms to SQLite (debounced — runs at most
    // once per 30s poll tick, not on every recordGap call).
    try {
      flushGlobalHistograms();
    } catch (e) {
      log.warn("cache-warmer: histogram flush error:", e);
    }

    // --- Periodic state persistence (30s tick) ---
    // Flush gradient calibration + cache warming + cost state for dirty sessions.
    // Max data loss on crash is one tick interval (~30s) — acceptable tradeoff
    // vs per-mutation writes on the hot path.
    for (const [sessionID, state] of sessions) {
      if (!state._dirty) continue;
      try {
        saveGradientState(sessionID);
        // Persist cache warming state (resolvedConversationTTL + warmup blob)
        // in a single DB write alongside gradient state.
        saveSessionTracking(sessionID, {
          resolvedConversationTTL: state.resolvedConversationTTL ?? "5m",
          warmupState: state.warmup ? JSON.stringify(state.warmup) : null,
        });
        // Persist cost snapshot
        const costs = getSessionCosts(sessionID);
        if (costs && costs.conversation.turns > 0) {
          saveSessionCosts(sessionID, {
            conversationCost: costs.conversation.cost,
            workerCost: totalWorkerCost(costs),
            conversationTurns: costs.conversation.turns,
            cacheReadTokens: costs.conversation.cacheReadTokens,
            cacheWriteTokens: costs.conversation.cacheWriteTokens,
            warmupSavings: costs.counterfactual.warmupSavings,
            warmupHits: costs.counterfactual.warmupHits,
            ttlSavings: costs.counterfactual.ttlSavings,
            ttlHits: costs.counterfactual.ttlHits,
            batchSavings: costs.batchSavings,
            avoidedCompactions: costs.counterfactual.avoidedCompactions,
            avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
          });
        }
        state._dirty = false;
      } catch (e) {
        log.error(`periodic state flush error for session ${sessionID.slice(0, 16)}:`, e);
      }
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// touchSession
// ---------------------------------------------------------------------------

/**
 * Update a session's `lastRequestTime` to now. Called on every request.
 */
export function touchSession(
  sessions: Map<string, SessionState>,
  sessionID: string,
): void {
  const state = sessions.get(sessionID);
  if (state) {
    state.lastRequestTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// buildIdleWorkHandler
// ---------------------------------------------------------------------------

/**
 * Build the idle work handler that runs the same background tasks as
 * OpenCode/Pi adapters on session idle:
 *
 *  1. Distillation (if enough undistilled messages)
 *  2. Curation (if enough turns since last curation)
 *  3. Consolidation (if entries exceed max)
 *  4. Temporal pruning
 *  5. AGENTS.md export
 *  6. Dead reference cleanup
 *  7. lat.md refresh
 *
 * Each step is independently try/catch'd — one failure won't block the rest.
 *
 * @param llm - LLM client for worker calls (distillation, curation)
 */
export function buildIdleWorkHandler(
  llm: LLMClient,
): (sessionID: string, state: SessionState) => Promise<void> {
  return async (sessionID: string, state: SessionState) => {
    const projectPath = state.projectPath;
    const cfg = loreConfig();
    const model = getWorkerModel();

    // 1. Distillation — force-distill ALL pending messages on idle, even
    // below minMessages. The cache is going cold; aggressive distillation
    // now means a smaller context on the next turn via post-idle compact.
    // Skip meta-distillation in the run() call: we run it as a separate
    // step below so gen-0 segments from the force-distill are counted.
    try {
      const callType = process.env.LORE_BATCH_DISABLED === "1" ? "direct" as const : "batch" as const;
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (pending > 0) {
        await distillation.run({ llm, projectPath, sessionID, model, force: true, skipMeta: true, callType });
      }
      // Meta consolidation: safe on idle because cache is already cold.
      // Run as a separate step so gen-0 segments from the force-distill
      // above are counted toward the threshold.
      // Under bust pressure (3+ consecutive busts), lower the threshold
      // to consolidate earlier — shrinks the distilled prefix before the
      // session becomes unsustainable.
      const busts = getConsecutiveBusts(sessionID);
      const effectiveMetaThreshold = busts >= 3
        ? Math.max(3, Math.floor(cfg.distillation.metaThreshold / 4))
        : cfg.distillation.metaThreshold;
      const g0 = distillation.gen0Count(projectPath, sessionID);
      if (g0 >= effectiveMetaThreshold) {
        await distillation.metaDistill({ llm, projectPath, sessionID, model, callType });
      }
    } catch (e) {
      log.error("idle distillation error:", e);
    }

    // 2. Curation
    if (cfg.knowledge.enabled && cfg.curator.onIdle) {
      try {
        if (state.turnsSinceCuration >= cfg.curator.afterTurns) {
          const result = await Sentry.startSpan(
            { name: "lore.curator", op: "lore.curation", attributes: { trigger: "idle" } },
            () => curator.run({ llm, projectPath, sessionID, model }),
          );
          state.turnsSinceCuration = 0;
          saveSessionTracking(sessionID, { turnsSinceCuration: 0 });
          if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
            log.info(
              `idle curation: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
            );
            emitCurationMetrics({ ...result, trigger: "idle" });
          }
        }
      } catch (e) {
        log.error("idle curation error:", e);
      }
    }

    // 3. Consolidation — runs after curation so new entries are counted
    if (cfg.knowledge.enabled) {
      try {
        const entries = ltm.forProject(projectPath, false);
        if (entries.length > cfg.curator.maxEntries) {
          log.info(
            `entry count ${entries.length} exceeds maxEntries ${cfg.curator.maxEntries} — running consolidation`,
          );
          const result = await Sentry.startSpan(
            { name: "lore.consolidation", op: "lore.curation", attributes: { trigger: "consolidation" } },
            () => curator.consolidate({ llm, projectPath, sessionID, model }),
          );
          if (result.updated > 0 || result.deleted > 0) {
            log.info(`consolidation: ${result.updated} updated, ${result.deleted} deleted`);
            emitCurationMetrics({ created: 0, ...result, trigger: "consolidation" });
          }
        }
      } catch (e) {
        log.error("idle consolidation error:", e);
      }
    }

    // 4. Temporal pruning
    try {
      const { ttlDeleted, capDeleted } = temporal.prune({
        projectPath,
        retentionDays: cfg.pruning.retention,
        maxStorageMB: cfg.pruning.maxStorage,
      });
      if (ttlDeleted > 0 || capDeleted > 0) {
        log.info(
          `pruned temporal messages: ${ttlDeleted} by TTL, ${capDeleted} by size cap`,
        );
      }
    } catch (e) {
      log.error("idle pruning error:", e);
    }

    // 5. Knowledge export (.lore.md + optional agents file pointer)
    if (cfg.knowledge.enabled) {
      try {
        const entries = ltm.forProject(projectPath, false);
        if (entries.length > 0) {
          if (cfg.agentsFile.enabled) {
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportToFile({ projectPath, filePath });
          } else {
            exportLoreFile(projectPath);
          }
        }
      } catch (e) {
        log.error("idle knowledge export error:", e);
      }
    }

    // 6. Dead reference cleanup
    if (cfg.knowledge.enabled) {
      try {
        const cleaned = ltm.cleanDeadRefs();
        if (cleaned > 0) {
          log.info(`cleaned ${cleaned} dead knowledge cross-references`);
        }
      } catch (e) {
        log.error("idle dead-ref cleanup error:", e);
      }
    }

    // 7. lat.md refresh
    try {
      latReader.refresh(projectPath);
    } catch (e) {
      log.error("idle lat-reader refresh error:", e);
    }

    // 8. Emit session cost/savings metrics to Sentry
    emitSessionCostMetrics(sessionID);

    // 9. Persist live session cost snapshot to DB so historical estimates
    //    include all worker costs, avoided compactions, cache warming,
    //    1h TTL, and batch API savings after restart.
    try {
      const costs = getSessionCosts(sessionID);
      if (costs && costs.conversation.turns > 0) {
        saveSessionCosts(sessionID, {
          conversationCost: costs.conversation.cost,
          workerCost: totalWorkerCost(costs),
          conversationTurns: costs.conversation.turns,
          cacheReadTokens: costs.conversation.cacheReadTokens,
          cacheWriteTokens: costs.conversation.cacheWriteTokens,
          warmupSavings: costs.counterfactual.warmupSavings,
          warmupHits: costs.counterfactual.warmupHits,
          ttlSavings: costs.counterfactual.ttlSavings,
          ttlHits: costs.counterfactual.ttlHits,
          batchSavings: costs.batchSavings,
          avoidedCompactions: costs.counterfactual.avoidedCompactions,
          avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
        });
      }
    } catch (e) {
      log.error("idle session cost persistence error:", e);
    }
  };
}
