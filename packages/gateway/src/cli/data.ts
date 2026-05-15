/**
 * CLI `lore data` command — inspect and manage stored data.
 *
 * Subcommands:
 *   list <type>           List entries (projects, knowledge, sessions, distillations)
 *   show <type> <id>      Show full detail for an entry
 *   clear [options]       Clear data for a project or wipe the database
 *   delete <type> <id>    Delete a single entry (type: knowledge, session, distillation, project)
 *
 * When `LORE_REMOTE_URL` is set, most subcommands delegate to the remote
 * gateway REST API instead of accessing the local database.
 */
import { createInterface } from "node:readline";
import { resolve } from "path";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
  remotePost,
  remoteDelete,
} from "./remote";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "\u2026";
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printTable(
  headers: string[],
  rows: string[][],
  widths: number[],
): void {
  const header = headers
    .map((h, i) => padRight(h, widths[i]))
    .join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((cell, i) => padRight(cell, widths[i])).join("  "));
  }
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("Error: Cannot prompt for confirmation in non-TTY mode. Use --yes to skip.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message}\nType "yes" to confirm: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdList(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdListRemote(remote, args, flags);

  const { data, ltm } = await import("@loreai/core");
  const type = args[0];
  const limit = flags.limit ? Number(flags.limit) : 50;
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  switch (type) {
    case "projects": {
      const projects = data.listProjects();
      if (asJson) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      if (!projects.length) {
        console.log("No projects found.");
        return;
      }
      printTable(
        ["Name", "Path", "Git Remote", "ID", "Knowledge", "Sessions", "Created"],
        projects.map((p) => [
          p.name ?? "(unnamed)",
          truncate(p.path, 35),
          truncate(p.git_remote ?? "-", 30),
          p.id.slice(0, 8),
          String(p.knowledge_count),
          String(p.session_count),
          formatDate(p.created_at),
        ]),
        [16, 35, 30, 10, 10, 10, 20],
      );
      break;
    }

    case "knowledge": {
      const entries = ltm.forProject(projectPath, false);
      const limited = entries.slice(0, limit);
      if (asJson) {
        console.log(JSON.stringify(limited, null, 2));
        return;
      }
      if (!limited.length) {
        console.log("No knowledge entries found for this project.");
        return;
      }
      printTable(
        ["Category", "Title", "Confidence", "Updated", "ID"],
        limited.map((e) => [
          e.category,
          truncate(e.title, 40),
          e.confidence.toFixed(2),
          formatDate(e.updated_at),
          e.id.slice(0, 8),
        ]),
        [14, 40, 12, 20, 10],
      );
      break;
    }

    case "sessions": {
      const sessions = data.listSessions(projectPath, limit);
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      if (!sessions.length) {
        console.log("No sessions found for this project.");
        return;
      }
      printTable(
        ["Session ID", "Messages", "Distilled", "Distillations", "First", "Last"],
        sessions.map((s) => [
          s.session_id.slice(0, 12),
          String(s.message_count),
          String(s.distilled_count),
          String(s.distillation_count),
          formatDate(s.first_message_at),
          formatDate(s.last_message_at),
        ]),
        [14, 10, 10, 14, 20, 20],
      );
      break;
    }

    case "distillations": {
      const dists = data.listDistillations(projectPath, { limit });
      if (asJson) {
        console.log(JSON.stringify(dists, null, 2));
        return;
      }
      if (!dists.length) {
        console.log("No distillations found for this project.");
        return;
      }
      printTable(
        ["Session", "Gen", "Tokens", "R_comp", "C_norm", "Archived", "Created", "ID"],
        dists.map((d) => [
          d.session_id.slice(0, 12),
          String(d.generation),
          String(d.token_count),
          d.r_compression?.toFixed(2) ?? "-",
          d.c_norm?.toFixed(2) ?? "-",
          d.archived ? "yes" : "no",
          formatDate(d.created_at),
          d.id.slice(0, 8),
        ]),
        [14, 5, 8, 8, 8, 10, 20, 10],
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: projects, knowledge, sessions, distillations`,
      );
      process.exit(1);
  }
}

async function cmdShow(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdShowRemote(remote, args, flags);

  const { data, ltm, temporal } = await import("@loreai/core");
  const type = args[0];
  const rawId = args[1];
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const id = data.resolveId("knowledge", rawId) ?? rawId;
      const entry = ltm.get(id);
      if (!entry) {
        console.error(`Knowledge entry not found: ${rawId}`);
        process.exit(1);
      }
      if (asJson) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      console.log(`ID:          ${entry.id}`);
      console.log(`Category:    ${entry.category}`);
      console.log(`Title:       ${entry.title}`);
      console.log(`Confidence:  ${entry.confidence}`);
      console.log(`Project ID:  ${entry.project_id ?? "(global)"}`);
      console.log(`Cross-proj:  ${entry.cross_project ? "yes" : "no"}`);
      console.log(`Session:     ${entry.source_session ?? "(none)"}`);
      console.log(`Created:     ${formatDate(entry.created_at)}`);
      console.log(`Updated:     ${formatDate(entry.updated_at)}`);
      if (entry.metadata) {
        console.log(`Metadata:    ${entry.metadata}`);
      }
      console.log(`\nContent:\n${entry.content}`);
      break;
    }

    case "session": {
      const sessions = data.listSessions(projectPath, 1000);
      // Find session by prefix match
      const session = sessions.find((s) => s.session_id.startsWith(rawId));
      if (!session) {
        console.error(`Session not found: ${rawId}`);
        process.exit(1);
      }
      const messages = temporal.bySession(projectPath, session.session_id);
      const dists = data.listDistillations(projectPath, {
        sessionId: session.session_id,
      });

      if (asJson) {
        console.log(JSON.stringify({ session, messages, distillations: dists }, null, 2));
        return;
      }

      console.log(`Session:       ${session.session_id}`);
      console.log(`Messages:      ${session.message_count}`);
      console.log(`Distilled:     ${session.distilled_count}`);
      console.log(`Undistilled:   ${session.undistilled_count}`);
      console.log(`Distillations: ${session.distillation_count}`);
      console.log(`First:         ${formatDate(session.first_message_at)}`);
      console.log(`Last:          ${formatDate(session.last_message_at)}`);

      if (messages.length) {
        console.log(`\n--- Messages (${messages.length}) ---\n`);
        for (const msg of messages) {
          const prefix = msg.role === "user" ? ">" : "<";
          console.log(
            `${prefix} [${formatDate(msg.created_at)}] ${msg.role}: ${truncate(msg.content, 120)}`,
          );
        }
      }

      if (dists.length) {
        console.log(`\n--- Distillations (${dists.length}) ---\n`);
        for (const d of dists) {
          console.log(
            `  gen=${d.generation} tokens=${d.token_count} ${formatDate(d.created_at)} ${d.id.slice(0, 8)}`,
          );
        }
      }
      break;
    }

    case "distillation": {
      const id = data.resolveId("distillations", rawId) ?? rawId;
      const dist = data.getDistillation(id);
      if (!dist) {
        console.error(`Distillation not found: ${rawId}`);
        process.exit(1);
      }
      if (asJson) {
        console.log(JSON.stringify(dist, null, 2));
        return;
      }
      console.log(`ID:            ${dist.id}`);
      console.log(`Session:       ${dist.session_id}`);
      console.log(`Project ID:    ${dist.project_id}`);
      console.log(`Generation:    ${dist.generation}`);
      console.log(`Tokens:        ${dist.token_count}`);
      console.log(`R_compression: ${dist.r_compression?.toFixed(3) ?? "-"}`);
      console.log(`C_norm:        ${dist.c_norm?.toFixed(3) ?? "-"}`);
      console.log(`Archived:      ${dist.archived ? "yes" : "no"}`);
      console.log(`Created:       ${formatDate(dist.created_at)}`);
      console.log(`Source IDs:    ${dist.source_ids}`);
      console.log(`\nObservations:\n${dist.observations}`);
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation`,
      );
      process.exit(1);
  }
}

async function cmdClear(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  const skipConfirm = !!flags.yes;

  // Nuclear option: wipe entire database (local-only)
  if (flags.all) {
    if (remote) {
      console.error("Error: --all (wipe entire database) is not supported in remote mode.");
      process.exit(1);
    }
    const { data } = await import("@loreai/core");
    if (!skipConfirm) {
      const stats = data.globalStats();
      const confirmed = await confirm(
        `\nWARNING: This will permanently delete ALL Lore data:\n` +
          `  ${stats.project_count} projects, ${stats.knowledge_count} knowledge entries,\n` +
          `  ${stats.message_count} messages, ${stats.distillation_count} distillations\n` +
          `  Database: ${formatBytes(stats.db_size_bytes)}\n`,
      );
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }
    const dbFile = data.wipeDatabase();
    console.log(`Database wiped: ${dbFile}`);
    console.log(
      "Note: Remove or regenerate .lore.md in your project directories to prevent re-import from git.",
    );
    return;
  }

  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (remote) return cmdClearRemote(remote, projectPath, flags);

  const { data } = await import("@loreai/core");
  const onlyKnowledge = !!flags.knowledge;
  const onlyTemporal = !!flags.temporal;
  const onlyDistillations = !!flags.distillations;
  const specific = onlyKnowledge || onlyTemporal || onlyDistillations;

  if (specific) {
    // Collect counts once and build a single confirmation prompt
    const counts = data.countForProject(projectPath);
    const targets: string[] = [];
    if (onlyKnowledge) targets.push(`${counts.knowledge} knowledge entries`);
    if (onlyTemporal) targets.push(`${counts.messages} temporal messages`);
    if (onlyDistillations) targets.push(`${counts.distillations} distillations`);

    if (!skipConfirm) {
      const confirmed = await confirm(
        `\nThis will delete the following for project at:\n  ${projectPath}\n` +
          targets.map((t) => `  - ${t}`).join("\n") +
          (onlyKnowledge ? "\n  The .lore.md file will be regenerated." : ""),
      );
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }

    if (onlyKnowledge) {
      const deleted = data.clearKnowledge(projectPath);
      console.log(`Deleted ${deleted} knowledge entries.`);
      console.log("Regenerated .lore.md \u2014 commit the change to prevent re-import from git.");
    }
    if (onlyTemporal) {
      const deleted = data.clearTemporal(projectPath);
      console.log(`Deleted ${deleted} temporal messages.`);
    }
    if (onlyDistillations) {
      const deleted = data.clearDistillations(projectPath);
      console.log(`Deleted ${deleted} distillations.`);
    }
    return;
  }

  // Default: clear ALL data for the project
  const counts = data.countForProject(projectPath);
  if (!skipConfirm) {
    const confirmed = await confirm(
      `\nThis will permanently delete ALL data for project at:\n  ${projectPath}\n` +
        `  ${counts.knowledge} knowledge entries\n` +
        `  ${counts.messages} temporal messages (${counts.sessions} sessions)\n` +
        `  ${counts.distillations} distillations\n` +
        `The .lore.md file will be regenerated.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = data.clearProject(projectPath);
  console.log(
    `Cleared: ${result.knowledge_deleted} knowledge, ${result.temporal_deleted} messages, ${result.distillations_deleted} distillations.`,
  );
  console.log("Regenerated .lore.md \u2014 commit the change to prevent re-import from git.");
}

async function cmdDelete(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdDeleteRemote(remote, args, flags);

  const { data } = await import("@loreai/core");
  const type = args[0];
  const rawId = args[1];
  const skipConfirm = !!flags.yes;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const id = data.resolveId("knowledge", rawId) ?? rawId;
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete knowledge entry ${id.slice(0, 12)}...?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      if (data.deleteKnowledge(id)) {
        console.log(`Deleted knowledge entry: ${id}`);
      } else {
        console.error(`Knowledge entry not found: ${rawId}`);
        process.exit(1);
      }
      break;
    }

    case "session": {
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete all messages and distillations for session ${rawId}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const result = data.deleteSession(projectPath, rawId);
      console.log(
        `Deleted: ${result.messages_deleted} messages, ${result.distillations_deleted} distillations.`,
      );
      break;
    }

    case "distillation": {
      const id = data.resolveId("distillations", rawId) ?? rawId;
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete distillation ${id.slice(0, 12)}...?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      if (data.deleteDistillation(id)) {
        console.log(`Deleted distillation: ${id}`);
      } else {
        console.error(`Distillation not found: ${rawId}`);
        process.exit(1);
      }
      break;
    }

    case "project": {
      const { projectId: resolveProjectId } = await import("@loreai/core");
      // rawId can be a project UUID or a filesystem path
      let id = rawId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
        const resolved = resolveProjectId(resolve(rawId));
        if (!resolved) {
          console.error(`No project found for path: ${rawId}`);
          process.exit(1);
        }
        id = resolved;
      }
      // Validate existence before prompting for confirmation
      const project = data.listProjects().find((p) => p.id === id);
      if (!project) {
        console.error(`Project not found: ${rawId}`);
        process.exit(1);
      }
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete project ${project.name ?? id.slice(0, 12)}... and ALL its data ` +
            `(${project.knowledge_count} knowledge, ${project.session_count} sessions, ` +
            `${project.distillation_count} distillations)?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const result = data.deleteProject(id)!;
      console.log(
        `Deleted project: ${result.knowledge_deleted} knowledge, ` +
          `${result.temporal_deleted} messages, ` +
          `${result.distillations_deleted} distillations, ` +
          `${result.sessions_cleared} sessions.`,
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation, project`,
      );
      process.exit(1);
  }
}

async function cmdRecover(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error("Error: recover is not supported in remote mode (requires local filesystem access).");
    process.exit(1);
  }

  const { existsSync } = await import("fs");
  const { join } = await import("path");
  const { data, importLoreFile, importFromFile, loreFileExists, clearLoreFileCache, LORE_FILE } =
    await import("@loreai/core");
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  const projects = data.listProjects();
  const recoverable: Array<{
    name: string | null;
    path: string;
    source: string; // ".lore.md" | "AGENTS.md" | "CLAUDE.md"
  }> = [];

  // Scan for recoverable files
  for (const project of projects) {
    if (!existsSync(project.path)) continue;

    if (loreFileExists(project.path)) {
      recoverable.push({ name: project.name, path: project.path, source: LORE_FILE });
    } else {
      // Check AGENTS.md, then CLAUDE.md
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = join(project.path, filename);
        if (existsSync(filePath)) {
          recoverable.push({ name: project.name, path: project.path, source: filename });
          break; // prefer AGENTS.md over CLAUDE.md
        }
      }
    }
  }

  if (recoverable.length === 0) {
    console.log("No recoverable files found in any project directory.");
    return;
  }

  console.log(`Found ${recoverable.length} project(s) with recoverable knowledge files:\n`);
  for (const r of recoverable) {
    console.log(`  ${r.name ?? r.path}  ← ${r.source}`);
  }
  console.log();

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will re-import knowledge entries from the files listed above.\n` +
        `Entries with existing UUIDs will be updated if changed.\n` +
        `New entries (unknown UUIDs or hand-written) will be created.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const results: Array<{
    name: string | null;
    path: string;
    source: string;
    before: number;
    after: number;
  }> = [];

  for (const r of recoverable) {
    const before = data.countForProject(r.path).knowledge;

    // Clear the file cache to ensure shouldImportLoreFile won't short-circuit
    clearLoreFileCache(r.path);

    if (r.source === LORE_FILE) {
      importLoreFile(r.path);
    } else {
      importFromFile({ projectPath: r.path, filePath: join(r.path, r.source) });
    }

    const after = data.countForProject(r.path).knowledge;
    results.push({ name: r.name, path: r.path, source: r.source, before, after });
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\nRecovery results:`);
  let totalImported = 0;
  for (const r of results) {
    const imported = r.after - r.before;
    totalImported += imported;
    const label = r.name ?? r.path;
    if (imported > 0) {
      console.log(`  ${padRight(label, 30)}  +${imported} entries (${r.before} → ${r.after}) from ${r.source}`);
    } else {
      console.log(`  ${padRight(label, 30)}  no change (${r.after} entries) from ${r.source}`);
    }
  }
  console.log(`\nTotal: ${totalImported} entries recovered across ${results.length} project(s).`);
}

async function cmdMerge(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdMergeRemote(remote, flags);

  const { data } = await import("@loreai/core");
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  // Dry run first: show what would be merged
  const projects = data.listProjects();
  const withoutRemote = projects.filter((p) => !p.git_remote);

  if (withoutRemote.length === 0) {
    console.log("All projects already have git remote information.");
    console.log("No merges needed.");
    return;
  }

  console.log(
    `Found ${withoutRemote.length} project(s) without git remote information.`,
  );
  console.log("Scanning git remotes...\n");

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will:\n` +
        `  1. Scan ${withoutRemote.length} project paths for git remote URLs\n` +
        `  2. Set git_remote on projects that are git repositories\n` +
        `  3. Merge projects that share the same git remote\n\n` +
        `Merged projects will have their data (knowledge, messages,\n` +
        `distillations) consolidated into a single project entry.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = data.backfillGitRemotes();

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nResults:`);
  console.log(`  Updated: ${result.updated} project(s) with git remote info`);
  console.log(`  Merged:  ${result.merged} duplicate project(s)`);
  console.log(`  Renamed: ${result.namesBackfilled} project(s) with repo name`);

  if (result.mergeDetails.length > 0) {
    console.log(`\nMerge details:`);
    for (const detail of result.mergeDetails) {
      console.log(`  ${detail.sourcePath}`);
      console.log(`    → merged into: ${detail.targetPath}`);
      console.log(`    git remote:    ${detail.gitRemote}`);
      console.log(
        `    moved: ${detail.result.knowledge_moved} knowledge, ` +
          `${detail.result.messages_moved} messages, ` +
          `${detail.result.distillations_moved} distillations`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// dedup — Deduplicate knowledge entries across all projects (or one)
// ---------------------------------------------------------------------------

/** Stable pair key for two entry IDs — mirrors ltm.dedupPairKey(). */
function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

function printDedupResult(
  result: Awaited<ReturnType<typeof import("@loreai/core").ltm.deduplicate>>,
  apply: boolean,
  label?: string,
): void {
  if (label) console.log(`\n--- ${label} ---\n`);

  for (let i = 0; i < result.clusters.length; i++) {
    const cluster = result.clusters[i];
    const total = 1 + cluster.merged.length;
    console.log(`Cluster ${i + 1} (${total} entries → 1):`);
    console.log(`  Keep:   "${truncate(cluster.surviving.title, 70)}" (${cluster.surviving.id.slice(0, 8)}…)`);
    for (const m of cluster.merged) {
      const pk = pairKey(cluster.surviving.id, m.id);
      const sim = result.pairSimilarities.get(pk);
      const simStr = sim != null ? ` [sim: ${sim.toFixed(3)}]` : "";
      console.log(`  ${apply ? "Remove" : "Would remove"}: "${truncate(m.title, 55)}" (${m.id.slice(0, 8)}…)${simStr}`);
    }
    console.log();
  }
}

/** Prompt the user for a single-key choice. Returns the chosen key, or "s" on EOF/close. */
function promptChoice(message: string, choices: string[], fallback = "s"): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let resolved = false;
    rl.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve(fallback);
      }
    });
    const ask = () => {
      rl.question(message, (answer) => {
        if (resolved) return;
        const trimmed = answer.trim().toLowerCase();
        if (choices.includes(trimmed)) {
          resolved = true;
          rl.close();
          resolve(trimmed);
        } else {
          ask(); // re-prompt on invalid input
        }
      });
    };
    ask();
  });
}

