/**
 * Import history — tracks which external agent sessions have been imported
 * to prevent re-importing unchanged sources.
 */
import { db, ensureProject } from "../db";

export type ImportRecord = {
  id: string;
  project_id: string;
  agent_name: string;
  source_id: string;
  source_hash: string;
  entries_created: number;
  entries_updated: number;
  imported_at: number;
};

/**
 * Check if a specific source has already been imported with the same hash.
 *
 * @returns The existing record if found with the same hash, or null if
 *          the source hasn't been imported or the hash has changed.
 */
export function isImported(
  projectPath: string,
  agentName: string,
  sourceId: string,
  sourceHash: string,
): ImportRecord | null {
  const projectId = ensureProject(projectPath);
  const row = db()
    .query(
      `SELECT * FROM import_history
       WHERE project_id = ? AND agent_name = ? AND source_id = ?`,
    )
    .get(projectId, agentName, sourceId) as ImportRecord | null;

  if (!row) return null;
  // Hash changed — source has new content since last import
  if (row.source_hash !== sourceHash) return null;
  return row;
}

/**
 * Record a successful import of a source.
 * Uses INSERT OR REPLACE to handle re-imports of changed sources.
 */
export function recordImport(
  projectPath: string,
  agentName: string,
  sourceId: string,
  sourceHash: string,
  stats: { created: number; updated: number },
): void {
  const projectId = ensureProject(projectPath);
  db()
    .query(
      `INSERT OR REPLACE INTO import_history
       (id, project_id, agent_name, source_id, source_hash, entries_created, entries_updated, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      projectId,
      agentName,
      sourceId,
      sourceHash,
      stats.created,
      stats.updated,
      Date.now(),
    );
}

/**
 * Get all import records for a project.
 * Excludes legacy "__declined__" sentinel rows from pre-v22 databases.
 */
export function listImports(projectPath: string): ImportRecord[] {
  const projectId = ensureProject(projectPath);
  return db()
    .query(
      `SELECT * FROM import_history
       WHERE project_id = ? AND source_id != '__declined__'
       ORDER BY imported_at DESC`,
    )
    .all(projectId) as ImportRecord[];
}

/**
 * Compute a simple hash string for idempotency checks.
 * Uses a fast non-cryptographic approach: file size + message count + last timestamp.
 */
export function computeHash(parts: {
  size?: number;
  messageCount?: number;
  lastTimestamp?: number;
}): string {
  return `${parts.size ?? 0}:${parts.messageCount ?? 0}:${parts.lastTimestamp ?? 0}`;
}
