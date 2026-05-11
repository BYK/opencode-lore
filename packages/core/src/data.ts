/**
 * data.ts — Data listing, inspection, and deletion for Lore.
 *
 * Provides a unified API for both the CLI (`lore data`) and the web UI
 * (`/ui/`) to browse, search, and delete stored data across all tables.
 *
 * Cross-cutting concerns (e.g. `clearProject` touches knowledge, temporal,
 * distillations, and session_state in one transaction) live here instead of
 * being spread across ltm/temporal/distillation modules.
 */

import { statSync, unlinkSync, existsSync } from "fs";
import {
  db,
  ensureProject,
  projectId,
  close,
  dbPath,
  mergeProjectInternal,
  repoNameFromRemote,
} from "./db";
import { getGitRemote } from "./git";
import * as ltm from "./ltm";
import * as agentsFile from "./agents-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectSummary = {
  id: string;
  path: string;
  name: string | null;
  git_remote: string | null;
  created_at: number;
  knowledge_count: number;
  session_count: number;
  message_count: number;
  distillation_count: number;
};

export type SessionSummary = {
  session_id: string;
  message_count: number;
  first_message_at: number;
  last_message_at: number;
  distilled_count: number;
  undistilled_count: number;
  distillation_count: number;
};

export type DistillationSummary = {
  id: string;
  session_id: string;
  generation: number;
  token_count: number;
  r_compression: number | null;
  c_norm: number | null;
  archived: number;
  created_at: number;
};

export type DistillationDetail = DistillationSummary & {
  project_id: string;
  observations: string;
  source_ids: string;
};

export type ClearResult = {
  knowledge_deleted: number;
  temporal_deleted: number;
  distillations_deleted: number;
  sessions_cleared: number;
};

export type GlobalStats = {
  project_count: number;
  knowledge_count: number;
  session_count: number;
  message_count: number;
  distillation_count: number;
  db_size_bytes: number;
};

// ---------------------------------------------------------------------------
// Listing functions
// ---------------------------------------------------------------------------

/** List all projects with summary counts. */
export function listProjects(): ProjectSummary[] {
  return db()
    .query(
      `SELECT p.id, p.path, p.name, p.git_remote, p.created_at,
        (SELECT COUNT(*) FROM knowledge WHERE project_id = p.id AND confidence > 0.2) as knowledge_count,
        (SELECT COUNT(DISTINCT session_id) FROM temporal_messages WHERE project_id = p.id) as session_count,
        (SELECT COUNT(*) FROM temporal_messages WHERE project_id = p.id) as message_count,
        (SELECT COUNT(*) FROM distillations WHERE project_id = p.id) as distillation_count
       FROM projects p ORDER BY p.created_at DESC`,
    )
    .all() as ProjectSummary[];
}

/** List distinct sessions for a project, with message/distillation counts. */
export function listSessions(
  projectPath: string,
  limit = 50,
): SessionSummary[] {
  const pid = ensureProject(projectPath);
  return db()
    .query(
      `SELECT
        session_id,
        COUNT(*) as message_count,
        MIN(created_at) as first_message_at,
        MAX(created_at) as last_message_at,
        SUM(CASE WHEN distilled = 1 THEN 1 ELSE 0 END) as distilled_count,
        SUM(CASE WHEN distilled = 0 THEN 1 ELSE 0 END) as undistilled_count,
        (SELECT COUNT(*) FROM distillations d
         WHERE d.project_id = temporal_messages.project_id
         AND d.session_id = temporal_messages.session_id) as distillation_count
       FROM temporal_messages
       WHERE project_id = ?
       GROUP BY session_id
       ORDER BY MAX(created_at) DESC
       LIMIT ?`,
    )
    .all(pid, limit) as SessionSummary[];
}

