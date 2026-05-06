/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * Wires Lore's core memory hooks (LTM injection, gradient context management,
 * distillation, curation, recall, AGENTS.md sync) into Pi's extension API.
 * All the heavy lifting lives in `@loreai/core`; this module is the adapter
 * layer that converts between Pi's types and Lore's host-agnostic types.
 *
 * Installation (in user's `~/.pi/agent/extensions/`):
 *   import lore from "@loreai/pi";
 *   export default lore;
 *
 * Or as a Pi package:
 *   pi install npm:@loreai/pi
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionStartEvent,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message as PiMessage } from "@mariozechner/pi-ai";
import {
  config,
  consumeCameOutOfIdle,
  curator,
  distillation,
  ensureProject,
  exportToFile,
  exportLoreFile,
  formatKnowledge,
  getLtmBudget,
  importFromFile,
  importLoreFile,
  isFirstRun,
  load,
  log,
  loreFileExists,
  ltm,
  latReader,
  onIdleResume,
  setLtmTokens,
  setModelLimits,
  shouldImport,
  shouldImportLoreFile,
  temporal,
  transform,
  workerSessionIDs,
} from "@loreai/core";

import { piMessageToLore, piMessagesToLore } from "./adapter";
import { createPiLLMClient } from "./llm-adapter";
import { registerRecallTool } from "./reflect";

// Pi doesn't re-export these event result types at the top level — inline their
// minimal shape here to avoid depending on an internal package path.

type ContextEventResult = { messages?: AgentMessage[] };

type MessageEndEvent = {
  type: "message_end";
  message: AgentMessage;
};

type SessionBeforeCompactResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

/**
 * Derive a stable session identifier from Pi's current session file path.
 *
 * Pi's session state is already saved to disk; we use a hash of that path so
 * the same persistent session produces the same ID across Pi restarts. When
 * no session file is active (ephemeral mode), we use a process-level UUID.
 */
function sessionIDFor(sessionFile: string | undefined): string {
  if (!sessionFile) return `pi-ephemeral-${process.pid}`;
  return `pi-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)}`;
}

/**
 * Pi extension entry point.
 *
 * Pi calls this function when loading the extension — either via `pi -e`
 * or after `pi install`. All per-instance state lives in closure.
 */
