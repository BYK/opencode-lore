/**
 * Auto-detection and background import of prior AI agent conversations.
 *
 * Called from `lore run` between gateway startup and agent launch.
 * Only triggers once per project (tracks via last_import_at on the projects table).
 * Prompts once, then runs import in the background if confirmed.
 */
import { createInterface } from "node:readline";
import {
  conversationImport,
  config as loreConfig,
  ensureProject,
  getLastImportAt,
  setLastImportAt,
  exportLoreFile,
} from "@loreai/core";
import { createGatewayLLMClient } from "../llm-adapter";
import { resolveAuth } from "../auth";
import type { GatewayConfig } from "../config";

const {
  detectAll,
  extractKnowledge,
  getProvider,
  isImported,
  recordImport,
  computeHash,
} = conversationImport;

async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [Y/n]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Auto-detect prior conversations and offer to import them.
 * Called from `commandRun()` before launching the agent.
 *
 * - Only triggers for fresh projects (no existing lore data).
 * - Shows a one-line prompt to the user.
 * - If confirmed, runs extraction in the background (fire-and-forget).
 * - If declined, records the decision so we don't ask again.
 */
export async function maybeAutoImport(gatewayConfig: GatewayConfig): Promise<void> {
  const projectPath = process.cwd();

  try {
    ensureProject(projectPath);
  } catch {
    return; // Can't determine project — skip
  }

  // Skip if import was already offered/run for this project
  if (getLastImportAt(projectPath) !== null) return;

  // Detect conversation history
  let results = detectAll(projectPath);
  if (results.length === 0) return;

  // Filter out already-imported sessions
  for (const result of results) {
    result.sessions = result.sessions.filter((sess) => {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      return !isImported(projectPath, result.agentName, sess.id, hash);
    });
    result.totalMessages = result.sessions.reduce((s, sess) => s + sess.messageCount, 0);
    result.totalTokens = result.sessions.reduce((s, sess) => s + sess.estimatedTokens, 0);
  }
  results = results.filter((r) => r.sessions.length > 0);
  if (results.length === 0) return;

  const totalMessages = results.reduce((s, r) => s + r.totalMessages, 0);
  const agentNames = results.map((r) => r.agentDisplayName).join(", ");

  // Prompt the user
  const ok = await promptYesNo(
    `[lore] Found ${totalMessages} messages from prior conversations (${agentNames}).\n` +
      "[lore] Import knowledge from them?",
  );

  // Record that import was offered — prevents re-prompting regardless of answer
  setLastImportAt(projectPath, Date.now());

  if (!ok) return;

  // Run import in the background (fire-and-forget)
  console.log("[lore] Importing knowledge in background...");

  const cfg = loreConfig();
  const defaultModel = cfg.model ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };
  const llm = createGatewayLLMClient(
    { anthropic: gatewayConfig.upstreamAnthropic, openai: gatewayConfig.upstreamOpenAI },
    resolveAuth,
    defaultModel,
  );

  // Fire-and-forget — don't await, let it run while the agent starts
  runBackgroundImport(llm, projectPath, results, defaultModel).catch(() => {
    // Background import failed — non-fatal, don't alarm the user.
  });
}

async function runBackgroundImport(
  llm: import("@loreai/core").LLMClient,
  projectPath: string,
  results: import("@loreai/core").conversationImport.DetectionResult[],
  model: { providerID: string; modelID: string },
): Promise<void> {
  let totalCreated = 0;
  let totalUpdated = 0;

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    const sessionIds = result.sessions.map((s) => s.id);
    const chunks = provider.readChunks(projectPath, sessionIds);
    if (chunks.length === 0) continue;

    const extractResult = await extractKnowledge({
      llm,
      projectPath,
      chunks,
      model,
    });

    // Record imports
    for (const sess of result.sessions) {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      recordImport(projectPath, result.agentName, sess.id, hash, {
        created: extractResult.created,
        updated: extractResult.updated,
      });
    }

    totalCreated += extractResult.created;
    totalUpdated += extractResult.updated;
  }

  // Export .lore.md
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  if (totalCreated > 0 || totalUpdated > 0) {
    console.log(
      `[lore] Background import complete: ${totalCreated} entries created, ${totalUpdated} updated.`,
    );
  }
}