/** List distillations for a project (optionally filtered by session). */
export function listDistillations(
  projectPath: string,
  opts?: { sessionId?: string; limit?: number },
): DistillationSummary[] {
  const pid = ensureProject(projectPath);
  const limit = opts?.limit ?? 50;

  if (opts?.sessionId) {
    return db()
      .query(
        `SELECT id, session_id, generation, token_count, r_compression, c_norm, archived, created_at
         FROM distillations
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(pid, opts.sessionId, limit) as DistillationSummary[];
  }

  return db()
    .query(
      `SELECT id, session_id, generation, token_count, r_compression, c_norm, archived, created_at
       FROM distillations
       WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(pid, limit) as DistillationSummary[];
}

/** Get a single distillation by ID (or resolved prefix). */
export function getDistillation(id: string): DistillationDetail | null {
  return db()
    .query(
      `SELECT id, project_id, session_id, observations, source_ids, generation,
              token_count, r_compression, c_norm, archived, created_at
       FROM distillations WHERE id = ?`,
    )
    .get(id) as DistillationDetail | null;
}

/**
 * Resolve a partial ID prefix to a full ID for a given table.
 * Returns null if 0 or 2+ matches (ambiguous prefix).
 */
export function resolveId(
  table: "knowledge" | "distillations",
  prefix: string,
): string | null {
  const results = db()
    .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT 2`)
    .all(prefix + "%") as Array<{ id: string }>;
  return results.length === 1 ? results[0].id : null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Global stats for the dashboard. */
export function globalStats(): GlobalStats {
  const row = db()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM projects) as project_count,
        (SELECT COUNT(*) FROM knowledge WHERE confidence > 0.2) as knowledge_count,
        (SELECT COUNT(DISTINCT session_id) FROM temporal_messages) as session_count,
        (SELECT COUNT(*) FROM temporal_messages) as message_count,
        (SELECT COUNT(*) FROM distillations) as distillation_count`,
    )
    .get() as Omit<GlobalStats, "db_size_bytes">;

  let db_size_bytes = 0;
  try {
    const p = dbPath();
    db_size_bytes = statSync(p).size;
    // Add WAL file size if present
    const walPath = p + "-wal";
    if (existsSync(walPath)) {
      db_size_bytes += statSync(walPath).size;
    }
  } catch {
    // File may not exist yet or stat fails
  }

  return { ...row, db_size_bytes };
}

// ---------------------------------------------------------------------------
// Deletion functions
// ---------------------------------------------------------------------------

/**
 * Count rows that will be affected, for confirmation prompts.
 */
export function countForProject(projectPath: string): {
  knowledge: number;
  messages: number;
  distillations: number;
  sessions: number;
} {
  const pid = projectId(projectPath);
  if (!pid)
    return { knowledge: 0, messages: 0, distillations: 0, sessions: 0 };

  const row = db()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM knowledge WHERE project_id = ? AND confidence > 0.2) as knowledge,
        (SELECT COUNT(*) FROM temporal_messages WHERE project_id = ?) as messages,
        (SELECT COUNT(*) FROM distillations WHERE project_id = ?) as distillations,
        (SELECT COUNT(DISTINCT session_id) FROM temporal_messages WHERE project_id = ?) as sessions`,
    )
    .get(pid, pid, pid, pid) as {
    knowledge: number;
    messages: number;
    distillations: number;
    sessions: number;
  };

  return row;
}

/**
 * Clear all data for a project.
 * Deletes: knowledge, temporal_messages, distillations, session_state.
 * Does NOT delete the project row itself (preserves path->id mapping).
 * Regenerates `.lore.md` if the project path exists on disk.
 */
export function clearProject(projectPath: string): ClearResult {
  const pid = ensureProject(projectPath);
  const database = db();

  // Count before deleting (result.changes is inflated by FTS triggers)
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
    temporal: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
    distillations: (
      database
        .query(
          "SELECT COUNT(*) as c FROM distillations WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
    sessions: (
      database
        .query(
          "SELECT COUNT(DISTINCT session_id) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
  };

  // Delete in dependency order
  database.exec("BEGIN IMMEDIATE");
  try {
    // Delete session_state BEFORE temporal_messages (subquery needs the rows)
    database
      .query(
        `DELETE FROM session_state WHERE session_id IN
         (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
      )
      .run(pid);
    database
      .query("DELETE FROM knowledge WHERE project_id = ?")
      .run(pid);
    database
      .query("DELETE FROM temporal_messages WHERE project_id = ?")
      .run(pid);
    database
      .query("DELETE FROM distillations WHERE project_id = ?")
      .run(pid);
    database
      .query("DELETE FROM lat_sections WHERE project_id = ?")
      .run(pid);
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }

  // Regenerate .lore.md (will be empty/minimal after clearing knowledge)
  if (existsSync(projectPath)) {
    try {
      agentsFile.exportLoreFile(projectPath);
    } catch {
      // Non-fatal: project dir may not be writable
    }
  }

  return {
    knowledge_deleted: counts.knowledge,
    temporal_deleted: counts.temporal,
    distillations_deleted: counts.distillations,
    sessions_cleared: counts.sessions,
  };
}

/**
 * Fully delete a project: all associated data AND the project row itself.
 * Also removes path aliases pointing to this project.
 *
 * Unlike clearProject(), this does NOT call ensureProject() (avoids
 * re-creating the project) and does NOT regenerate .lore.md.
 *
 * Returns deletion counts, or null if the project ID doesn't exist.
 */
