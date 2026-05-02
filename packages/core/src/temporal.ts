import { db, ensureProject } from "./db";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY } from "./search";
import { sanitizeSurrogates } from "./markdown";
import type { LoreMessage, LorePart } from "./types";
import { isTextPart, isReasoningPart, isToolPart } from "./types";

// ~3 chars per token — validated as best heuristic against real API data.
function estimate(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Chunk-boundary terminator inserted between chunks by `partsToText`.
 *
 * `\x1f` is ASCII Unit Separator — a non-word control char that:
 *   - cannot legitimately appear in normal chat or tool content (control
 *     chars are vanishingly rare even in binary file dumps),
 *   - is treated as a token separator by FTS5's `unicode61` tokenizer, so
 *     it has zero effect on BM25 indexing or scoring,
 *   - survives `sanitizeSurrogates()` (which only touches lone UTF-16
 *     surrogates, never ASCII control chars).
 *
 * Placed AFTER the existing `\n` so display tools that split on `\n`
 * still render correctly; the structural parser (in `distillation.ts`)
 * splits on `"\n" + CHUNK_TERMINATOR` for unambiguous chunk recovery.
 *
 * Adopted in F3b. Pre-F3b rows are rewritten in-place by a SQL migration
 * (see `db.ts`); after that migration runs, every `temporal_messages.content`
 * value uses this format consistently.
 */
export const CHUNK_TERMINATOR = "\x1f";

/**
 * Serialize a list of message parts into a single content string for the
 * `temporal_messages.content` column. Chunks are separated by
 * `"\n" + CHUNK_TERMINATOR` so the structural parser can recover chunk
 * boundaries unambiguously regardless of payload contents (including
 * payloads that contain literal `[tool:...]` substrings — e.g. when the
 * agent reads a file that documents this very format).
 *
 * Exported so tests can pin producer/consumer round-trip behavior.
 */
export function partsToText(parts: LorePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (isTextPart(part)) chunks.push(part.text);
    else if (isReasoningPart(part) && part.text)
      chunks.push(`[reasoning] ${part.text}`);
    else if (isToolPart(part) && part.state.status === "completed")
      chunks.push(`[tool:${part.tool}] ${part.state.output}`);
  }
  // Sanitize unpaired surrogates from tool outputs and other raw text.
  // Without this, surrogates survive into the DB and later break JSON
  // serialization when included in recall tool responses.
  return sanitizeSurrogates(chunks.join("\n" + CHUNK_TERMINATOR));
}

function messageMetadata(info: LoreMessage, parts: LorePart[]): string {
  const meta: Record<string, unknown> = {};
  if (info.role === "user") {
    meta.agent = info.agent;
    meta.model = info.model;
  } else {
    meta.modelID = info.modelID;
    meta.providerID = info.providerID;
    meta.mode = info.mode;
  }
  const tools = parts.filter(isToolPart).map((p) => p.tool);
  if (tools.length) meta.tools = tools;
  return JSON.stringify(meta);
}

export function store(input: {
  projectPath: string;
  info: LoreMessage;
  parts: LorePart[];
}) {
  const pid = ensureProject(input.projectPath);
  const content = partsToText(input.parts);
  if (!content.trim()) return;

  const existing = db()
    .query("SELECT id FROM temporal_messages WHERE id = ?")
    .get(input.info.id);
  if (existing) {
    db()
      .query(
        "UPDATE temporal_messages SET content = ?, tokens = ?, metadata = ? WHERE id = ?",
      )
      .run(
        content,
        estimate(content),
        messageMetadata(input.info, input.parts),
        input.info.id,
      );
    return;
  }

  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.info.id,
      pid,
      input.info.sessionID,
      input.info.role,
      content,
      estimate(content),
      input.info.time.created,
      messageMetadata(input.info, input.parts),
    );
}

export type TemporalMessage = {
  id: string;
  project_id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  distilled: number;
  created_at: number;
  metadata: string;
};

export function undistilled(
  projectPath: string,
  sessionID?: string,
): TemporalMessage[] {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT * FROM temporal_messages WHERE project_id = ? AND session_id = ? AND distilled = 0 ORDER BY created_at ASC"
    : "SELECT * FROM temporal_messages WHERE project_id = ? AND distilled = 0 ORDER BY created_at ASC";
  const params = sessionID ? [pid, sessionID] : [pid];
  return db()
    .query(query)
    .all(...params) as TemporalMessage[];
}