async function cmdDedup(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdDedupRemote(remote, flags);

  const { ltm, data, projectId: getProjectId, embedding: emb } = await import("@loreai/core");
  const apply = !!flags.yes;
  const interactive = !!flags.interactive;
  const asJson = !!flags.json;
  const explicitProject = typeof flags.project === "string" ? resolve(flags.project) : null;

  if (interactive && apply) {
    console.error("Error: --interactive and --yes are mutually exclusive.");
    process.exit(1);
  }

  if (interactive && !process.stdin.isTTY) {
    console.error("Error: --interactive requires a TTY. Use --yes for non-interactive.");
    process.exit(1);
  }

  // Determine which projects to process
  const projects = explicitProject
    ? [{ path: explicitProject, name: explicitProject }]
    : data.listProjects().map((p) => ({ path: p.path, name: p.name ?? p.path }));

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  // Auto-reindex if embedding config changed (e.g. model migration)
  // or if there are entries missing embeddings. backfillEmbeddings()
  // calls checkConfigChange() internally — no need to call it separately.
  if (emb.isAvailable()) {
    try {
      const knowledgeCount = await emb.backfillEmbeddings();
      // Also backfill distillations — checkConfigChange() inside
      // backfillEmbeddings() may have NULLed their embeddings too.
      const distillCount = await emb.backfillDistillationEmbeddings();
      const total = knowledgeCount + distillCount;
      if (total > 0) {
        console.log(`Re-indexed ${total} entries (${knowledgeCount} knowledge, ${distillCount} distillations).\n`);
      }
    } catch (err) {
      console.error("Warning: embedding reindex failed, dedup will use title-overlap only:", err);
    }
  }

  // Display calibration status for each project
  for (const project of projects) {
    const pid = getProjectId(project.path);
    if (!pid) continue;
    const count = ltm.getDedupFeedbackCount(pid);
    const threshold = ltm.loadCalibratedThreshold(pid);
    if (threshold !== null) {
      console.log(`[${project.name}] Using calibrated threshold ${threshold.toFixed(3)} (from ${count} feedback pairs, default: 0.935).`);
    } else if (count > 0) {
      console.log(`[${project.name}] ${count}/20 feedback samples collected. Threshold calibration activates after 20 samples.`);
    }
  }

  // Interactive mode: dry-run first, then prompt per cluster
  if (interactive) {
    await cmdDedupInteractive(projects, explicitProject, ltm, getProjectId);
    return;
  }

  if (!apply) {
    console.log("Scanning for duplicate knowledge entries (dry run)...\n");
  } else {
    console.log("Deduplicating knowledge entries...\n");
  }

  let grandTotalRemoved = 0;
  let grandTotalClusters = 0;
  const allResults: Array<{ name: string; path: string; result: Awaited<ReturnType<typeof ltm.deduplicate>> }> = [];

  for (const project of projects) {
    const result = await ltm.deduplicate(project.path, { dryRun: !apply });
    if (result.clusters.length > 0) {
      allResults.push({ name: project.name, path: project.path, result });
      grandTotalRemoved += result.totalRemoved;
      grandTotalClusters += result.clusters.length;
    }
  }

  // Also dedup global (cross-project) entries
  const globalResult = await ltm.deduplicateGlobal({ dryRun: !apply });
  if (globalResult.clusters.length > 0) {
    allResults.push({ name: "Global", path: "", result: globalResult });
    grandTotalRemoved += globalResult.totalRemoved;
    grandTotalClusters += globalResult.clusters.length;
  }

  if (grandTotalClusters === 0) {
    console.log("No duplicates found.");
    return;
  }

  if (asJson) {
    // Map is not JSON-serializable — convert to plain objects.
    const serializable = allResults.map((r) => ({
      ...r,
      result: {
        ...r.result,
        pairSimilarities: Object.fromEntries(r.result.pairSimilarities),
        entryTitles: Object.fromEntries(r.result.entryTitles),
      },
    }));
    console.log(JSON.stringify(serializable, null, 2));
    return;
  }

  const multiProject = allResults.length > 1 || (!explicitProject && projects.length > 1);
  for (const { name, result } of allResults) {
    printDedupResult(result, apply, multiProject ? name : undefined);
  }

  console.log(
    `${apply ? "Removed" : "Would remove"} ${grandTotalRemoved} duplicate entries ` +
      `across ${grandTotalClusters} clusters` +
      (multiProject ? ` in ${allResults.length} projects.` : "."),
  );

  // Record feedback and recalibrate when --yes is used
  if (apply) {
    for (const { name, path, result } of allResults) {
      const pid = name === "Global" ? null : getProjectId(path) ?? null;
      ltm.recordDedupResultFeedback(pid, result, true, "cli_yes");
    }
    // Recalibrate per project
    const calibratedProjects = new Set<string | null>();
    for (const { name, path } of allResults) {
      const pid = name === "Global" ? null : getProjectId(path) ?? null;
      if (calibratedProjects.has(pid)) continue;
      calibratedProjects.add(pid);
      const newThreshold = ltm.calibrateDedupThreshold(pid);
      if (newThreshold !== null) {
        const count = ltm.getDedupFeedbackCount(pid);
        ltm.saveCalibratedThreshold(pid, newThreshold, count);
        console.log(`Threshold calibrated to ${newThreshold.toFixed(3)} (from ${count} feedback pairs).`);
      }
    }
  }

  if (!apply) {
    console.log("\nRun with --yes to apply, or --interactive for per-cluster review.");
  }
}

