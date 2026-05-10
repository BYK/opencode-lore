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
import { db, ensureProject, projectId, close, dbPath } from "./db";
import * as ltm from "./ltm";
import * as agentsFile from "./agents-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectSummary = {
  id: string;
  path: string;
  name: string | null;
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
      `SELECT p.id, p.path, p.name, p.created_at,
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
      .query(
        `DELETE FROM session_state WHERE session_id IN
         (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
      )
      .run(pid);
    // Also clean lat_sections
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
