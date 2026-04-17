import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { join } from "path";
import {
  load,
  config,
  ensureProject,
  isFirstRun,
  temporal,
  ltm,
  distillation,
  curator,
  transform,
  setModelLimits,
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
  formatKnowledge,
  formatDistillations,
  shouldImport,
  importFromFile,
  exportToFile,
  latReader,
  embedding,
  log,
  isWorkerSession,
} from "@loreai/core";
import { createRecallTool } from "./reflect";

/**
 * Detect whether an error from session.error is a context overflow ("prompt too long").
 * Matches by error name (ContextOverflowError — covers both API-level and OpenCode
 * compaction overflow) and by message text patterns for provider-specific strings.
 */
export function isContextOverflow(rawError: unknown): boolean {
  const error = rawError as
    | { name?: string; message?: string; data?: { message?: string } }
    | undefined;

  // Match by error name — covers both API context overflow and OpenCode's
  // compaction overflow ("Conversation history too large to compact").
  if (error?.name === "ContextOverflowError") return true;

  const errorMessage = error?.data?.message ?? error?.message ?? "";
  return (
    typeof errorMessage === "string" &&
    (errorMessage.includes("prompt is too long") ||
      errorMessage.includes("context length exceeded") ||
      errorMessage.includes("maximum context length") ||
      errorMessage.includes("ContextWindowExceededError") ||
      errorMessage.includes("too many tokens"))
  );
}

/**
 * Build the synthetic recovery message injected after a context overflow.
 * Contains the distilled session history so the model can continue.
 */