export function bySession(
  projectPath: string,
  sessionID: string,
): TemporalMessage[] {
  const pid = ensureProject(projectPath);
  return db()
    .query(
      "SELECT * FROM temporal_messages WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC",
    )
    .all(pid, sessionID) as TemporalMessage[];
}

export function markDistilled(ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db()
    .query(
      `UPDATE temporal_messages SET distilled = 1 WHERE id IN (${placeholders})`,
    )
    .run(...ids);
}

// LIKE-based fallback for when FTS5 fails unexpectedly.
function searchLike(input: {
  pid: string;
  query: string;
  sessionID?: string;
  limit: number;
}): TemporalMessage[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  const conditions = terms.map(() => "LOWER(content) LIKE ?").join(" AND ");
  const likeParams = terms.map((t) => `%${t}%`);
  const query = input.sessionID
    ? `SELECT * FROM temporal_messages WHERE project_id = ? AND session_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM temporal_messages WHERE project_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`;
  const params = input.sessionID
    ? [input.pid, input.sessionID, ...likeParams, input.limit]
    : [input.pid, ...likeParams, input.limit];
  return db()
    .query(query)
    .all(...params) as TemporalMessage[];
}

export function search(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
}): TemporalMessage[] {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 20;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const ftsSQL = input.sessionID
    ? `SELECT m.* FROM temporal_fts f
       CROSS JOIN temporal_messages m ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ? AND m.session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT m.* FROM temporal_fts f
       CROSS JOIN temporal_messages m ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ?
       ORDER BY rank LIMIT ?`;
  const params = input.sessionID
    ? [q, pid, input.sessionID, limit]
    : [q, pid, limit];
  try {
    const results = db()
      .query(ftsSQL)
      .all(...params) as TemporalMessage[];
    if (results.length) return results;

    // AND returned nothing — try OR fallback for broader recall
    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    const paramsOr = input.sessionID
      ? [qOr, pid, input.sessionID, limit]
      : [qOr, pid, limit];
    return db()
      .query(ftsSQL)
      .all(...paramsOr) as TemporalMessage[];
  } catch {
    // FTS5 still choked (edge case) — fall back to LIKE search
    return searchLike({
      pid,
      query: input.query,
      sessionID: input.sessionID,
      limit,
    });
  }
}

export type ScoredTemporalMessage = TemporalMessage & { rank: number };

/**
 * Search with BM25 scores included. Returns results with raw FTS5 rank values
 * for use in cross-source score fusion (RRF).
 */
export function searchScored(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
}): ScoredTemporalMessage[] {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 20;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const ftsSQL = input.sessionID
    ? `SELECT m.*, rank FROM temporal_fts f
       CROSS JOIN temporal_messages m ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ? AND m.session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT m.*, rank FROM temporal_fts f
       CROSS JOIN temporal_messages m ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ?
       ORDER BY rank LIMIT ?`;
  const params = input.sessionID
    ? [q, pid, input.sessionID, limit]
    : [q, pid, limit];

  try {
    const results = db().query(ftsSQL).all(...params) as ScoredTemporalMessage[];
    if (results.length) return results;

    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    const paramsOr = input.sessionID
      ? [qOr, pid, input.sessionID, limit]
      : [qOr, pid, limit];
    return db().query(ftsSQL).all(...paramsOr) as ScoredTemporalMessage[];
  } catch {
    return [];
  }
}

/**
 * Normalized variance of relative-existence weights over message timestamps.
 *
 * Measures temporal attention imbalance: 0 means timestamps are evenly
 * distributed (uniform attention), 1 means a single distant timestamp
 * dominates (attention stuck in the past). Useful as a lightweight
 * signal for distillation segmentation, recall time-biasing, and
 * idle-resume awareness.
 *
 * Only meaningful for n ≥ 2. Returns 0 for 0 or 1 timestamps.
 *
 * Based on the "Temporal Clustering via Relative Existence" heuristic
 * from D7x7z49/llm-context-idea.
 */
export function temporalCnorm(
  timestamps: number[],
  now: number = Date.now(),
): number {
  const n = timestamps.length;
  if (n < 2) return 0;

  // Existence durations: how long each piece has existed
  const durations = timestamps.map((t) => now - t);
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  if (totalDuration <= 0) return 0;

  // Relative existence weights (positive, sum to 1)
  const weights = durations.map((d) => d / totalDuration);

  // Normalized variance: Var(w) / Var_max
  // Var(w) = (1/n) * Σ(w_i - 1/n)²
  // Var_max = (n-1) / n²  (when one weight = 1, rest = 0)
  const uniform = 1 / n;
  const variance =
    weights.reduce((sum, w) => sum + (w - uniform) ** 2, 0) / n;
  const maxVariance = (n - 1) / (n * n);
  return maxVariance === 0 ? 0 : variance / maxVariance;
}

