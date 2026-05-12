/**
 * CLI `lore data` command — inspect and manage stored data.
 *
 * Subcommands:
 *   list <type>           List entries (projects, knowledge, sessions, distillations)
 *   show <type> <id>      Show full detail for an entry
 *   clear [options]       Clear data for a project or wipe the database
 *   delete <type> <id>    Delete a single entry
 */
import { createInterface } from "node:readline";
import { resolve } from "path";

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
  const { data } = await import("@loreai/core");
  const skipConfirm = !!flags.yes;

  // Nuclear option: wipe entire database
  if (flags.all) {
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

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation`,
      );
      process.exit(1);
  }
}

async function cmdRecover(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
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
  delete <type> <id>    Delete a single entry
  merge                 Scan git remotes and merge duplicate projects
  recover               Re-import knowledge from .lore.md / AGENTS.md files

Options:
  --project <path>      Target project directory (default: current directory)
  --limit <n>           Max rows for list commands (default: 50)
  --json                Output JSON instead of table
  --yes, -y             Skip confirmation for destructive operations

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
  lore data merge                          # scan & merge git duplicates
  lore data merge --yes                    # skip confirmation
  lore data recover                        # re-import from .lore.md / AGENTS.md
  lore data recover --yes                  # skip confirmation
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
