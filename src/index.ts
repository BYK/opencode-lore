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

export const NuumPlugin: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
  await load(ctx.directory);
  ensureProject(projectPath);

  // Track user turns for periodic curation
  let turnsSinceCuration = 0;

  // Track active sessions for distillation
  const activeSessions = new Set<string>();

  // Background distillation — debounced, non-blocking
  let distilling = false;
  async function backgroundDistill(sessionID: string) {
    if (distilling) return;
    distilling = true;
    try {
      const cfg = config();
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (
        pending >= cfg.distillation.minMessages ||
        needsUrgentDistillation()
      ) {
        await distillation.run({
          client: ctx.client,
          projectPath,
          sessionID,
          model: cfg.model,
        });
      }
    } catch (e) {
      console.error("[nuum] distillation error:", e);
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
      console.error("[nuum] curator error:", e);
    }
  }

  return {
    // Disable built-in compaction and register hidden worker agents
    config: async (input) => {
      const cfg = input as Record<string, unknown>;
      cfg.compaction = { auto: false, prune: false };
      cfg.agent = {
        ...(cfg.agent as Record<string, unknown> | undefined),
        "nuum-distill": {
          hidden: true,
          description: "Nuum memory distillation worker",
        },
        "nuum-curator": {
          hidden: true,
          description: "Nuum knowledge curator worker",
        },
      };
    },

    // Store all messages in temporal DB for full-text search and distillation
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = event.properties.info;
        // Skip worker sessions — storing their content would pollute temporal storage
        // with distillation prompts and responses, and cause recursive distillation
        if (distillation.isWorkerSession(msg.sessionID)) return;
        // Fetch parts for this message
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

            // Calibrate overhead estimate using real token counts from completed assistant messages
            if (
              msg.role === "assistant" &&
              msg.tokens &&
              (msg.tokens.input > 0 || msg.tokens.cache.read > 0)
            ) {
              // Fetch all messages in the session to estimate what we sent
              const allMsgs = await ctx.client.session.messages({
                path: { id: msg.sessionID },
              });
              if (allMsgs.data) {
                // Estimate all messages that were sent as input (exclude the assistant msg itself)
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
        // Skip worker sessions — they don't have user content to distill
        if (distillation.isWorkerSession(sessionID)) return;
        if (!activeSessions.has(sessionID)) return;

        // Run background distillation
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
      // Cache model limits for the gradient transform
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

      // Capture the last user message's first text part before transform modifies the array.
      // We'll write nuum gradient stats into its metadata so the context inspector can show them.
      const lastUserMsg = [...output.messages].reverse().find((m) => m.info.role === "user");
      const statsPart = lastUserMsg?.parts.find((p) => p.type === "text");

      const result = transform({
        messages: output.messages,
        projectPath,
        sessionID,
      });
      // Ensure conversation ends with a user message — providers reject assistant prefill.
      // Only drop trailing assistant messages that have no tool parts: those are safe to remove
      // (e.g. the synthetic distilled-prefix assistant, or stale completed turns).
      // Assistant messages that contain tool parts must be preserved — they represent an
      // in-progress agentic loop where the model needs to see its own tool calls and results.
      // Dropping them would cause the model to re-invoke the same tools, creating an infinite loop.
      while (
        result.messages.length > 0 &&
        result.messages.at(-1)!.info.role !== "user"
      ) {
        const last = result.messages.at(-1)!;
        if (last.parts.some((p) => p.type === "tool")) break;
        const dropped = result.messages.pop()!;
        console.error(
          "[nuum] WARN: dropping trailing",
          dropped.info.role,
          "message to prevent prefill error. id:",
          dropped.info.id,
        );
      }
      output.messages.splice(0, output.messages.length, ...result.messages);

      // If we hit safety layers, trigger urgent distillation
      if (result.layer >= 2 && sessionID) {
        backgroundDistill(sessionID);
      }

      // Persist gradient stats into the last user message's text part metadata.
      // This fires a message.part.updated SSE event so the UI can read it reactively.
      // We use raw fetch because the plugin receives a v1 SDK client which lacks the part API.
      if (sessionID && statsPart && lastUserMsg) {
        const nuumMeta = {
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
            nuum: nuumMeta,
          },
        };
        // Fire-and-forget — don't block the transform
        fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedPart),
        }).catch((e: unknown) => {
          console.error("[nuum] failed to write gradient stats to part metadata:", e);
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

export default NuumPlugin;