/**
 * Interactive dedup: dry-run first, then prompt the user per cluster
 * for accept/reject/skip decisions. Records feedback for calibration.
 */
async function cmdDedupInteractive(
  projects: Array<{ path: string; name: string }>,
  explicitProject: string | null,
  ltm: typeof import("@loreai/core").ltm,
  getProjectId: typeof import("@loreai/core").projectId,
): Promise<void> {
  console.log("Scanning for duplicate knowledge entries (interactive mode)...\n");

  // Collect all clusters across projects (dry run)
  type ProjectCluster = {
    projectName: string;
    projectPath: string;
    cluster: Awaited<ReturnType<typeof ltm.deduplicate>>["clusters"][number];
    pairSimilarities: Map<string, number>;
  };
  const allClusters: ProjectCluster[] = [];

  for (const project of projects) {
    const result = await ltm.deduplicate(project.path, { dryRun: true });
    for (const cluster of result.clusters) {
      allClusters.push({
        projectName: project.name,
        projectPath: project.path,
        cluster,
        pairSimilarities: result.pairSimilarities,
      });
    }
  }

  // Global entries
  const globalResult = await ltm.deduplicateGlobal({ dryRun: true });
  for (const cluster of globalResult.clusters) {
    allClusters.push({
      projectName: "Global",
      projectPath: "",
      cluster,
      pairSimilarities: globalResult.pairSimilarities,
    });
  }

  if (allClusters.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  let acceptedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  let removedCount = 0;
  const multiProject = allClusters.length > 1 || (!explicitProject && projects.length > 1);

  for (let i = 0; i < allClusters.length; i++) {
    const { projectName, projectPath, cluster, pairSimilarities } = allClusters[i];
    const total = 1 + cluster.merged.length;

    if (multiProject) console.log(`--- ${projectName} ---`);
    console.log(`\nCluster ${i + 1} of ${allClusters.length} (${total} entries → 1):`);
    console.log(`  Keep:   "${truncate(cluster.surviving.title, 70)}" (${cluster.surviving.id.slice(0, 8)}…)`);
    for (const m of cluster.merged) {
      const pk = pairKey(cluster.surviving.id, m.id);
      const sim = pairSimilarities.get(pk);
      const simStr = sim != null ? ` [sim: ${sim.toFixed(3)}]` : "";
      console.log(`  Merge:  "${truncate(m.title, 55)}" (${m.id.slice(0, 8)}…)${simStr}`);
    }

    const answer = await promptChoice("\n  [a]ccept merge / [r]eject (keep all) / [s]kip? ", ["a", "r", "s"]);
    const pid = projectName === "Global" ? null : getProjectId(projectPath) ?? null;

    if (answer === "a") {
      // Apply merge: remove merged entries
      for (const m of cluster.merged) {
        ltm.remove(m.id);
      }
      // Record accept feedback
      for (const m of cluster.merged) {
        const pk = pairKey(cluster.surviving.id, m.id);
        const sim = pairSimilarities.get(pk);
        if (sim != null && sim > 0) {
          ltm.recordDedupFeedback({
            projectId: pid,
            entryATitle: cluster.surviving.title,
            entryBTitle: m.title,
            similarity: sim,
            accepted: true,
            source: "cli_interactive",
          });
        }
      }
      acceptedCount++;
      removedCount += cluster.merged.length;
      console.log(`  → Merged (${cluster.merged.length} entries removed).`);
    } else if (answer === "r") {
      // Record reject feedback (don't delete anything)
      for (const m of cluster.merged) {
        const pk = pairKey(cluster.surviving.id, m.id);
        const sim = pairSimilarities.get(pk);
        if (sim != null && sim > 0) {
          ltm.recordDedupFeedback({
            projectId: pid,
            entryATitle: cluster.surviving.title,
            entryBTitle: m.title,
            similarity: sim,
            accepted: false,
            source: "cli_interactive",
          });
        }
      }
      rejectedCount++;
      console.log("  → Kept separate.");
    } else {
      skippedCount++;
      console.log("  → Skipped.");
    }
  }

  console.log(
    `\nDone: ${acceptedCount} accepted (${removedCount} entries removed), ` +
      `${rejectedCount} rejected, ${skippedCount} skipped.`,
  );

  // Recalibrate per project after interactive session
  const calibratedProjects = new Set<string | null>();
  for (const { projectName, projectPath } of allClusters) {
    const pid = projectName === "Global" ? null : getProjectId(projectPath) ?? null;
    if (calibratedProjects.has(pid)) continue;
    calibratedProjects.add(pid);
    const newThreshold = ltm.calibrateDedupThreshold(pid);
    if (newThreshold !== null) {
      const count = ltm.getDedupFeedbackCount(pid);
      ltm.saveCalibratedThreshold(pid, newThreshold, count);
      console.log(`Threshold calibrated to ${newThreshold.toFixed(3)} (from ${count} feedback pairs).`);
    }
  }
}

async function cmdReindex(
  flags?: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdReindexRemote(remote, flags ?? {});

  const { embedding } = await import("@loreai/core");

  if (!embedding.isAvailable()) {
    console.error("No embedding provider available.");
    console.error(
      "Set VOYAGE_API_KEY/OPENAI_API_KEY for remote embeddings, or ensure " +
        "@huggingface/transformers is installed for local embeddings.",
    );
    process.exit(1);
  }

  try {
    // backfillEmbeddings() calls checkConfigChange() internally —
    // it detects config changes, clears stale embeddings, then re-embeds.
    console.log("Re-indexing knowledge entries...");
    const knowledgeCount = await embedding.backfillEmbeddings();
    console.log(`  ✓ ${knowledgeCount} knowledge entries embedded`);

    console.log("Re-indexing distillations...");
    const distillCount = await embedding.backfillDistillationEmbeddings();
    console.log(`  ✓ ${distillCount} distillations embedded`);

    const total = knowledgeCount + distillCount;
    if (total === 0) {
      console.log("\nAll embeddings are up to date.");
    } else {
      console.log(`\nDone — ${total} entries re-indexed.`);
    }
  } catch (err) {
    console.error("Re-indexing failed:", err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Remote CLI handlers
// ---------------------------------------------------------------------------

async function cmdListRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const limit = flags.limit ? Number(flags.limit) : 50;
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  switch (type) {
    case "projects": {
      const projects = await remoteGet<Array<{
        id: string; path: string; name: string | null; git_remote: string | null;
        created_at: number; knowledge_count: number; session_count: number;
      }>>(remote, "/api/v1/projects");
      if (asJson) { console.log(JSON.stringify(projects, null, 2)); return; }
      if (!projects.length) { console.log("No projects found."); return; }
      printTable(
        ["Name", "Path", "Git Remote", "ID", "Knowledge", "Sessions", "Created"],
        projects.map((p) => [
          p.name ?? "(unnamed)", truncate(p.path, 35), truncate(p.git_remote ?? "-", 30),
          p.id.slice(0, 8), String(p.knowledge_count), String(p.session_count), formatDate(p.created_at),
        ]),
        [16, 35, 30, 10, 10, 10, 20],
      );
      break;
    }

    case "knowledge": {
      const matchingProject = await resolveRemoteProject(remote, projectPath);
      if (!matchingProject) { console.error(`No project found for: ${projectPath}`); process.exit(1); }
      const entries = await remoteGet<Array<{ id: string; category: string; title: string; confidence: number; updated_at: number }>>(
        remote, `/api/v1/projects/${matchingProject}/knowledge`,
      );
      const limited = entries.slice(0, limit);
      if (asJson) { console.log(JSON.stringify(limited, null, 2)); return; }
      if (!limited.length) { console.log("No knowledge entries found for this project."); return; }
      printTable(
        ["Category", "Title", "Confidence", "Updated", "ID"],
        limited.map((e) => [
          e.category, truncate(e.title, 40), e.confidence.toFixed(2),
          formatDate(e.updated_at), e.id.slice(0, 8),
        ]),
        [14, 40, 12, 20, 10],
      );
      break;
    }

    case "sessions": {
      const projectId = await resolveRemoteProject(remote, projectPath);
      if (!projectId) { console.error(`No project found for: ${projectPath}`); process.exit(1); }
      const sessions = await remoteGet<Array<{
        session_id: string; message_count: number; distilled_count: number;
        distillation_count: number; first_message_at: number; last_message_at: number;
      }>>(remote, `/api/v1/projects/${projectId}/sessions?limit=${limit}`);
      if (asJson) { console.log(JSON.stringify(sessions, null, 2)); return; }
      if (!sessions.length) { console.log("No sessions found for this project."); return; }
      printTable(
        ["Session ID", "Messages", "Distilled", "Distillations", "First", "Last"],
        sessions.map((s) => [
          s.session_id.slice(0, 12), String(s.message_count), String(s.distilled_count),
          String(s.distillation_count), formatDate(s.first_message_at), formatDate(s.last_message_at),
        ]),
        [14, 10, 10, 14, 20, 20],
      );
      break;
    }

    case "distillations": {
      const projectId = await resolveRemoteProject(remote, projectPath);
      if (!projectId) { console.error(`No project found for: ${projectPath}`); process.exit(1); }
      const dists = await remoteGet<Array<{
        id: string; session_id: string; generation: number; token_count: number;
        r_compression: number | null; c_norm: number | null; archived: number; created_at: number;
      }>>(remote, `/api/v1/projects/${projectId}/distillations?limit=${limit}`);
      if (asJson) { console.log(JSON.stringify(dists, null, 2)); return; }
      if (!dists.length) { console.log("No distillations found for this project."); return; }
      printTable(
        ["Session", "Gen", "Tokens", "R_comp", "C_norm", "Archived", "Created", "ID"],
        dists.map((d) => [
          d.session_id.slice(0, 12), String(d.generation), String(d.token_count),
          d.r_compression?.toFixed(2) ?? "-", d.c_norm?.toFixed(2) ?? "-",
          d.archived ? "yes" : "no", formatDate(d.created_at), d.id.slice(0, 8),
        ]),
        [14, 5, 8, 8, 8, 10, 20, 10],
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: projects, knowledge, sessions, distillations`,
      );
      process.exit(1);
  }
}

async function cmdShowRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const rawId = args[1];
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const entry = await remoteGet<{
        id: string; category: string; title: string; content: string; confidence: number;
        project_id: string | null; cross_project: boolean; source_session: string | null;
        created_at: number; updated_at: number; metadata: string | null;
      }>(remote, `/api/v1/knowledge/${encodeURIComponent(rawId)}`);
      if (asJson) { console.log(JSON.stringify(entry, null, 2)); return; }
      console.log(`ID:          ${entry.id}`);
      console.log(`Category:    ${entry.category}`);
      console.log(`Title:       ${entry.title}`);
      console.log(`Confidence:  ${entry.confidence}`);
      console.log(`Project ID:  ${entry.project_id ?? "(global)"}`);
      console.log(`Cross-proj:  ${entry.cross_project ? "yes" : "no"}`);
      console.log(`Session:     ${entry.source_session ?? "(none)"}`);
      console.log(`Created:     ${formatDate(entry.created_at)}`);
      console.log(`Updated:     ${formatDate(entry.updated_at)}`);
      if (entry.metadata) console.log(`Metadata:    ${entry.metadata}`);
      console.log(`\nContent:\n${entry.content}`);
      break;
    }

    case "session": {
      const pq = projectQueryParams(projectPath);
      const data = await remoteGet<{
        messages: Array<{ role: string; content: string; created_at: number }>;
        distillations: Array<{ id: string; generation: number; token_count: number; created_at: number }>;
      }>(remote, `/api/v1/sessions/${encodeURIComponent(rawId)}?${pq}`);
      if (asJson) { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(`Session: ${rawId}`);
      console.log(`Messages: ${data.messages.length}`);
      console.log(`Distillations: ${data.distillations.length}`);
      if (data.messages.length) {
        console.log(`\n--- Messages (${data.messages.length}) ---\n`);
        for (const msg of data.messages) {
          const prefix = msg.role === "user" ? ">" : "<";
          console.log(`${prefix} [${formatDate(msg.created_at)}] ${msg.role}: ${truncate(msg.content, 120)}`);
        }
      }
      if (data.distillations.length) {
        console.log(`\n--- Distillations (${data.distillations.length}) ---\n`);
        for (const d of data.distillations) {
          console.log(`  gen=${d.generation} tokens=${d.token_count} ${formatDate(d.created_at)} ${d.id.slice(0, 8)}`);
        }
      }
      break;
    }

    case "distillation": {
      const dist = await remoteGet<{
        id: string; session_id: string; project_id: string; generation: number;
        token_count: number; r_compression: number | null; c_norm: number | null;
        archived: number; created_at: number; source_ids: string; observations: string;
      }>(remote, `/api/v1/distillations/${encodeURIComponent(rawId)}`);
      if (asJson) { console.log(JSON.stringify(dist, null, 2)); return; }
      console.log(`ID:            ${dist.id}`);
      console.log(`Session:       ${dist.session_id}`);
      console.log(`Project ID:    ${dist.project_id}`);
      console.log(`Generation:    ${dist.generation}`);
      console.log(`Tokens:        ${dist.token_count}`);
      console.log(`R_compression: ${dist.r_compression?.toFixed(3) ?? "-"}`);
      console.log(`C_norm:        ${dist.c_norm?.toFixed(3) ?? "-"}`);
      console.log(`Archived:      ${dist.archived ? "yes" : "no"}`);
      console.log(`Created:       ${formatDate(dist.created_at)}`);
      console.log(`Source IDs:    ${dist.source_ids}`);
      console.log(`\nObservations:\n${dist.observations}`);
      break;
    }

    default:
      console.error(`Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation`);
      process.exit(1);
  }
}

async function cmdClearRemote(
  remote: string,
  projectPath: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const skipConfirm = !!flags.yes;
  const projectId = await resolveRemoteProject(remote, projectPath);
  if (!projectId) { console.error(`No project found for: ${projectPath}`); process.exit(1); }

  const body: Record<string, boolean> = {};
  if (flags.knowledge) body.knowledge = true;
  if (flags.temporal) body.temporal = true;
  if (flags.distillations) body.distillations = true;

  const hasFlags = body.knowledge || body.temporal || body.distillations;
  const label = hasFlags
    ? `selected data (${Object.keys(body).join(", ")})`
    : "ALL data";

  if (!skipConfirm) {
    const confirmed = await confirm(`\nClear ${label} for project at:\n  ${projectPath}\n`);
    if (!confirmed) { console.log("Cancelled."); return; }
  }

  const result = await remotePost<Record<string, number>>(remote, `/api/v1/projects/${projectId}/clear`, body);
  const parts = Object.entries(result).map(([k, v]) => `${v} ${k.replace("_", " ")}`);
  console.log(`Cleared: ${parts.join(", ")}.`);
}

async function cmdDeleteRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const rawId = args[1];
  const skipConfirm = !!flags.yes;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) { console.error("Error: Missing <id> argument."); process.exit(1); }

  switch (type) {
    case "knowledge": {
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete knowledge entry ${rawId}?`);
        if (!confirmed) { console.log("Cancelled."); return; }
      }
      await remoteDelete(remote, `/api/v1/knowledge/${encodeURIComponent(rawId)}`);
      console.log(`Deleted knowledge entry: ${rawId}`);
      break;
    }

    case "session": {
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete all messages and distillations for session ${rawId}?`);
        if (!confirmed) { console.log("Cancelled."); return; }
      }
      const pq = projectQueryParams(projectPath);
      const result = await remoteDelete<{ messages_deleted: number; distillations_deleted: number }>(
        remote, `/api/v1/sessions/${encodeURIComponent(rawId)}?${pq}`,
      );
      console.log(`Deleted: ${result.messages_deleted} messages, ${result.distillations_deleted} distillations.`);
      break;
    }

    case "distillation": {
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete distillation ${rawId}?`);
        if (!confirmed) { console.log("Cancelled."); return; }
      }
      await remoteDelete(remote, `/api/v1/distillations/${encodeURIComponent(rawId)}`);
      console.log(`Deleted distillation: ${rawId}`);
      break;
    }

    case "project": {
      // Resolve project: rawId can be UUID or path
      let projectId = rawId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
        const resolved = await resolveRemoteProject(remote, resolve(rawId));
        if (!resolved) { console.error(`No project found for path: ${rawId}`); process.exit(1); }
        projectId = resolved;
      }
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete project ${projectId.slice(0, 12)}... and ALL its data?`);
        if (!confirmed) { console.log("Cancelled."); return; }
      }
      const result = await remoteDelete<{
        knowledge_deleted: number; temporal_deleted: number;
        distillations_deleted: number; sessions_cleared: number;
      }>(remote, `/api/v1/projects/${encodeURIComponent(projectId)}`);
      console.log(
        `Deleted project: ${result.knowledge_deleted} knowledge, ` +
          `${result.temporal_deleted} messages, ` +
          `${result.distillations_deleted} distillations, ` +
          `${result.sessions_cleared} sessions.`,
      );
      break;
    }

    default:
      console.error(`Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation, project`);
      process.exit(1);
  }
}

async function cmdMergeRemote(
  remote: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will scan git remotes and merge duplicate projects on the remote gateway.`,
    );
    if (!confirmed) { console.log("Cancelled."); return; }
  }

  const result = await remotePost<{
    updated: number; merged: number; namesBackfilled: number;
    mergeDetails: Array<{ sourcePath: string; targetPath: string; gitRemote: string; result: Record<string, number> }>;
  }>(remote, "/api/v1/projects/merge");

  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`\nResults:`);
  console.log(`  Updated: ${result.updated} project(s) with git remote info`);
  console.log(`  Merged:  ${result.merged} duplicate project(s)`);
  console.log(`  Renamed: ${result.namesBackfilled} project(s) with repo name`);

  if (result.mergeDetails?.length) {
    console.log(`\nMerge details:`);
    for (const detail of result.mergeDetails) {
      console.log(`  ${detail.sourcePath}`);
      console.log(`    → merged into: ${detail.targetPath}`);
      console.log(`    git remote:    ${detail.gitRemote}`);
    }
  }
}

