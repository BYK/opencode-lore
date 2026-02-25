import type { Plugin } from "@opencode-ai/plugin";
import { load, config } from "./config";
import { ensureProject, isFirstRun } from "./db";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import * as distillation from "./distillation";
import * as curator from "./curator";
import {
  transform,
  setModelLimits,
  needsUrgentDistillation,
  calibrate,
  estimateMessages,
  setLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
} from "./gradient";
import { formatKnowledge } from "./prompt";
import { createRecallTool } from "./reflect";
import { shouldImport, importFromFile, exportToFile } from "./agents-file";

export const LorePlugin: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
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
    if (cfg.agentsFile.enabled) {
      const filePath = `${projectPath}/${cfg.agentsFile.path}`;
      if (shouldImport({ projectPath, filePath })) {
        try {
          importFromFile({ projectPath, filePath });
          console.error("[lore] imported knowledge from", cfg.agentsFile.path);
        } catch (e) {
          console.error("[lore] agents-file import error:", e);
        }
      }
    }
  }

  // Prune any corrupted/oversized knowledge entries left by the AGENTS.md
  // backslash-escaping bug or curator hallucinations. Sets confidence → 0
  // (below the 0.2 query threshold) so they stop polluting the context.
  const pruned = ltm.pruneOversized(2000);
  if (pruned > 0) {
    console.error(`[lore] pruned ${pruned} oversized knowledge entries (confidence set to 0)`);
  }

  // Track user turns for periodic curation
  let turnsSinceCuration = 0;

  // Track active sessions for distillation
  const activeSessions = new Set<string>();

  // Sessions to skip for temporal storage and distillation. Includes worker sessions
  // (distillation, curator) and child sessions (eval, any other children).
  // Checked once per session ID and cached to avoid repeated API calls.
  const skipSessions = new Set<string>();

  async function shouldSkip(sessionID: string): Promise<boolean> {
    if (distillation.isWorkerSession(sessionID)) return true;
    if (skipSessions.has(sessionID)) return true;
    if (activeSessions.has(sessionID)) return false; // already known good
    // First encounter — check if this is a child session.
    // session.get() uses exact storage key lookup and only works with full IDs
    // (e.g. "ses_384e7de8dffeBDc4Z3dK9kfx1k"). Message events deliver short IDs
    // (e.g. "ses_384e7de8dffe") which cause session.get() to fail with NotFound.
    // Fall back to the session list to find a session whose full ID starts with
    // the short ID, then check its parentID.
    try {
      const session = await ctx.client.session.get({ path: { id: sessionID } });
      if (session.data?.parentID) {
        skipSessions.add(sessionID);
        return true;
      }
    } catch {
      // session.get failed (likely short ID) — search list for matching full ID
      try {
        const list = await ctx.client.session.list();
        const match = list.data?.find((s) => s.id.startsWith(sessionID));
        if (match?.parentID) {
          skipSessions.add(sessionID);
          return true;
        }
      } catch {
        // If we can't fetch session info, don't skip
      }
    }
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
      console.error("[lore] distillation error:", e);
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
    } catch (e) {
      console.error("[lore] curator error:", e);
    }
  }

  return {
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
                console.error(
                  `[lore] incremental distillation: ${pending} undistilled messages in ${msg.sessionID.substring(0, 16)}`,
                );
                backgroundDistill(msg.sessionID);
              }

              // Calibrate overhead estimate using real token counts.
              // Also store the exact input count + message count for the proactive
              // layer-0 decision (avoids full chars/4 re-estimation each turn).
              // actualInput = all tokens the model processed as input, regardless of
              // whether they were new (input), read from cache (cache.read), or newly
              // written to cache (cache.write). All three contribute to the context window.
              const allMsgs = await ctx.client.session.messages({
                path: { id: msg.sessionID },
              });
              if (allMsgs.data) {
                const withParts = allMsgs.data
                  .filter((m) => m.info.id !== msg.id)
                  .map((m) => ({ info: m.info, parts: m.parts }));
                const msgEstimate = estimateMessages(withParts);
                const actualInput =
                  msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write;
                // Use the compressed message count (from the last transform output),
                // not the total DB count. On layer 0 these are equal. On layers 1-4,
                // the model only saw the compressed window — calibrate must track that
                // count so the next turn's delta is computed correctly.
                calibrate(actualInput, msgEstimate, msg.sessionID, getLastTransformedCount() || withParts.length);
              }
            }
          }
        } catch {
          // Message may not be fetchable yet during streaming
        }
      }

      if (event.type === "session.error") {
        // Detect "prompt is too long" API errors and auto-recover:
        // 1. Force the gradient transform to escalate on the next call (skip layer 0/1)
        // 2. Force distillation to capture all temporal data before compaction
        // 3. Trigger compaction so the session recovers without user intervention
        const rawError = (event.properties as Record<string, unknown>).error;
        // Diagnostic: log the full error shape so we can verify our detection matches
        console.error("[lore] session.error received:", JSON.stringify(rawError, null, 2));

        const error = rawError as
          | { name?: string; message?: string; data?: { message?: string } }
          | undefined;
        // Match both shapes: error.data.message (APIError wrapper) and error.message (direct)
        const errorMessage = error?.data?.message ?? error?.message ?? "";
        const isPromptTooLong =
          typeof errorMessage === "string" &&
          (errorMessage.includes("prompt is too long") ||
            errorMessage.includes("context length exceeded") ||
            errorMessage.includes("maximum context length") ||
            errorMessage.includes("ContextWindowExceededError") ||
            errorMessage.includes("too many tokens"));

        console.error(
          `[lore] session.error isPromptTooLong=${isPromptTooLong} (name=${error?.name}, message=${errorMessage.substring(0, 120)})`,
        );

        if (isPromptTooLong) {
          const sessionID = (event.properties as Record<string, unknown>).sessionID as
            | string
            | undefined;
          console.error(
            `[lore] detected 'prompt too long' error — forcing distillation + layer escalation (session: ${sessionID?.substring(0, 16)})`,
          );
          // Force layer 2 on next transform — layers 0 and 1 were already too large.
          // The gradient at layers 2-4 will compress the context enough for the next turn.
          // Do NOT call session.summarize() here — it sends all messages to the model,
          // which would overflow again and create a stuck compaction loop.
          setForceMinLayer(2);

          if (sessionID) {
            // Force distillation to capture all undistilled messages into the temporal
            // store so they're preserved even if the session is later compacted manually.
            await backgroundDistill(sessionID, true);
          }
        }
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        if (await shouldSkip(sessionID)) return;
        if (!activeSessions.has(sessionID)) return;

        // Run background distillation for any remaining undistilled messages
        await backgroundDistill(sessionID);

        // Run curator periodically
        const cfg = config();
        if (
          cfg.curator.onIdle ||
          turnsSinceCuration >= cfg.curator.afterTurns
        ) {
          await backgroundCurate(sessionID);
          turnsSinceCuration = 0;
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
            console.error(
              `[lore] pruned temporal messages: ${ttlDeleted} by TTL, ${capDeleted} by size cap`,
            );
          }
        } catch (e) {
          console.error("[lore] pruning error:", e);
        }

        // Export curated knowledge to AGENTS.md after distillation + curation.
        try {
          const agentsCfg = cfg.agentsFile;
          if (agentsCfg.enabled) {
            const filePath = `${projectPath}/${agentsCfg.path}`;
            exportToFile({ projectPath, filePath });
          }
        } catch (e) {
          console.error("[lore] agents-file export error:", e);
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
      const ltmBudget = getLtmBudget(cfg.budget.ltm);
      const entries = ltm.forSession(projectPath, input.sessionID, ltmBudget);
      if (!entries.length) {
        setLtmTokens(0);
        return;
      }

      const formatted = formatKnowledge(
        entries.map((e) => ({
          category: e.category,
          title: e.title,
          content: e.content,
        })),
        ltmBudget,
      );

      if (formatted) {
        // Track how many tokens we actually consumed so the gradient manager
        // can deduct them from the usable budget for message injection.
        const ltmTokenCount = Math.ceil(formatted.length / 4);
        setLtmTokens(ltmTokenCount);
        output.system.push(formatted);
      } else {
        setLtmTokens(0);
      }
    },

    // Transform message history: distilled prefix + raw recent.
    // Layer 0 = passthrough (messages fit without compression) — output.messages
    // is left untouched to preserve the append-only pattern for prompt caching.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages.length) return;

      const sessionID = output.messages[0]?.info.sessionID;

      const result = transform({
        messages: output.messages,
        projectPath,
        sessionID,
      });

      // Only restructure messages when the gradient transform is active (layers 1-4).
      // Layer 0 means all messages fit within the context budget — leave them alone
      // so the append-only sequence stays intact for prompt caching.
      if (result.layer > 0) {
        // The API requires the conversation to end with a user message.
        // Drop trailing pure-text assistant messages (no tool parts), which would
        // cause an Anthropic "does not support assistant message prefill" error.
        //
        // Crucially, assistant messages that contain tool parts (completed OR pending)
        // must NOT be dropped:
        // - Completed tool parts: OpenCode's SDK converts these into tool_result blocks
        //   sent as user-role messages at the API level. The conversation already ends
        //   with a user message — dropping would strip the entire current agentic turn
        //   and cause an infinite tool-call loop (the model restarts from scratch).
        // - Pending tool parts: the tool call hasn't returned yet; dropping would make
        //   the model re-issue the same tool call on the next turn.
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
          console.error(
            "[lore] WARN: dropping trailing pure-text",
            dropped.info.role,
            "message to prevent prefill error. id:",
            dropped.info.id,
          );
        }
        output.messages.splice(0, output.messages.length, ...result.messages);
      }

      if (result.layer >= 2 && sessionID) {
        backgroundDistill(sessionID);
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

      const entries = ltm.forProject(projectPath, config().crossProject);
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
      recall: createRecallTool(projectPath),
    },
  };
};

export default LorePlugin;