export default function lorePiExtension(pi: ExtensionAPI): void {
  /** Current session's stable ID (set in session_start). */
  let currentSessionID: string = sessionIDFor(undefined);

  /** Project root for this Pi instance — stable for a session. */
  let projectPath: string = process.cwd();

  /** Monotonic counter for synthesized message IDs within a session. */
  let messageCounter = 0;

  /** Whether the core config has been loaded yet. */
  let loaded = false;

  /**
   * Per-session LTM cache — reuse formatted bytes across turns to preserve
   * the Anthropic prompt cache prefix. Same pattern as the OpenCode adapter.
   */
  const ltmSessionCache = new Map<string, string>();
  function invalidateLtmCache() {
    ltmSessionCache.clear();
  }

  /** Turns since last curation run — triggers curator when threshold reached. */
  let turnsSinceCuration = 0;

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    projectPath = ctx.cwd;
    currentSessionID = sessionIDFor(ctx.sessionManager.getSessionFile());
    messageCounter = 0;
    turnsSinceCuration = 0;

    if (!loaded) {
      try {
        await load(projectPath);
      } catch (err) {
        log.error("pi: config load failed:", err);
      }
      loaded = true;
    }

    try {
      const firstRun = isFirstRun();
      ensureProject(projectPath);
      if (firstRun) {
        ctx.ui.notify(
          "Lore is active — your agent will get smarter every session",
          "info",
        );
      }
    } catch (err) {
      log.error("pi: project init failed:", err);
      return;
    }

    // Import knowledge at startup — .lore.md takes precedence, falls back
    // to agents file (AGENTS.md/CLAUDE.md) for backward compat / migration.
    const cfg = config();
    if (cfg.knowledge.enabled) {
      try {
        if (loreFileExists(projectPath)) {
          if (shouldImportLoreFile(projectPath)) {
            importLoreFile(projectPath);
            log.info("pi: imported knowledge from .lore.md");
            invalidateLtmCache();
          }
        } else if (cfg.agentsFile.enabled) {
          const filePath = join(projectPath, cfg.agentsFile.path);
          if (shouldImport({ projectPath, filePath })) {
            importFromFile({ projectPath, filePath });
            log.info("pi: imported knowledge from", cfg.agentsFile.path, "(migrating to .lore.md)");
            invalidateLtmCache();
          }
        }
      } catch (err) {
        log.error("pi: knowledge import error:", err);
      }
    }

    // Prune corrupted/oversized knowledge entries.
    if (cfg.knowledge.enabled) {
      try {
        const pruned = ltm.pruneOversized(1200);
        if (pruned > 0) {
          log.info(
            `pi: pruned ${pruned} oversized knowledge entries (confidence → 0)`,
          );
          invalidateLtmCache();
        }
      } catch (err) {
        log.error("pi: pruneOversized failed:", err);
      }
    }

    // Refresh lat.md directory if present.
    try {
      latReader.refresh(projectPath);
    } catch (err) {
      log.error("pi: lat-reader refresh error:", err);
    }

    // Register the recall tool.
    registerRecallTool(pi, {
      projectPath,
      knowledgeEnabled: cfg.knowledge.enabled,
      llmFactory: (ctx2) => createPiLLMClient(ctx2, ctx2.model),
      searchConfig: cfg.search,
      sessionID: currentSessionID,
    });
  });

  // -------------------------------------------------------------------------
  // LTM injection — before_agent_start
  // -------------------------------------------------------------------------

  pi.on(
    "before_agent_start",
    async (
      event: BeforeAgentStartEvent,
      ctx,
    ): Promise<BeforeAgentStartEventResult | undefined> => {
      const cfg = config();
      if (!cfg.knowledge.enabled) return undefined;

      try {
        const contextLimit = ctx.model?.contextWindow ?? 200_000;
        const outputReserved = ctx.model?.maxTokens ?? 16_384;
        setModelLimits({ context: contextLimit, output: outputReserved });
        const budget = getLtmBudget(cfg.budget.ltm);

        // Cold-cache idle-resume: when the gap since this session's last turn
        // exceeds the configured threshold, the provider's prompt cache has
        // already evicted our prefix bytes. Refresh Lore's byte-identity caches
        // (gradient prefix/raw window) and the per-session LTM cache before
        // they're consulted on this turn. Reasoning blocks are NOT touched
        // (Anthropic's April 23 postmortem identified that as the root cause
        // of forgetfulness/repetition).
        const thresholdMs = cfg.idleResumeMinutes * 60_000;
        const idleResult = onIdleResume(currentSessionID, thresholdMs);
        if (idleResult.triggered) {
          ltmSessionCache.delete(currentSessionID);
          log.info(
            `pi: session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches on cold prompt cache`,
          );
        }
        // Pi has no LTM-degraded recovery branch (no fallback note path), so
        // cameOutOfIdle isn't actionable here — clear it for hygiene.
        consumeCameOutOfIdle(currentSessionID);

        // Per-session cache: reuse formatted string across turns for prompt caching.
        let formatted = ltmSessionCache.get(currentSessionID);
        if (!formatted) {
          const entries = ltm.forSession(projectPath, currentSessionID, budget);
          if (!entries.length) {
            setLtmTokens(0);
            return undefined;
          }
          formatted = formatKnowledge(
            entries.map((e) => ({
              category: e.category,
              title: e.title,
              content: e.content,
            })),
            budget,
          );
          ltmSessionCache.set(currentSessionID, formatted);
        }

        // Account for LTM tokens in the gradient budget.
        setLtmTokens(Math.ceil(formatted.length / 3));

        return {
          systemPrompt: `${event.systemPrompt}\n\n${formatted}`,
        };
      } catch (err) {
        log.error("pi: LTM injection failed:", err);
        return undefined;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Gradient context management — context event
  //
  // Pi's `context` event fires before each LLM call with an `AgentMessage[]`.
  // For layer 0 (passthrough), we no-op. Layers 1-4 would require synthesizing
  // back to Pi's message shape; that's deferred pending real usage data —
  // Pi has its own compaction, so overflow recovery already works.
  // -------------------------------------------------------------------------

  pi.on(
    "context",
    async (event: ContextEvent, _ctx): Promise<ContextEventResult | undefined> => {
      try {
        const llmMessages: PiMessage[] = [];
        event.messages.forEach((m) => {
          if (
            m.role === "user" ||
            m.role === "assistant" ||
            m.role === "toolResult"
          ) {
            llmMessages.push(m as PiMessage);
          }
        });

        const loreMessages = piMessagesToLore(llmMessages, currentSessionID);
        const result = transform({
          messages: loreMessages,
          projectPath,
          sessionID: currentSessionID,
        });

        if (result.layer === 0) return undefined;

        log.info(
          `pi: gradient layer ${result.layer} triggered — passthrough (layer-1+ synthesis TBD)`,
        );
        return undefined;
      } catch (err) {
        log.error("pi: gradient transform failed:", err);
        return undefined;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Message capture — message_end
  // -------------------------------------------------------------------------

  pi.on("message_end", async (event: MessageEndEvent, _ctx) => {
    const m = event.message;
    if (
      m.role !== "user" &&
      m.role !== "assistant" &&
      m.role !== "toolResult"
    ) {
      return;
    }
    if (workerSessionIDs.has(currentSessionID)) return;

    try {
      const converted = piMessageToLore(
        m as PiMessage,
        currentSessionID,
        messageCounter++,
      );
      if (converted) {
        temporal.store({
          projectPath,
          info: converted.info,
          parts: converted.parts,
        });
      }
    } catch (err) {
      log.error("pi: temporal.store failed:", err);
    }
  });

  // -------------------------------------------------------------------------
  // Idle triggers — turn_end
  //
  // Pi doesn't have a dedicated idle event, but turn_end fires after the
  // assistant finishes (including tool execution). That's the natural point
  // to run distillation + curation + pruning.
  // -------------------------------------------------------------------------

  pi.on("turn_end", async (_event: TurnEndEvent, ctx) => {
    if (workerSessionIDs.has(currentSessionID)) return;

    const cfg = config();
    turnsSinceCuration++;

    // Background distillation.
    try {
      const pending = temporal.undistilledCount(projectPath, currentSessionID);
      if (pending >= cfg.distillation.minMessages) {
        const llm = createPiLLMClient(ctx, ctx.model);
        await distillation.run({
          llm,
          projectPath,
          sessionID: currentSessionID,
          model: cfg.model,
        });
      }
    } catch (err) {
      log.error("pi: distillation failed:", err);
    }

    // Background curation.
    if (cfg.curator.enabled && cfg.curator.onIdle) {
      try {
        if (turnsSinceCuration >= cfg.curator.afterTurns) {
          turnsSinceCuration = 0;
          const llm = createPiLLMClient(ctx, ctx.model);
          const { created, updated, deleted } = await curator.run({
            llm,
            projectPath,
            sessionID: currentSessionID,
            model: cfg.model,
          });
          if (created > 0 || updated > 0 || deleted > 0) {
            invalidateLtmCache();
          }

          // Consolidation when entry count exceeds threshold.
          const entries = ltm.forProject(projectPath, false);
          if (entries.length > cfg.curator.maxEntries) {
            const consolidation = await curator.consolidate({
              llm,
              projectPath,
              sessionID: currentSessionID,
              model: cfg.model,
            });
            if (consolidation.updated > 0 || consolidation.deleted > 0) {
              invalidateLtmCache();
            }
          }
        }
      } catch (err) {
        log.error("pi: curation failed:", err);
      }
    }

    // Temporal pruning.
    try {
      temporal.prune({
        projectPath,
        retentionDays: cfg.pruning.retention,
        maxStorageMB: cfg.pruning.maxStorage,
      });
    } catch (err) {
      log.error("pi: temporal.prune failed:", err);
    }

    // Knowledge export (.lore.md + optional agents file pointer).
    if (cfg.knowledge.enabled) {
      try {
        if (cfg.agentsFile.enabled) {
          const filePath = join(projectPath, cfg.agentsFile.path);
          exportToFile({ projectPath, filePath });
        } else {
          exportLoreFile(projectPath);
        }
      } catch (err) {
        log.error("pi: knowledge export error:", err);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Compaction override — session_before_compact
  //
  // Lore replaces Pi's default compaction with a distillation-aware summary.
  // If we have distillations for this session, use those as the summary text
  // directly — Lore already pre-summarized history. Otherwise fall through
  // to Pi's default.
  // -------------------------------------------------------------------------

  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      _ctx,
    ): Promise<SessionBeforeCompactResult | undefined> => {
      try {
        const summaries = distillation.loadForSession(
          projectPath,
          currentSessionID,
        );
        if (summaries.length === 0) return undefined;

        const summaryText = summaries
          .map((s) => s.observations)
          .join("\n\n---\n\n");

        return {
          compaction: {
            summary: summaryText,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      } catch (err) {
        log.error("pi: custom compaction failed, falling back to default:", err);
        return undefined;
      }
    },
  );
}

/** Named export for users who prefer `import { LorePiExtension }` style. */
export { lorePiExtension as LorePiExtension };