export function count(projectPath: string, sessionID?: string): number {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT COUNT(*) as count FROM temporal_messages WHERE project_id = ? AND session_id = ?"
    : "SELECT COUNT(*) as count FROM temporal_messages WHERE project_id = ?";
  const params = sessionID ? [pid, sessionID] : [pid];
  return (
    db()
      .query(query)
      .get(...params) as { count: number }
  ).count;
}

export function undistilledCount(
  projectPath: string,
  sessionID?: string,
): number {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT COUNT(*) as count FROM temporal_messages WHERE project_id = ? AND session_id = ? AND distilled = 0"
    : "SELECT COUNT(*) as count FROM temporal_messages WHERE project_id = ? AND distilled = 0";
  const params = sessionID ? [pid, sessionID] : [pid];
  return (
    db()
      .query(query)
      .get(...params) as { count: number }
  ).count;
}

export type PruneResult = {
  /** Rows deleted by the TTL pass (distilled=1 AND older than retention period). */
  ttlDeleted: number;
  /** Rows deleted by the size-cap pass (distilled=1, oldest-first, to get under maxStorage). */
  capDeleted: number;
};

/**
 * Prune temporal messages for a project using a two-pass Hybrid C strategy:
 *
 * Pass 1 — TTL: delete messages where distilled=1 AND created_at is older than
 * retentionDays. This covers normal operation — both distillation and curation
 * have had ample time to process anything that old.
 *
 * Pass 2 — Size cap: if total temporal storage for the project still exceeds
 * maxStorageMB, delete the oldest distilled=1 messages (regardless of age)
 * until under the cap.
 *
 * Invariant: undistilled messages (distilled=0) are NEVER deleted by either pass.
 */
export function prune(input: {
  projectPath: string;
  retentionDays: number;
  maxStorageMB: number;
}): PruneResult {
  const database = db();
  const pid = ensureProject(input.projectPath);
  const cutoff = Date.now() - input.retentionDays * 24 * 60 * 60 * 1000;

  // Pass 1: TTL — delete distilled messages older than the retention window.
  // Note: result.changes is inflated by FTS trigger side-effects, so we count
  // eligible rows before deletion to get the accurate number deleted.
  const ttlEligible = (
    database
      .query(
        "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ? AND distilled = 1 AND created_at < ?",
      )
      .get(pid, cutoff) as { c: number }
  ).c;
  if (ttlEligible > 0) {
    database
      .query(
        "DELETE FROM temporal_messages WHERE project_id = ? AND distilled = 1 AND created_at < ?",
      )
      .run(pid, cutoff);
  }
  const ttlDeleted = ttlEligible;

  // Pass 2: Size cap — check if total storage for this project exceeds the
  // limit and if so, evict the oldest distilled messages until under the cap.
  const maxBytes = input.maxStorageMB * 1024 * 1024;
  const totalBytes = (
    database
      .query("SELECT SUM(LENGTH(content)) as b FROM temporal_messages WHERE project_id = ?")
      .get(pid) as { b: number | null }
  ).b ?? 0;

  let capDeleted = 0;
  if (totalBytes > maxBytes) {
    // Collect oldest distilled messages until we've accounted for enough bytes
    // to drop below the cap. Delete them in a single batch.
    const candidates = database
      .query(
        "SELECT id, LENGTH(content) as size FROM temporal_messages WHERE project_id = ? AND distilled = 1 ORDER BY created_at ASC",
      )
      .all(pid) as { id: string; size: number }[];

    const toDelete: string[] = [];
    let freed = 0;
    const excess = totalBytes - maxBytes;
    for (const row of candidates) {
      if (freed >= excess) break;
      toDelete.push(row.id);
      freed += row.size;
    }

    if (toDelete.length) {
      const placeholders = toDelete.map(() => "?").join(",");
      database
        .query(
          `DELETE FROM temporal_messages WHERE id IN (${placeholders})`,
        )
        .run(...toDelete);
      // toDelete.length is the accurate count — result.changes is inflated by FTS triggers.
      capDeleted = toDelete.length;
    }
  }

  // Pass 3: Prune archived distillations older than the retention window.
  // Archived gen-0 distillations are kept for recall search but don't need
  // to live forever — they follow the same retention policy as temporal messages.
  database
    .query(
      "DELETE FROM distillations WHERE project_id = ? AND archived = 1 AND created_at < ?",
    )
    .run(pid, cutoff);

  return { ttlDeleted, capDeleted };
}