async function cmdDedupRemote(
  remote: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const asJson = !!flags.json;
  const interactive = !!flags.interactive;
  const explicitProject = typeof flags.project === "string" ? resolve(flags.project) : null;

  if (interactive) {
    console.error("Error: --interactive mode is not supported in remote mode. Use --yes for non-interactive.");
    process.exit(1);
  }

  let projectId: string | undefined;
  if (explicitProject) {
    projectId = await resolveRemoteProject(remote, explicitProject) ?? undefined;
    if (!projectId) { console.error(`No project found for: ${explicitProject}`); process.exit(1); }
  }

  console.log("Scanning for duplicate knowledge entries (dry run, remote)...\n");

  if (!projectId) {
    const projects = await remoteGet<Array<{ id: string; name: string | null }>>(remote, "/api/v1/projects");
    if (!projects.length) { console.log("No projects found."); return; }
    // Dedup each project
    for (const p of projects) {
      const result = await remotePost(remote, `/api/v1/projects/${p.id}/dedup`);
      if (asJson) { console.log(JSON.stringify({ project: p.name ?? p.id, ...result as object }, null, 2)); }
      else { console.log(`[${p.name ?? p.id}] ${JSON.stringify(result)}`); }
    }
  } else {
    const result = await remotePost(remote, `/api/v1/projects/${projectId}/dedup`);
    if (asJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(JSON.stringify(result, null, 2)); }
  }

  console.log("\nNote: Remote dedup is always a dry run. Apply changes locally or via the gateway.");
}

