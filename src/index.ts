import type { Plugin } from "@opencode-ai/plugin";
import { load, config } from "./config";
import { ensureProject } from "./db";
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
} from "./gradient";
import { formatKnowledge } from "./prompt";
import { createRecallTool } from "./reflect";

export const LorePlugin: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
  await load(ctx.directory);
  ensureProject(projectPath);

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

              // Calibrate overhead estimate using real token counts
              const allMsgs = await ctx.client.session.messages({
                path: { id: msg.sessionID },
              });
              if (allMsgs.data) {
                const withParts = allMsgs.data
                  .filter((m) => m.info.id !== msg.id)
                  .map((m) => ({ info: m.info, parts: m.parts }));
                const msgEstimate = estimateMessages(withParts);
                const actualInput = msg.tokens.input + msg.tokens.cache.read;
                calibrate(actualInput, msgEstimate);
              }
            }
          }
        } catch {
          // Message may not be fetchable yet during streaming
        }
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        if (await shouldSkip(sessionID)) return;
        if (!activeSessions.has(sessionID)) return;

        // Run background distillation for any remaining undistilled messages
        backgroundDistill(sessionID);

        // Run curator periodically
        const cfg = config();
        if (
          cfg.curator.onIdle ||
          turnsSinceCuration >= cfg.curator.afterTurns
        ) {
          backgroundCurate(sessionID);
          turnsSinceCuration = 0;
        }
      }
    },

    // Inject LTM knowledge into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.limit) {
        setModelLimits(input.model.limit);
      }

      const entries = ltm.forProject(projectPath, config().crossProject);
      if (!entries.length) return;

      const formatted = formatKnowledge(
        entries.map((e) => ({
          category: e.category,
          title: e.title,
          content: e.content,
        })),
      );
      if (formatted) {
        output.system.push(formatted);
      }
    },

    // Transform message history: distilled prefix + raw recent
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages.length) return;

      const sessionID = output.messages[0]?.info.sessionID;

      const lastUserMsg = [...output.messages].reverse().find((m) => m.info.role === "user");
      const statsPart = lastUserMsg?.parts.find((p) => p.type === "text");

      const result = transform({
        messages: output.messages,
        projectPath,
        sessionID,
      });
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

      if (result.layer >= 2 && sessionID) {
        backgroundDistill(sessionID);
      }

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
        const url = new URL(
          `/session/${sessionID}/message/${lastUserMsg.info.id}/part/${statsPart.id}`,
          ctx.serverUrl,
        );
        const updatedPart = {
          ...(statsPart as Record<string, unknown>),
          metadata: {
            ...((statsPart as { metadata?: Record<string, unknown> }).metadata ?? {}),
            lore: loreMeta,
          },
        };
        fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedPart),
        }).catch((e: unknown) => {
          console.error("[lore] failed to write gradient stats to part metadata:", e);
        });
      }
    },

    // Replace compaction prompt with distillation-aware prompt when manual /compact is used
    "experimental.session.compacting": async (input, output) => {
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