export function buildRecoveryMessage(
  summaries: Array<{ observations: string; generation: number }>,
): string {
  const historyText = summaries.length > 0
    ? formatDistillations(summaries)
    : "";

  return [
    "<system-reminder>",
    "The previous turn failed with a context overflow error (prompt too long).",
    "Lore has automatically compressed the conversation history.",
    "Review the session history below and continue where you left off.",
    "",
    historyText || "(No distilled history available — check recent messages for context.)",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Check whether a project path is valid for file operations (e.g. AGENTS.md export/import).
 * Returns false for root ("/"), empty, or falsy paths to prevent writing to the filesystem root.
 */
export function isValidProjectPath(p: string): boolean {
  return !!p && p !== "/";
}

export const LorePlugin: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
  try {
    await load(ctx.directory);
    let firstRun = isFirstRun();
    ensureProject(projectPath);

  if (firstRun) {
    ctx.client.tui.showToast({
      body: {
        message: "Lore is active — your agent will get smarter every session",
        variant: "success",
        duration: 5000,
      },
    }).catch(() => {});
  }

  // Import from AGENTS.md at startup if it has changed since last export
  // (hand-written entries, edits from other machines, or merge conflicts).
  {
    const cfg = config();
    if (isValidProjectPath(projectPath) && cfg.knowledge.enabled && cfg.agentsFile.enabled) {
      const filePath = join(projectPath, cfg.agentsFile.path);
      if (shouldImport({ projectPath, filePath })) {
        try {
          importFromFile({ projectPath, filePath });
          log.info("imported knowledge from", cfg.agentsFile.path);
          invalidateLtmCache();
        } catch (e) {
          log.error("agents-file import error:", e);
        }
      }
    }
  }

  // Prune any corrupted/oversized knowledge entries left by the AGENTS.md
  // backslash-escaping bug or curator hallucinations. Sets confidence → 0
  // (below the 0.2 query threshold) so they stop polluting the context.
  if (config().knowledge.enabled) {
    const pruned = ltm.pruneOversized(1200);
    if (pruned > 0) {
      log.info(`pruned ${pruned} oversized knowledge entries (confidence set to 0)`);
      invalidateLtmCache();
    }
  }

  // Index lat.md/ directory sections at startup (if the directory exists).
  // Content-hash-based — skips unchanged files, so this is cheap on repeat runs.
  if (isValidProjectPath(projectPath)) {
    try {
      latReader.refresh(projectPath);
    } catch (e) {
      log.error("lat-reader startup refresh error:", e);
    }
  }

  // Track user turns for periodic curation
  let turnsSinceCuration = 0;

  // Per-session LTM cache — reuse exact formatted bytes across turns to
  // preserve the system prompt prefix for Anthropic's prompt caching.
  // Without this, forSession() re-scores entries every turn (session context
  // changes → different terms → different entries → system prompt bytes change
  // at position 0 → total cache invalidation). Cleared when knowledge
  // mutations occur (curation, consolidation, pruning, import).
  const ltmSessionCache = new Map<string, { formatted: string; tokenCount: number }>();
  function invalidateLtmCache() {
    ltmSessionCache.clear();
  }

  // Sessions where LTM injection failed and the fallback note was pushed.
  // Used to decide whether recovering LTM is worth the prompt cache bust.
  const ltmDegradedSessions = new Set<string>();

  // Track active sessions for distillation
  const activeSessions = new Set<string>();

  // Sessions currently in auto-recovery — prevents infinite loop when
  // the recovery prompt itself triggers another "prompt too long" error.
  // Without this guard: overflow → recovery prompt → overflow → recovery → ...
  const recoveringSessions = new Set<string>();

  // Sessions to skip for temporal storage and distillation. Includes worker sessions
  // (distillation, curator) and child sessions (eval, any other children).
  // Checked once per session ID and cached to avoid repeated API calls.
  const skipSessions = new Set<string>();

  async function shouldSkip(sessionID: string): Promise<boolean> {
    if (isWorkerSession(sessionID)) return true;
    if (skipSessions.has(sessionID)) return true;
    if (activeSessions.has(sessionID)) return false; // already known good
    // First encounter — check if this is a child session.
    // Only make ONE API call and cache the result either way. The previous
    // implementation fell back to session.list() when session.get() failed
    // (common with short IDs from message events), fetching ALL sessions on
    // every unknown message event. That's too expensive — accept the tradeoff:
    // if a child session has a short ID that fails session.get(), we won't skip
    // it. Worker sessions are already caught by isWorkerSession above, and a few
    // extra temporal messages from eval are harmless.
    try {
      const session = await ctx.client.session.get({ path: { id: sessionID } });
      if (session.data?.parentID) {
        skipSessions.add(sessionID);
        return true;
      }
    } catch {
      // session.get failed (likely short ID or not found) — assume not a child.
    }
    // Cache as known-good so we never re-check this session.
    activeSessions.add(sessionID);
    return false;
  }

  // Background distillation — debounced, non-blocking
  let distilling = false;
  async function backgroundDistill(sessionID: string, force?: boolean) {
    if (distilling) return;
    distilling = true;
    try {
      const cfg = config();
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (
        force ||
        pending >= cfg.distillation.minMessages ||
        needsUrgentDistillation()
      ) {
        await distillation.run({
          client: ctx.client,
          projectPath,
          sessionID,
          model: cfg.model,
          force,
        });
      }
    } catch (e) {
      log.error("distillation error:", e);
    } finally {
      distilling = false;
    }
  }

  async function backgroundCurate(sessionID: string) {
    try {
      const cfg = config();
      if (!cfg.curator.enabled) return;
      await curator.run({
        client: ctx.client,
        projectPath,
        sessionID,
        model: cfg.model,
      });
      // Curation may have created/updated/deleted knowledge entries.
      // Invalidate the LTM cache so the next turn picks up the changes.
      invalidateLtmCache();
    } catch (e) {
      log.error("curator error:", e);
    }
  }

  const hooks: Hooks = {
    // Disable built-in compaction and register hidden worker agents
    config: async (input) => {
      const cfg = input as Record<string, unknown>;
      cfg.compaction = { auto: false, prune: false };
      cfg.agent = {
        ...(cfg.agent as Record<string, unknown> | undefined),
        "lore-distill": {
          hidden: true,
          description: "Lore memory distillation worker",
        },
        "lore-curator": {
          hidden: true,
          description: "Lore knowledge curator worker",
        },
        "lore-query-expand": {
          hidden: true,
          description: "Lore query expansion worker",
        },
      };
    },

    // Store all messages in temporal DB for full-text search and distillation.
    // Skips child sessions (eval, worker) to prevent pollution.
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = event.properties.info;
        if (await shouldSkip(msg.sessionID)) return;
        try {
          const full = await ctx.client.session.message({
            path: { id: msg.sessionID, messageID: msg.id },
          });
          if (full.data) {
            temporal.store({
              projectPath,
              info: full.data.info,
              parts: full.data.parts,
            });
            activeSessions.add(msg.sessionID);
            if (msg.role === "user") turnsSinceCuration++;

            // Incremental distillation: when undistilled messages accumulate past
            // maxSegment, distill immediately instead of waiting for session.idle.
            if (
              msg.role === "assistant" &&
              msg.tokens &&
              // Include cache.write: tokens written to cache were fully sent to the
              // model (they were processed, just not read from a prior cache slot).
              // Omitting cache.write causes a dramatic undercount on cold-cache turns
              // where cache.read=0 but 150K+ tokens were written — leading the gradient
              // to think only 3 tokens went in and passing the full session as layer 0.
              (msg.tokens.input > 0 || msg.tokens.cache.read > 0 || msg.tokens.cache.write > 0)
            ) {
              const pending = temporal.undistilledCount(projectPath, msg.sessionID);
              if (pending >= config().distillation.maxSegment) {
                log.info(
                  `incremental distillation: ${pending} undistilled messages in ${msg.sessionID.substring(0, 16)}`,
                );
                backgroundDistill(msg.sessionID);
              }

              // Calibrate overhead using real token counts from the API response.
              // actualInput = all tokens the model processed (input + cache.read + cache.write).
              // The message estimate comes from the transform's own output (stored in
              // session state as lastTransformEstimate), NOT from re-estimating all session
              // messages. On compressed sessions, all-message estimate >> actualInput, which
              // previously clamped overhead to 0 and broke budget calculations.
              const actualInput =
                msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write;
              calibrate(actualInput, msg.sessionID, getLastTransformedCount(msg.sessionID));
            }
          }
        } catch (e) {
          // Message may not be fetchable yet during streaming
          log.warn(`message.updated: failed to fetch message ${msg.id} for session ${msg.sessionID.substring(0, 16)}:`, e);
        }
      }

      if (event.type === "session.error") {
        // Skip eval/worker child sessions — only handle errors for real user sessions.
        const errorSessionID = (event.properties as Record<string, unknown>).sessionID as
          | string
          | undefined;
        if (errorSessionID && await shouldSkip(errorSessionID)) return;

        // Detect "prompt is too long" API errors and auto-recover.
        const rawError = (event.properties as Record<string, unknown>).error;
        log.info("session.error received:", JSON.stringify(rawError, null, 2));

        if (isContextOverflow(rawError) && errorSessionID) {
          // Prevent infinite loop: if we're already recovering this session,
          // the recovery prompt itself overflowed — don't try again.
          // Without this guard: overflow → distill + prompt → overflow → distill + prompt → ...
          // Each cycle fires 2+ LLM calls, repeating until rate-limited.
          if (recoveringSessions.has(errorSessionID)) {
            log.warn(
              `recovery for ${errorSessionID.substring(0, 16)} also overflowed — giving up (forceMinLayer still persisted)`,
            );
            recoveringSessions.delete(errorSessionID);
            return;
          }

          log.info(
            `detected context overflow — auto-recovering (session: ${errorSessionID.substring(0, 16)})`,
          );

          // 1. Force layer 2 on next transform (persisted to DB — survives restarts).
          setForceMinLayer(2, errorSessionID);

          // 2. Distill all undistilled messages so nothing is lost.
          await backgroundDistill(errorSessionID, true);

          // 3. Auto-recover: inject a synthetic message that goes through the normal
          //    chat path. The gradient transform fires with forceMinLayer=2, compressing
          //    the context to fit. The model receives the distilled summaries and
          //    continues where it left off — no user intervention needed.
          recoveringSessions.add(errorSessionID);
          try {
            const summaries = distillation.loadForSession(projectPath, errorSessionID);
            const recoveryText = buildRecoveryMessage(
              summaries.map(s => ({ observations: s.observations, generation: s.generation })),
            );

            log.info(
              `sending auto-recovery message to session ${errorSessionID.substring(0, 16)}`,
            );
            await ctx.client.session.prompt({
              path: { id: errorSessionID },
              body: {
                parts: [{ type: "text", text: recoveryText, synthetic: true }],
              },
            });
            log.info(
              `auto-recovery message sent successfully`,
            );
          } catch (recoveryError) {
            // Recovery is best-effort — don't let it crash the event handler.
            // The persisted forceMinLayer will still help on the user's next message.
            log.error(
              `auto-recovery failed (forceMinLayer still persisted):`,
              recoveryError,
            );
          } finally {
            recoveringSessions.delete(errorSessionID);
          }
        }
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        if (await shouldSkip(sessionID)) return;
        if (!activeSessions.has(sessionID)) {
          log.info(`session ${sessionID.substring(0, 16)} idle but not in activeSessions — skipping`);
          return;
        }

        // Run background distillation for any remaining undistilled messages
        await backgroundDistill(sessionID);

        // Run curator periodically (only when knowledge system is enabled).
        // onIdle gates whether idle events trigger curation at all; afterTurns
        // is the minimum turn count before curation fires. The previous `||`
        // caused onIdle=true (default) to short-circuit, running the curator
        // on EVERY session.idle — an LLM worker call after every agent turn.
        const cfg = config();
        if (cfg.knowledge.enabled && cfg.curator.onIdle) {
          if (turnsSinceCuration >= cfg.curator.afterTurns) {
            await backgroundCurate(sessionID);
            turnsSinceCuration = 0;
          } else {
            log.info(
              `curation skipped: ${turnsSinceCuration}/${cfg.curator.afterTurns} user turns since last curation`,
            );
          }
        }

        // Consolidate entries if count exceeds cfg.curator.maxEntries.
        // Runs after normal curation so newly created entries are counted.
        // Only triggers when truly over the limit to avoid redundant LLM calls.
        if (cfg.knowledge.enabled) try {
          const allEntries = ltm.forProject(projectPath, false);
          if (allEntries.length > cfg.curator.maxEntries) {
            log.info(
              `entry count ${allEntries.length} exceeds maxEntries ${cfg.curator.maxEntries} — running consolidation`,
            );
            const { updated, deleted } = await curator.consolidate({
              client: ctx.client,
              projectPath,
              sessionID,
              model: cfg.model,
            });
            if (updated > 0 || deleted > 0) {
              log.info(`consolidation: ${updated} updated, ${deleted} deleted`);
              invalidateLtmCache();
            }
          }
        } catch (e) {
          log.error("consolidation error:", e);
        }

        // Prune temporal messages after distillation and curation have run.
        // Pass 1: TTL — remove distilled messages older than retention period.
        // Pass 2: Size cap — evict oldest distilled messages if over the limit.
        // Undistilled messages are never touched.
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
          log.error("pruning error:", e);
        }

        // Export curated knowledge to AGENTS.md after distillation + curation.
        try {
          const agentsCfg = cfg.agentsFile;
          if (isValidProjectPath(projectPath) && cfg.knowledge.enabled && agentsCfg.enabled) {
            const entries = ltm.forProject(projectPath, false);
            if (entries.length === 0) {
              log.info("agents-file export: 0 knowledge entries for project, skipping write");
            } else {
              const filePath = join(projectPath, agentsCfg.path);
              exportToFile({ projectPath, filePath });
            }
          }
        } catch (e) {
          log.error("agents-file export error:", e);
        }

        // Clean dead knowledge cross-references (entries deleted by curation/consolidation).
        if (cfg.knowledge.enabled) {
          try {
            const cleaned = ltm.cleanDeadRefs();
            if (cleaned > 0) {
              log.info(`cleaned ${cleaned} dead knowledge cross-references`);
              invalidateLtmCache();
            }
          } catch (e) {
            log.error("dead-ref cleanup error:", e);
          }
        }

        // Re-scan lat.md/ directory to pick up changes made by the agent.
        if (isValidProjectPath(projectPath)) {
          try {
            latReader.refresh(projectPath);
          } catch (e) {
            log.error("lat-reader idle refresh error:", e);
          }
        }
      }
    },

    // Inject LTM knowledge into system prompt — relevance-ranked and budget-capped.
    "experimental.chat.system.transform": async (input, output) => {
      // One-time first-run note so the agent acknowledges Lore is active.
      // Cleared after first injection to avoid repeating on subsequent turns.
      if (firstRun) {
        output.system.push(
          "[Lore plugin] This is the first time Lore has been activated. " +
          "Briefly let the user know that Lore is now active and their " +
          "coding agent will get progressively smarter on this codebase " +
          "over time as knowledge accumulates across sessions.",
        );
        firstRun = false;
      }

      if (input.model?.limit) {
        setModelLimits(input.model.limit);
      }

      const cfg = config();

      // Knowledge injection — only when the knowledge system is enabled.
      // When disabled, LTM budget is zero and no knowledge is injected.
      //
      // Uses per-session caching to preserve system prompt byte-stability
      // for Anthropic's prompt caching. Without this, forSession() re-scores
      // entries against evolving session context every turn, producing
      // different formatted text → system prompt changes at byte 0 → total
      // cache invalidation on every single turn.
      if (cfg.knowledge.enabled) {
        const sessionID = input.sessionID;
        try {
          let cached = sessionID ? ltmSessionCache.get(sessionID) : undefined;

          if (!cached) {
            const ltmBudget = getLtmBudget(cfg.budget.ltm);
            const entries = ltm.forSession(projectPath, sessionID, ltmBudget);
            if (entries.length) {
              const formatted = formatKnowledge(
                entries.map((e) => ({
                  category: e.category,
                  title: e.title,
                  content: e.content,
                })),
                ltmBudget,
              );

              if (formatted) {
                const tokenCount = Math.ceil(formatted.length / 3);

                // If this session was previously degraded (fallback note instead of LTM),
                // switching to real LTM changes the system prompt prefix → busts the
                // provider's read-token cache for the entire conversation after this point.
                // Only recover if the cache invalidation cost is small relative to LTM benefit.
                if (sessionID && ltmDegradedSessions.has(sessionID)) {
                  const conversationTokens = getLastTransformEstimate(sessionID);
                  if (conversationTokens > tokenCount) {
                    // Conversation is larger than LTM — cache bust costs more than
                    // LTM is worth. Keep the fallback note for this session.
                    setLtmTokens(0);
                    output.system.push(
                      "[Lore plugin] Long-term memory is temporarily unavailable. " +
                        "Use the recall tool to search for project knowledge, " +
                        "past decisions, and prior session context when needed.",
                    );
                    return;
                  }
                  // Conversation is small — LTM benefit outweighs cache cost. Recover.
                  ltmDegradedSessions.delete(sessionID);
                }

                cached = { formatted, tokenCount };
                if (sessionID) ltmSessionCache.set(sessionID, cached);
              }
            }
          }

          if (cached) {
            setLtmTokens(cached.tokenCount);
            output.system.push(cached.formatted);
          } else {
            setLtmTokens(0);
          }
        } catch (e) {
          log.error("system transform: knowledge injection failed:", e);
          setLtmTokens(0);
          if (sessionID) ltmDegradedSessions.add(sessionID);
          output.system.push(
            "[Lore plugin] Long-term memory is temporarily unavailable. " +
              "Use the recall tool to search for project knowledge, " +
              "past decisions, and prior session context when needed.",
          );
        }
      } else {
        setLtmTokens(0);
      }

      // Remind the agent to include the agents file in commits.
      // It is always modified after the lore export runs (post-session) so it
      // appears as unstaged when the agent goes to commit — the agent must not
      // skip it just because it looks auto-generated.
      if (cfg.knowledge.enabled && cfg.agentsFile.enabled) {
        output.system.push(
          `When making git commits, always check if ${cfg.agentsFile.path} has ` +
          `unstaged changes and include it in the commit. This file contains ` +
          `shared project knowledge managed by lore and must be version-controlled.`,
        );
      }
    },

    // Transform message history: distilled prefix + raw recent.
    // Layer 0 = passthrough (messages fit without compression) — output.messages
    // is left untouched to preserve the append-only pattern for prompt caching.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages.length) return;

      const sessionID = output.messages[0]?.info.sessionID;

      try {
        // Skip gradient transform for lore worker sessions (lore-distill, lore-curator).
        // Worker sessions are small (typically 5-15 messages) and don't need context
        // management. More importantly, allowing them through would overwrite the
        // per-session state for the MAIN session if they happen to share a session ID —
        // and before per-session state was introduced, module-level variables were
        // corrupted this way, causing calibration oscillation and layer 0 passthrough
        // on the main session's next step. Belt-and-suspenders: even with per-session
        // state, worker sessions waste CPU on transform() for no benefit.
        if (sessionID && await shouldSkip(sessionID)) return;

        const result = transform({
          messages: output.messages,
          projectPath,
          sessionID,
        });

        // The API requires the conversation to end with a user message.
        // Drop trailing pure-text assistant messages (no tool parts), which would
        // cause an Anthropic "does not support assistant message prefill" error.
        // This must run at ALL layers, including layer 0 (passthrough) — the error
        // can occur even when messages fit within the context budget.
        //
        // Crucially, assistant messages that contain tool parts must NOT be dropped:
        // - Completed/error tool parts: OpenCode's SDK converts these into tool_result
        //   blocks sent as user-role messages at the API level. The conversation already
        //   ends with a user message — dropping would strip the entire current agentic
        //   turn and cause an infinite tool-call loop (the model restarts from scratch).
        // - Note: pending/running tool parts are converted to error state upstream by
        //   sanitizeToolParts() in gradient.ts, so by this point all tool parts have a
        //   terminal state (completed or error) and will generate tool_result blocks.
        //
        // Note: at layer 0, result.messages === output.messages (same reference), so
        // mutating result.messages here also trims output.messages in place — which is
        // safe for prompt caching since we only ever remove trailing messages, never
        // reorder or insert.
        while (
          result.messages.length > 0 &&
          result.messages.at(-1)!.info.role !== "user"
        ) {
          const last = result.messages.at(-1)!;
          const hasToolParts = last.parts.some((p) => p.type === "tool");
          if (hasToolParts) {
            // Tool parts → tool_result (user-role) at the API level → no prefill error.
            // Stop dropping; the conversation ends correctly as-is.
            break;
          }
          const dropped = result.messages.pop()!;
          log.warn(
            "dropping trailing pure-text",
            dropped.info.role,
            "message to prevent prefill error. id:",
            dropped.info.id,
          );
        }

        // Only restructure messages when the gradient transform is active (layers 1-4).
        // Layer 0 means all messages fit within the context budget — leave them alone
        // so the append-only sequence stays intact for prompt caching.
        if (result.layer > 0) {
          output.messages.splice(0, output.messages.length, ...result.messages);
        }

        if (result.layer >= 2 && sessionID) {
          backgroundDistill(sessionID);
        }
      } catch (e) {
        log.error("messages transform: gradient transform failed:", e);
        // output.messages untouched — session continues without context management
      }
    },

    // Replace compaction prompt with distillation-aware prompt when /compact is used.
    // Strategy: run chunked distillation first so all messages are captured in segments
    // that each fit within the model's context, then inject the pre-computed summaries
    // as context so the model consolidates them rather than re-reading all raw messages.
    // This prevents the overflow→compaction→overflow stuck loop.
    "experimental.session.compacting": async (input, output) => {
      // Chunked distillation: split all undistilled messages into segments that each
      // fit within the model's context window and distill them independently.
      // This is safe even when the full session exceeds the context limit.
      if (input.sessionID && activeSessions.has(input.sessionID)) {
        await backgroundDistill(input.sessionID, true);
      }

      // Load all distillation summaries produced for this session (oldest first).
      // These are the chunked observations — the model will consolidate them.
      const distillations = input.sessionID
        ? distillation.loadForSession(projectPath, input.sessionID)
        : [];

      const entries = config().knowledge.enabled
        ? ltm.forProject(projectPath, config().crossProject)
        : [];
      const knowledge = entries.length
        ? formatKnowledge(
            entries.map((e) => ({
              category: e.category,
              title: e.title,
              content: e.content,
            })),
          )
        : "";

      // Inject each distillation chunk as a context string so the model has access
      // to pre-computed summaries. Even if the raw messages overflow context, these
      // summaries are compact and will fit.
      if (distillations.length > 0) {
        output.context.push(
          `## Lore Pre-computed Session Summaries\n\nThe following ${distillations.length} summary chunk(s) were pre-computed from the conversation history. Use these as the authoritative source — do not re-summarize the raw messages above if they conflict.\n\n` +
            distillations
              .map(
                (d, i) =>
                  `### Chunk ${i + 1}${d.generation > 0 ? " (consolidated)" : ""}\n${d.observations}`,
              )
              .join("\n\n"),
        );
      }

      output.prompt = `You are creating a distilled memory summary for an AI coding agent. This summary will be the ONLY context available in the next part of the conversation.

${distillations.length > 0 ? "Lore has pre-computed chunked summaries of the session history (injected above as context). Consolidate those summaries into a single coherent narrative. Do NOT re-read or re-summarize the raw conversation messages — trust the pre-computed summaries.\n\n" : ""}Structure your response as follows:

## Session History

For each major topic or task covered in the conversation, write:
- A 1-3 sentence narrative of what happened (past tense, focus on outcomes)
- A bullet list of specific, actionable facts (file paths, values, decisions, what failed and why)

PRESERVE: file paths, specific values, decisions with rationale, user preferences, failed approaches with reasons, environment details.
DROP: debugging back-and-forth, verbose tool output, pleasantries, redundant restatements.

${knowledge ? `\n${knowledge}\n` : ""}
End with "I'm ready to continue." so the agent knows to pick up where it left off.`;
    },

    // Register the recall tool
    tool: {
      recall: createRecallTool(
        projectPath,
        config().knowledge.enabled,
        ctx.client,
        config().search,
      ),
    },
  };

  // Always-on startup confirmation — not gated by LORE_DEBUG — so silent
  // plugin loading failures are immediately visible. If this line never
  // appears for a project, the init failed (see catch block below).
  process.stderr.write(`[lore] active: ${projectPath}\n`);

  // Background: backfill embeddings for entries that don't have one yet.
  // Fires once when embeddings are first enabled — subsequent entries
  // get embedded on create/update via ltm.ts and distillation.ts hooks.
  if (embedding.isAvailable()) {
    Promise.all([
      embedding.backfillEmbeddings(),
      embedding.backfillDistillationEmbeddings(),
    ]).catch((err) => {
      log.info("embedding backfill failed:", err);
    });
  }

  return hooks;
  } catch (e) {
    // Log the full error before re-throwing so OpenCode's plugin loader
    // (which catches and swallows the error) doesn't hide the root cause.
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(`[lore] init failed: ${detail}\n`);
    throw e;
  }
};

export default LorePlugin;