async function cmdReindexRemote(
  remote: string,
  flags: Record<string, unknown>,
): Promise<void> {
  console.log("Re-indexing embeddings on remote gateway...");
  const result = await remotePost<{
    knowledge_embedded: number; distillations_embedded: number;
  }>(remote, "/api/v1/reindex");

  const total = result.knowledge_embedded + result.distillations_embedded;
  console.log(`  ${result.knowledge_embedded} knowledge entries embedded`);
  console.log(`  ${result.distillations_embedded} distillations embedded`);
  if (total === 0) {
    console.log("\nAll embeddings are up to date.");
  } else {
    console.log(`\nDone — ${total} entries re-indexed.`);
  }
}

/**
 * Resolve a local project path to a remote project UUID.
 * Lists projects from the remote and matches by git_remote (preferred) or path.
 */
async function resolveRemoteProject(
  remote: string,
  projectPath: string,
): Promise<string | null> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const gitRemote = getGitRemote(projectPath);
  const normalizedRemote = gitRemote ? normalizeRemoteUrl(gitRemote) : null;

  const projects = await remoteGet<Array<{
    id: string; path: string; git_remote: string | null;
  }>>(remote, "/api/v1/projects");

  // Prefer git_remote match
  if (normalizedRemote) {
    for (const p of projects) {
      if (p.git_remote && normalizeRemoteUrl(p.git_remote) === normalizedRemote) {
        return p.id;
      }
    }
  }

  // Fallback: exact path match
  for (const p of projects) {
    if (p.path === projectPath) return p.id;
  }

  return null;
}

