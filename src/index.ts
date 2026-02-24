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
  stripSystemReminders,
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
              (msg.tokens.input > 0 || msg.tokens.cache.read > 0)
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
              const allMsgs = await ctx.client.session.messages({
                path: { id: msg.sessionID },
              });
              if (allMsgs.data) {
                const withParts = allMsgs.data
                  .filter((m) => m.info.id !== msg.id)
                  .map((m) => ({ info: m.info, parts: m.parts }));
                const msgEstimate = estimateMessages(withParts);
                const actualInput = msg.tokens.input + msg.tokens.cache.read;
                calibrate(actualInput, msgEstimate, msg.sessionID, withParts.length);
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
        const error = (event.properties as Record<string, unknown>).error as
          | { name?: string; data?: { message?: string } }
          | undefined;
        const isPromptTooLong =
          error?.name === "APIError" &&
          typeof error?.data?.message === "string" &&
          (error.data.message.includes("prompt is too long") ||
            error.data.message.includes("context length exceeded") ||
            error.data.message.includes("maximum context length"));

        if (isPromptTooLong) {
          const sessionID = (event.properties as Record<string, unknown>).sessionID as
            | string
            | undefined;
          console.error(
            `[lore] detected 'prompt too long' error — forcing distillation + compaction (session: ${sessionID?.substring(0, 16)})`,
          );
          // Force layer 2 on next transform — layers 0 and 1 were already too large.
          setForceMinLayer(2);

          if (sessionID) {
            // Force distillation to capture all undistilled messages before
            // compaction replaces the session message history.
            await backgroundDistill(sessionID, true);

            // Trigger compaction automatically — the compacting hook will inject
            // Lore's custom distillation-aware prompt.
            try {
              const sessions = await ctx.client.session.list();
              const session = sessions.data?.find((s) => s.id.startsWith(sessionID));
              if (session) {
                // providerID/modelID are optional — omit to use the session's current model
                await ctx.client.session.summarize({ path: { id: session.id } });
              }
            } catch (e) {
              console.error("[lore] auto-compaction failed:", e);
            }
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
        while (
          result.messages.length > 0 &&
          result.messages.at(-1)!.info.role !== "user"
        ) {
          const last = result.messages.at(-1)!;
          if (last.parts.some((p) => p.type === "tool")) break;
          const dropped = result.messages.pop()!;
          console.error(
            "[lore] WARN: dropping trailing",
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

      // Look up statsPart AFTER the transform so the PATCHed text is clean
      // (system-reminder wrappers stripped). Looking up before would persist
      // ephemeral system-reminder content, making it visible in the UI.
      const lastUserMsg = [...output.messages].reverse().find((m) => m.info.role === "user");
      const statsPart = lastUserMsg?.parts.find((p) => p.type === "text");

      if (sessionID && statsPart && lastUserMsg) {
        const loreMeta = {
          layer: result.layer,
          distilledTokens: result.distilledTokens,
          rawTokens: result.rawTokens,
          totalTokens: result.totalTokens,
          usable: result.usable,
          distilledBudget: result.distilledBudget,
          rawBudget: result.rawBudget,
          updatedAt: Date.now(),
        };

        // Strip <system-reminder> wrappers from the part text before PATCHing.
        // On layer 0 the messages are never passed through cleanParts(), so
        // statsPart.text may still contain the ephemeral system-reminder wrapper
        // that OpenCode injects around user messages. If we send that text back
        // to the server it gets persisted and shows up in the UI as if the user
        // wrote it.
        const rawText = (statsPart as { text: string }).text ?? "";
        const cleanText = stripSystemReminders(rawText);

        // Use the SDK's internal HTTP client so the request goes through
        // the same base URL, custom fetch, and interceptors that OpenCode
        // configured — no dependency on ctx.serverUrl being reachable.
        const httpClient = (ctx.client as any)._client;
        httpClient.patch({
          url: "/session/{sessionID}/message/{messageID}/part/{partID}",
          path: {
            sessionID,
            messageID: lastUserMsg.info.id,
            partID: statsPart.id,
          },
          body: {
            ...(statsPart as Record<string, unknown>),
            text: cleanText,
            metadata: {
              ...((statsPart as { metadata?: Record<string, unknown> }).metadata ?? {}),
              lore: loreMeta,
            },
          },
          headers: { "Content-Type": "application/json" },
        }).catch(() => {
          // Non-critical: gradient stats metadata is for UI display only.
          // Server may not be reachable (e.g. TUI-only mode). Silently ignore.
        });
      }
    },

    // Replace compaction prompt with distillation-aware prompt when manual /compact is used.
    // Also force distillation first so all temporal data is captured before compaction
    // replaces the session message history.
    "experimental.session.compacting": async (input, output) => {
      // Force distillation to capture any undistilled messages. This is critical:
      // compaction will replace all messages with a summary, so we must persist
      // everything to Lore's temporal store before that happens.
      if (input.sessionID && activeSessions.has(input.sessionID)) {
        await backgroundDistill(input.sessionID, true);
      }

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

      output.prompt = `You are creating a distilled memory summary for an AI coding agent. This summary will be the ONLY context available in the next part of the conversation.

Structure your response as follows:

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