export function deleteProject(projectId: string): ClearResult | null {
  const database = db();

  // Verify the project exists and collect all paths BEFORE deleting.
  // We need these to invalidate the .lore.md file cache (kv_meta) after
  // deletion — otherwise shouldImportLoreFile() sees the stale cache,
  // skips re-import, and the curator overwrites .lore.md with junk.
  const project = database
    .query("SELECT id, path FROM projects WHERE id = ?")
    .get(projectId) as { id: string; path: string } | null;
  if (!project) return null;

  const aliasPaths = database
    .query("SELECT path FROM project_path_aliases WHERE project_id = ?")
    .all(projectId) as { path: string }[];
  const allPaths = [project.path, ...aliasPaths.map((r) => r.path)];

  // Count before deleting
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
    temporal: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
    distillations: (
      database
        .query(
          "SELECT COUNT(*) as c FROM distillations WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
    sessions: (
      database
        .query(
          "SELECT COUNT(DISTINCT session_id) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
  };

  database.exec("BEGIN IMMEDIATE");
  try {
    // Delete session_state BEFORE temporal_messages (subquery needs the rows)
    database
      .query(
        `DELETE FROM session_state WHERE session_id IN
         (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
      )
      .run(projectId);
    database
      .query("DELETE FROM knowledge WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM temporal_messages WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM distillations WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM lat_sections WHERE project_id = ?")
      .run(projectId);
    // Explicit delete for safety (FK CASCADE depends on PRAGMA foreign_keys)
    database
      .query("DELETE FROM project_path_aliases WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM warmup_histograms WHERE project_id = ?")
      .run(projectId);
    // Finally, delete the project row itself
    database
      .query("DELETE FROM projects WHERE id = ?")
      .run(projectId);
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }

  // Invalidate the .lore.md file cache for all known paths so that
  // shouldImportLoreFile() re-checks the file if this project path
  // is reused. Without this, the stale cache causes the import to be
  // skipped, the curator creates junk entries, and exportLoreFile()
  // overwrites the good .lore.md with garbage.
  for (const p of allPaths) {
    agentsFile.clearLoreFileCache(p);
  }

  return {
    knowledge_deleted: counts.knowledge,
    temporal_deleted: counts.temporal,
    distillations_deleted: counts.distillations,
    sessions_cleared: counts.sessions,
  };
}

/** Rename a project. Returns true if the project exists and was renamed. */
export function renameProject(projectId: string, newName: string): boolean {
  const result = db()
    .query("UPDATE projects SET name = ? WHERE id = ?")
    .run(newName.trim(), projectId);
  return result.changes > 0;
}

/** Clear only knowledge entries for a project. Regenerates .lore.md. */
export function clearKnowledge(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query(
        "SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?",
      )
      .get(pid) as { c: number }
  ).c;

  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);

  // Regenerate .lore.md
  if (existsSync(projectPath)) {
    try {
      agentsFile.exportLoreFile(projectPath);
    } catch {
      // Non-fatal
    }
  }

  return count;
}

/** Clear only temporal messages for a project. */
export function clearTemporal(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query(
        "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
      )
      .get(pid) as { c: number }
  ).c;

  db()
    .query("DELETE FROM temporal_messages WHERE project_id = ?")
    .run(pid);

  return count;
}

/** Clear only distillations for a project. */
export function clearDistillations(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query(
        "SELECT COUNT(*) as c FROM distillations WHERE project_id = ?",
      )
      .get(pid) as { c: number }
  ).c;

  db()
    .query("DELETE FROM distillations WHERE project_id = ?")
    .run(pid);

  return count;
}

/** Delete a single knowledge entry. Returns true if found and deleted. */
export function deleteKnowledge(id: string): boolean {
  const entry = ltm.get(id);
  if (!entry) return false;
  ltm.remove(id);
  return true;
}

/** Delete a single distillation. Returns true if found and deleted. */
export function deleteDistillation(id: string): boolean {
  const existing = getDistillation(id);
  if (!existing) return false;
  db().query("DELETE FROM distillations WHERE id = ?").run(id);
  return true;
}

/**
 * Delete all data for a specific session (messages + distillations + session_state).
 */
export function deleteSession(
  projectPath: string,
  sessionId: string,
): { messages_deleted: number; distillations_deleted: number } {
  const pid = ensureProject(projectPath);
  const database = db();

  const msgCount = (
    database
      .query(
        "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, sessionId) as { c: number }
  ).c;

  const distCount = (
    database
      .query(
        "SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, sessionId) as { c: number }
  ).c;

  database
    .query(
      "DELETE FROM temporal_messages WHERE project_id = ? AND session_id = ?",
    )
    .run(pid, sessionId);
  database
    .query(
      "DELETE FROM distillations WHERE project_id = ? AND session_id = ?",
    )
    .run(pid, sessionId);
  database
    .query("DELETE FROM session_state WHERE session_id = ?")
    .run(sessionId);

  return { messages_deleted: msgCount, distillations_deleted: distCount };
}

/**
 * Nuclear option: close the DB, delete the file, re-initialize.
 * Returns the path of the deleted DB file.
 */
export function wipeDatabase(): string {
  const p = dbPath();
  close();

  // Delete DB and associated WAL/SHM files
  for (const suffix of ["", "-wal", "-shm"]) {
    const fp = p + suffix;
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {
        // Best-effort
      }
    }
  }

  // Re-initialize with fresh schema
  db();
  return p;
}

// ---------------------------------------------------------------------------
// Project merging & git remote backfill
// ---------------------------------------------------------------------------

export type MergeResult = {
  knowledge_moved: number;
  messages_moved: number;
  distillations_moved: number;
};

/**
 * Merge a source project into a target project.
 *
 * Moves all data (knowledge, messages, distillations, LAT sections, path
 * aliases) from source to target, then deletes the source project row.
 * The source project's path is registered as an alias of the target.
 *
 * Returns counts of moved rows for reporting.
 */
export function mergeProjects(sourceId: string, targetId: string): MergeResult {
  const database = db();

  // Count before merging (result.changes is inflated by FTS triggers)
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c,
    messages: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c,
    distillations: (
      database
        .query(
          "SELECT COUNT(*) as c FROM distillations WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c,
  };

  mergeProjectInternal(sourceId, targetId);

  return {
    knowledge_moved: counts.knowledge,
    messages_moved: counts.messages,
    distillations_moved: counts.distillations,
  };
}

/**
 * Backfill git_remote for existing projects, merge duplicates, and
 * update project names from git remote repo names where still using
 * the directory-basename default.
 *
 * Iterates all projects that lack a git_remote value, runs `git remote -v`
 * on their stored path, and:
 *  - If no other project shares that remote: sets git_remote on the row.
 *  - If another project already has that remote: merges this project into
 *    the existing one (consolidating fragmented data).
 *
 * Also backfills project names: if a project's name matches the directory
 * basename (the old default) or is null, and a git remote is available,
 * the name is updated to the repo name from the remote URL.
 *
 * Skips projects whose path no longer exists on disk or is not a git repo.
 *
 * Returns counts for reporting.
 */
export function backfillGitRemotes(): {
  updated: number;
  merged: number;
  namesBackfilled: number;
  mergeDetails: Array<{
    sourcePath: string;
    targetPath: string;
    gitRemote: string;
    result: MergeResult;
  }>;
} {
  const projects = db()
    .query(
      "SELECT id, path, name, git_remote FROM projects ORDER BY created_at ASC",
    )
    .all() as Array<{
    id: string;
    path: string;
    name: string | null;
    git_remote: string | null;
  }>;

  let updated = 0;
  let merged = 0;
  let namesBackfilled = 0;
  const mergeDetails: Array<{
    sourcePath: string;
    targetPath: string;
    gitRemote: string;
    result: MergeResult;
  }> = [];

  for (const project of projects) {
    let gitRemote = project.git_remote;

    if (!gitRemote) {
      // Skip if path doesn't exist
      if (!existsSync(project.path)) continue;

      // Try to get git remote
      gitRemote = getGitRemote(project.path);
      if (!gitRemote) continue;

      // Check if another project already has this git_remote
      const existing = db()
        .query(
          "SELECT id, path FROM projects WHERE git_remote = ? AND id != ? LIMIT 1",
        )
        .get(gitRemote, project.id) as {
        id: string;
        path: string;
      } | null;

      if (existing) {
        // Merge this project into the existing one
        const result = mergeProjects(project.id, existing.id);
        mergeDetails.push({
          sourcePath: project.path,
          targetPath: existing.path,
          gitRemote,
          result,
        });
        merged++;
        continue; // project was merged away, skip name backfill
      }

      // Set the git_remote
      db()
        .query("UPDATE projects SET git_remote = ? WHERE id = ?")
        .run(gitRemote, project.id);
      updated++;
    }

    // Backfill name from git remote if still using directory basename default
    const dirBasename = project.path.split("/").pop();
    if (project.name === dirBasename || !project.name) {
      const repoName = repoNameFromRemote(gitRemote);
      if (repoName && repoName !== project.name) {
        db()
          .query("UPDATE projects SET name = ? WHERE id = ?")
          .run(repoName, project.id);
        namesBackfilled++;
      }
    }
  }

  return { updated, merged, namesBackfilled, mergeDetails };
}