// Main dispatch
// ---------------------------------------------------------------------------

const DATA_HELP = `
lore data — Manage stored data

Usage:
  lore data <subcommand> [options]

Subcommands:
  list <type>           List entries (projects, knowledge, sessions, distillations)
  show <type> <id>      Show full detail for an entry
  clear [options]       Clear data for a project or wipe the database
  delete <type> <id>    Delete a single entry (type: knowledge, session, distillation, project)
  merge                 Scan git remotes and merge duplicate projects
  recover               Re-import knowledge from .lore.md / AGENTS.md files
  dedup                 Find and remove duplicate knowledge entries (all projects)
  reindex               Rebuild embedding vectors (after model/config change)

Options:
  --project <path>      Target project directory (default: current directory)
  --limit <n>           Max rows for list commands (default: 50)
  --json                Output JSON instead of table
  --yes, -y             Skip confirmation for destructive operations
  --interactive, -i     Interactive mode for dedup (accept/reject per cluster)

Clear options:
  --knowledge           Clear only knowledge entries
  --temporal            Clear only temporal messages
  --distillations       Clear only distillations
  --all                 Wipe the entire database (ignores --project)

Examples:
  lore data list projects
  lore data list knowledge --project /path/to/project
  lore data show knowledge abc12345
  lore data clear --project .
  lore data clear --project . --knowledge --yes
  lore data clear --all
  lore data delete knowledge abc12345
  lore data delete session abc12345-6789
  lore data delete project /path/to/project  # delete project and ALL its data
  lore data merge                          # scan & merge git duplicates
  lore data merge --yes                    # skip confirmation
  lore data recover                        # re-import from .lore.md / AGENTS.md
  lore data recover --yes                  # skip confirmation
  lore data dedup                          # dry-run: show duplicate clusters
  lore data dedup --yes                    # apply: remove duplicates
  lore data dedup --interactive            # accept/reject each cluster interactively
  lore data dedup --project /path/to/project
  lore data reindex                        # rebuild all embedding vectors
`.trimStart();

export async function commandData(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const subcommand = positionals[0];
  const subArgs = positionals.slice(1);

  switch (subcommand) {
    case "list":
      await cmdList(subArgs, values);
      break;
    case "show":
      await cmdShow(subArgs, values);
      break;
    case "clear":
      await cmdClear(subArgs, values);
      break;
    case "delete":
      await cmdDelete(subArgs, values);
      break;
    case "merge":
      await cmdMerge(subArgs, values);
      break;
    case "recover":
      await cmdRecover(subArgs, values);
      break;
    case "dedup":
      await cmdDedup(subArgs, values);
      break;
    case "reindex":
      await cmdReindex(values);
      break;
    case "help":
    case undefined:
      console.log(DATA_HELP);
      break;
    default:
      console.error(`Unknown subcommand "${subcommand}".`);
      console.log(DATA_HELP);
      process.exit(1);
  }
}
