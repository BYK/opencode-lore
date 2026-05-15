/**
 * `lore import` — detect and import knowledge from external AI agent conversations.
 *
 * Scans for conversation history from Claude Code, OpenCode, and Aider,
 * then extracts knowledge entries via the curator LLM.
 *
 * When `LORE_REMOTE_URL` is set, detection and chunk reading happen locally
 * (they require filesystem access), but extraction is delegated to the remote
 * gateway via the REST API. No local gateway startup is needed.
 */
import { createInterface } from "node:readline";
import { resolve } from "path";
import {
  conversationImport,
  config as loreConfig,
  ensureProject,
  setLastImportAt,
  load,
} from "@loreai/core";
import { loadConfig } from "../config";
import { createGatewayLLMClient } from "../llm-adapter";
import { resolveAuth } from "../auth";
import { exportLoreFile } from "@loreai/core";
import { startGateway, type StartOptions } from "./start";
import { safeExit } from "./exit";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
  remotePost,
} from "./remote";

const {
  detectAll,
  extractKnowledge,
  getProvider,
  isImported,
  recordImport,
  computeHash,
} = conversationImport;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

async function confirm(message: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} ${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultYes);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandImport(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  // Parse flags
  const dryRun = flags["dry-run"] === true || flags.dryRun === true;
  const yes = flags.yes === true || flags.y === true;
  const agentFilter = (flags.agent as string) ?? null;
  const projectFlag = flags.project as string | undefined;
  const projectPath = projectFlag ? resolve(projectFlag) : process.cwd();

  const remote = getRemoteUrl();

  // Initialize core (loads config, opens DB, runs migrations).
  // In remote mode we still need load() for detectAll / readChunks which use
  // core's provider registry. A local project record may be created later by
  // the belt-and-suspenders recordImport() call — that's intentional so the
  // local DB has dedup history if the user later runs without LORE_REMOTE_URL.
  load(projectPath);
  if (!remote) {
    ensureProject(projectPath);
  }

  // Detect conversation history (local filesystem scan — always local)
  console.log("[lore] Scanning for conversation history...\n");

  let results = detectAll(projectPath);

  if (agentFilter) {
    results = results.filter((r) => r.agentName === agentFilter);
    if (results.length === 0) {
      console.log(`[lore] No conversation history found from "${agentFilter}" for this project.`);
      return;
    }
  }

  if (results.length === 0) {
    console.log("[lore] No prior AI conversation history found for this project.");
    return;
  }

  // Filter out already-imported sessions.
  // In remote mode, fetch import history from the remote gateway.
  let remoteImports: Array<{ agent_name: string; source_id: string; source_hash: string }> | undefined;
  if (remote) {
    try {
      const pq = projectQueryParams(projectPath);
      remoteImports = await remoteGet<typeof remoteImports>(remote, `/api/v1/import/history?${pq}`);
    } catch (err: unknown) {
      // 400/404 = project doesn't exist on remote yet (first import) — proceed without dedup
      const status = err instanceof Error && "status" in err ? (err as { status: number }).status : 0;
      if (status === 400 || status === 404) {
        console.error("[lore] Note: project not yet known to remote gateway — all sessions will be imported.");
      } else {
        // Server errors, auth failures, network issues — re-throw (don't silently double-import)
        throw err;
      }
    }
  }

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    result.sessions = result.sessions.filter((sess) => {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      if (remote && remoteImports) {
        // Check against remote import history
        return !remoteImports.some(
          (r) => r.agent_name === result.agentName && r.source_id === sess.id && r.source_hash === hash,
        );
      }
      // Local mode: check local DB
      return !isImported(projectPath, result.agentName, sess.id, hash);
    });

    result.totalMessages = result.sessions.reduce((s, sess) => s + sess.messageCount, 0);
    result.totalTokens = result.sessions.reduce((s, sess) => s + sess.estimatedTokens, 0);
  }

  // Remove agents with no new sessions
  results = results.filter((r) => r.sessions.length > 0);

  if (results.length === 0) {
    console.log("[lore] All detected conversations have already been imported.");
    return;
  }

  // Show detection summary
  const totalMessages = results.reduce((s, r) => s + r.totalMessages, 0);
  const totalSessions = results.reduce((s, r) => s + r.sessions.length, 0);

  console.log("Found prior conversations for this project:\n");
  for (const result of results) {
    console.log(`  ${result.agentDisplayName}`);
    console.log(`    ${result.sessions.length} sessions, ~${result.totalMessages} messages`);
    if (result.sessions.length > 0) {
      const latest = result.sessions[0];
      console.log(`    Most recent: ${formatDate(latest.lastActivityAt)}`);
    }
    console.log();
  }

  // Estimate LLM calls (one per ~12K token chunk)
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);
  const estimatedChunks = Math.ceil(totalTokens / 12288);
  console.log(`  Total: ${totalSessions} sessions, ~${totalMessages} messages (~${estimatedChunks} LLM calls)\n`);

  if (dryRun) {
    console.log("[lore] Dry run — no imports performed.");
    return;
  }

  // Confirm unless --yes
  if (!yes) {
    const ok = await confirm("[lore] Import knowledge from these conversations?");
    if (!ok) {
      console.log("[lore] Import cancelled.");
      return;
    }
  }

  // Remote mode: delegate extraction to the remote gateway
  if (remote) {
    await importRemote(remote, projectPath, results);
    return;
  }

  // Start gateway for LLM access
  console.log("\n[lore] Starting gateway for LLM access...");

  // Import always runs locally — reading local agent history files.
  const startOpts: StartOptions = { quiet: true, local: true };
  const { config, port, owned, shutdown } = await startGateway(startOpts);
  const cfg = loreConfig();
  const defaultModel = cfg.model ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };
  const llm = createGatewayLLMClient(
    { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
    resolveAuth,
    defaultModel,
  );

  try {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalChunks = 0;
    let totalFailed = 0;

    for (const result of results) {
      const provider = getProvider(result.agentName);
      if (!provider) continue;

      const sessionIds = result.sessions.map((s) => s.id);
      console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

      const chunks = provider.readChunks(projectPath, sessionIds);
      if (chunks.length === 0) {
        console.log(`[lore] No extractable content from ${result.agentDisplayName}.`);
        continue;
      }

      console.log(`[lore] Extracting knowledge from ${chunks.length} chunks (${result.agentDisplayName})...`);

      const extractResult = await extractKnowledge({
        llm,
        projectPath,
        chunks,
        model: defaultModel,
        onProgress: (progress) => {
          process.stderr.write(
            `\r[lore]   Chunk ${progress.current}/${progress.total} — ${progress.created} created, ${progress.updated} updated`,
          );
        },
      });

      // Clear the progress line
      process.stderr.write("\n");

      // Record imports for each session
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
      totalDeleted += extractResult.deleted;
      totalChunks += extractResult.chunksProcessed;
      totalFailed += extractResult.chunksFailed;
    }

    // Record import timestamp (prevents auto-import re-prompting on `lore run`)
    setLastImportAt(projectPath, Date.now());

    // Export .lore.md
    try {
      exportLoreFile(projectPath);
    } catch {
      // Non-fatal
    }

    // Summary
    console.log(
      `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
        (totalDeleted ? `, ${totalDeleted} deleted` : "") +
        (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
        ".",
    );
    console.log("[lore] Run `lore data list knowledge` to review.");
  } finally {
    if (owned) await shutdown();
  }
}

// ---------------------------------------------------------------------------
// Remote import — detection + chunk reading local, extraction via gateway API
// ---------------------------------------------------------------------------

async function importRemote(
  remote: string,
  projectPath: string,
  results: ReturnType<typeof detectAll>,
): Promise<void> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const raw = getGitRemote(projectPath);
  const normalized = raw ? normalizeRemoteUrl(raw) : undefined;

  console.log(`\n[lore] Using remote gateway at ${remote}`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalChunks = 0;
  let totalFailed = 0;

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    const sessionIds = result.sessions.map((s) => s.id);
    console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

    const chunks = provider.readChunks(projectPath, sessionIds);
    if (chunks.length === 0) {
      console.log(`[lore] No extractable content from ${result.agentDisplayName}.`);
      continue;
    }

    console.log(`[lore] Extracting knowledge from ${chunks.length} chunks via remote gateway (${result.agentDisplayName})...`);

    // Send chunks to remote gateway for extraction (zstd-compressed)
    let extractResult: {
      created: number; updated: number; deleted: number;
      chunksProcessed: number; chunksFailed: number;
    };
    try {
      extractResult = await remotePost(remote, "/api/v1/import/extract", {
        git_remote: normalized,
        path: projectPath,
        chunks: chunks.map((c) => ({
          label: c.label,
          text: c.text,
          estimatedTokens: c.estimatedTokens,
          timestamp: c.timestamp,
        })),
      }, { compress: true });
    } catch (err) {
      console.error(`[lore] Extraction failed for ${result.agentDisplayName}: ${err instanceof Error ? err.message : err}`);
      totalFailed += chunks.length;
      continue;
    }

    // Record imports on remote gateway + locally (belt-and-suspenders:
    // remote is source of truth, local prevents re-detection if user
    // later runs without LORE_REMOTE_URL)
    for (const sess of result.sessions) {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      try {
        await remotePost(remote, "/api/v1/import/record", {
          git_remote: normalized,
          path: projectPath,
          agent_name: result.agentName,
          source_id: sess.id,
          source_hash: hash,
          stats: { created: extractResult.created, updated: extractResult.updated },
        });
      } catch (err) {
        console.error(`[lore] Warning: failed to record import on remote: ${err instanceof Error ? err.message : err}`);
      }
      // Also record locally (belt-and-suspenders)
      try {
        recordImport(projectPath, result.agentName, sess.id, hash, {
          created: extractResult.created,
          updated: extractResult.updated,
        });
      } catch {
        // Non-fatal — remote record is the source of truth
      }
    }

    totalCreated += extractResult.created;
    totalUpdated += extractResult.updated;
    totalDeleted += extractResult.deleted;
    totalChunks += extractResult.chunksProcessed;
    totalFailed += extractResult.chunksFailed;
  }

  // Record import timestamp locally (prevents auto-import re-prompting on `lore run`)
  setLastImportAt(projectPath, Date.now());

  // Export .lore.md locally so knowledge appears in the local file
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  // Summary
  console.log(
    `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
      (totalDeleted ? `, ${totalDeleted} deleted` : "") +
      (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
      ".",
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}
