/**
 * Idle detection and background work scheduling for the Lore gateway.
 *
 * Since the gateway doesn't have host lifecycle hooks (like OpenCode's
 * `session.idle` event), it uses a timer-based approach to detect when
 * sessions go idle and trigger background work (distillation, curation,
 * pruning, AGENTS.md export, etc.).
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
} from "@loreai/core";
import type { LLMClient } from "@loreai/core";
import type { GatewayConfig } from "./config";
import type { SessionState } from "./translate/types";

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

  const timer = setInterval(() => {
    const now = Date.now();
    const timeoutMs = config.idleTimeoutSeconds * 1000;

    for (const [sessionID, state] of sessions) {
      if (inProgress.has(sessionID)) continue;
      if (now - state.lastRequestTime < timeoutMs) continue;

      inProgress.add(sessionID);
      doIdleWork(sessionID, state)
        .catch((e) => log.error(`idle work failed for session ${sessionID}:`, e))
        .finally(() => inProgress.delete(sessionID));
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
 * @param projectPath - Resolved project directory path
 * @param llm - LLM client for worker calls (distillation, curation)
 * @param onLtmInvalidated - Callback to clear LTM session cache when curation
 *   creates/updates/deletes knowledge entries
 */
export function buildIdleWorkHandler(
  projectPath: string,
  llm: LLMClient,
  onLtmInvalidated?: () => void,
): (sessionID: string, state: SessionState) => Promise<void> {
  return async (sessionID: string, state: SessionState) => {
    const cfg = loreConfig();

    // 1. Distillation — force-distill ALL pending messages on idle, even
    // below minMessages. The cache is going cold; aggressive distillation
    // now means a smaller context on the next turn via post-idle compact.
    // Meta-distillation is always allowed on idle (cache is cold anyway).
    try {
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (pending > 0) {
        await distillation.run({ llm, projectPath, sessionID, force: true });
      }
    } catch (e) {
      log.error("idle distillation error:", e);
    }

    // 2. Curation
    if (cfg.knowledge.enabled && cfg.curator.onIdle) {
      try {
        if (state.turnsSinceCuration >= cfg.curator.afterTurns) {
          await curator.run({ llm, projectPath, sessionID });
          state.turnsSinceCuration = 0;
          onLtmInvalidated?.();
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
          const { updated, deleted } = await curator.consolidate({
            llm,
            projectPath,
            sessionID,
          });
          if (updated > 0 || deleted > 0) {
            log.info(`consolidation: ${updated} updated, ${deleted} deleted`);
            onLtmInvalidated?.();
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
          onLtmInvalidated?.();
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
  };
}
