import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "./db";
import { config } from "./config";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY, extractTopTerms } from "./search";
import * as embedding from "./embedding";
import * as latReader from "./lat-reader";
import * as log from "./log";

// ~3 chars per token — validated as best heuristic against real API data.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export type KnowledgeEntry = {
  id: string;
  project_id: string | null;
  category: string;
  title: string;
  content: string;
  source_session: string | null;
  cross_project: number;
  confidence: number;
  created_at: number;
  updated_at: number;
  metadata: string | null;
};

/** Columns to select for KnowledgeEntry — excludes the embedding BLOB
 *  (4KB per entry) which is only needed by vectorSearch() in embedding.ts. */
const KNOWLEDGE_COLS =
  "id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at, metadata";

/** Same columns with table alias prefix for use in JOIN queries. */
const KNOWLEDGE_COLS_K =
  "k.id, k.project_id, k.category, k.title, k.content, k.source_session, k.cross_project, k.confidence, k.created_at, k.updated_at, k.metadata";

export function create(input: {
  projectPath?: string;
  category: string;
  title: string;
  content: string;
  session?: string;
  scope: "project" | "global";
  crossProject?: boolean;
  /** Explicit ID to use — for cross-machine import via agents-file. Defaults to a new UUIDv7. */
  id?: string;
}): string {
  const pid =
    input.scope === "project" && input.projectPath
      ? ensureProject(input.projectPath)
      : null;

  // Dedup guard: if an entry with the same project_id + title already exists,
  // update its content instead of inserting a duplicate. This prevents the
  // curator from creating multiple entries for the same concept across sessions.
  // Also checks cross-project entries to prevent the curator from creating
  // project-scoped duplicates of globally-shared knowledge.
  // Note: when an explicit id is provided (cross-machine import), skip dedup —
  // the caller (importFromFile) already handles duplicate detection by UUID.
  if (!input.id) {
    // First check same project_id
    const existing = (
      pid !== null
        ? db()
            .query(
              "SELECT id FROM knowledge WHERE project_id = ? AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(pid, input.title)
        : db()
            .query(
              "SELECT id FROM knowledge WHERE project_id IS NULL AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(input.title)
    ) as { id: string } | null;

    if (existing) {
      update(existing.id, { content: input.content });
      return existing.id;
    }

    // Also check cross-project entries — prevents creating project-scoped
    // duplicates of entries that already exist as cross-project knowledge.
    const crossExisting = db()
      .query(
        "SELECT id FROM knowledge WHERE cross_project = 1 AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
      )
      .get(input.title) as { id: string } | null;

    if (crossExisting) {
      update(crossExisting.id, { content: input.content });
      return crossExisting.id;
    }
  }

  const id = input.id ?? uuidv7();
  const now = Date.now();
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)`,
    )
    .run(
      id,
      pid,
      input.category,
      input.title,
      input.content,
      input.session ?? null,
      (input.crossProject ?? false) ? 1 : 0,
      now,
      now,
    );

  // Fire-and-forget: embed for vector search (errors logged, never thrown)
  if (embedding.isAvailable()) {
    embedding.embedKnowledgeEntry(id, input.title, input.content);
  }

  return id;
}

export function update(
  id: string,
  input: { content?: string; confidence?: number },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.content !== undefined) {
    sets.push("content = ?");
    params.push(input.content);
  }
  if (input.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(input.confidence);
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);
  db()
    .query(`UPDATE knowledge SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(params as [string, ...string[]]));

  // Re-embed when content changes (fire-and-forget)
  if (embedding.isAvailable() && input.content !== undefined) {
    const entry = get(id);
    if (entry) {
      embedding.embedKnowledgeEntry(id, entry.title, input.content);
    }
  }
}

export function remove(id: string) {
  db().query("DELETE FROM knowledge WHERE id = ?").run(id);
}

export function forProject(
  projectPath: string,
  includeCross = true,
): KnowledgeEntry[] {
  const pid = ensureProject(projectPath);
  if (includeCross) {
    return db()
      .query(
        `SELECT ${KNOWLEDGE_COLS} FROM knowledge
         WHERE (project_id = ? OR (project_id IS NULL) OR (cross_project = 1))
         AND confidence > 0.2
         ORDER BY confidence DESC, updated_at DESC`,
      )
      .all(pid) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE project_id = ?
       AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid) as KnowledgeEntry[];
}

type Scored = { entry: KnowledgeEntry; score: number };

/** BM25 column weights for knowledge_fts: title, content, category.
 *  Reads from config().search.ftsWeights, falling back to defaults. */
function ftsWeights() {
  return config().search.ftsWeights;
}

/** Max entries per pool to include on first turn when no session context exists. */
const NO_CONTEXT_FALLBACK_CAP = 10;

/** Number of top-confidence project entries always included as a safety net,
 *  even when they don't match any session context terms. This guards against
 *  the coarse term-overlap scoring accidentally excluding important project
 *  knowledge. */
const PROJECT_SAFETY_NET = 5;

/**
 * Score entries by FTS5 BM25 relevance to session context.
 *
 * Uses OR semantics (not AND-then-OR) because we're scoring ALL candidates
 * for relevance ranking, not searching for exact matches. An entry that
 * matches 1 of 40 terms should still get a (low) score, not be excluded.
 * BM25 naturally weights entries matching more terms higher.
 *
 * Returns a Map of entry ID → normalized score (0–1).
 */
function scoreEntriesFTS(sessionContext: string): Map<string, number> {
  const terms = extractTopTerms(sessionContext);
  if (!terms.length) return new Map();

  const q = terms.map((t) => `${t}*`).join(" OR ");
  const { title, content, category } = ftsWeights();

  try {
    const results = db()
      .query(
        `SELECT k.id, bm25(knowledge_fts, ?, ?, ?) as rank
         FROM knowledge k
         JOIN knowledge_fts f ON k.rowid = f.rowid
         WHERE knowledge_fts MATCH ?
         AND k.confidence > 0.2`,
      )
      .all(title, content, category, q) as Array<{
      id: string;
      rank: number;
    }>;

    if (!results.length) return new Map();

    // Normalize: BM25 rank is negative (more negative = better).
    // Convert to 0–1 where 1 = best match.
    const ranks = results.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const scoreMap = new Map<string, number>();
    for (const r of results) {
      const norm =
        minRank === maxRank ? 1 : (maxRank - r.rank) / (maxRank - minRank);
      scoreMap.set(r.id, norm);
    }
    return scoreMap;
  } catch {
    return new Map();
  }
}

/**
 * Build a relevance-ranked, budget-capped list of knowledge entries for injection
 * into the system prompt of a live session.
 *
 * Strategy:
 * 1. Both project-specific and cross-project entries are scored for relevance
 *    against recent session context (last distillation + recent raw messages).
 * 2. Project entries get a safety net: the top PROJECT_SAFETY_NET entries by
 *    confidence are always included even if they have zero relevance score.
 *    This ensures the most important project knowledge is never lost to
 *    coarse term-overlap scoring.
 * 3. All scored entries are merged into a single pool and greedily packed
 *    into the token budget by score descending.
 * 4. If there's no session context yet (first turn), fall back to top entries
 *    by confidence only (capped at NO_CONTEXT_FALLBACK_CAP per pool).
 *
 * @param projectPath   Current project path
 * @param sessionID     Current session ID (for context extraction)
 * @param maxTokens     Hard token budget for the entire formatted block
 */
export function forSession(
  projectPath: string,
  sessionID: string | undefined,
  maxTokens: number,
): KnowledgeEntry[] {
  const pid = ensureProject(projectPath);

  // --- 1. Load project-specific entries ---
  const projectEntries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE project_id = ? AND cross_project = 0 AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid) as KnowledgeEntry[];

  // --- 2. Load cross-project candidates ---
  const crossEntries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE (project_id IS NULL OR cross_project = 1) AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all() as KnowledgeEntry[];

  if (!crossEntries.length && !projectEntries.length) return [];

  // --- 3. Build session context for relevance scoring ---
  let sessionContext = "";
  if (sessionID) {
    const distRow = db()
      .query(
        `SELECT observations FROM distillations
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(pid, sessionID) as { observations: string } | null;
    if (distRow?.observations) {
      sessionContext += distRow.observations + "\n";
    }
    const recentMsgs = db()
      .query(
        `SELECT content FROM temporal_messages
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all(pid, sessionID) as Array<{ content: string }>;
    if (recentMsgs.length) {
      sessionContext += recentMsgs.map((m) => m.content).join("\n");
    }
  }

  // --- 4. Score both pools by relevance ---
  let scoredProject: Scored[];
  let scoredCross: Scored[];

  if (sessionContext.trim().length > 20) {
    // Use FTS5 BM25 to score all knowledge entries against session context
    const ftsScores = scoreEntriesFTS(sessionContext);

    // Score project entries: FTS relevance × confidence, with safety net
    const rawScored: Scored[] = projectEntries.map((entry) => ({
      entry,
      score: (ftsScores.get(entry.id) ?? 0) * entry.confidence,
    }));
    const matched = rawScored.filter((s) => s.score > 0);
    const matchedIds = new Set(matched.map((s) => s.entry.id));

    // Safety net: top PROJECT_SAFETY_NET entries by confidence that weren't already matched.
    // Given a tiny score (0.001 * confidence) so they sort below genuinely matched entries.
    const safetyNet = projectEntries
      .filter((e) => !matchedIds.has(e.id))
      .slice(0, PROJECT_SAFETY_NET)
      .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

    scoredProject = [...matched, ...safetyNet];

    // Score cross-project entries — only include entries with FTS match
    scoredCross = crossEntries
      .filter((e) => ftsScores.has(e.id))
      .map((e) => ({
        entry: e,
        score: (ftsScores.get(e.id) ?? 0) * e.confidence,
      }));
  } else {
    // No session context — fall back to top entries by confidence, capped
    scoredProject = projectEntries
      .slice(0, NO_CONTEXT_FALLBACK_CAP)
      .map((entry) => ({ entry, score: entry.confidence }));
    scoredCross = crossEntries
      .slice(0, NO_CONTEXT_FALLBACK_CAP)
      .map((entry) => ({ entry, score: entry.confidence }));
  }

  // --- 5. Merge and pack into token budget by score descending ---
  const allScored = [...scoredProject, ...scoredCross];
  allScored.sort((a, b) => b.score - a.score);

  const HEADER_OVERHEAD_TOKENS = 15;
  let used = HEADER_OVERHEAD_TOKENS;
  const result: KnowledgeEntry[] = [];

  for (const { entry } of allScored) {
    if (used >= maxTokens) break;
    const cost = estimateTokens(entry.title + entry.content) + 10;
    if (used + cost > maxTokens) continue;
    result.push(entry);
    used += cost;
  }

  // --- 6. Pack lat.md sections into remaining budget ---
  // lat.md sections compete for the remaining token budget (shared LTM pool).
  // They are scored separately by BM25 relevance against the same session context.
  if (latReader.hasLatDir(projectPath) && used < maxTokens) {
    const latSections = latReader.scoreForSession(
      projectPath,
      sessionContext,
      maxTokens - used,
    );
    for (const section of latSections) {
      if (used >= maxTokens) break;
      const display = section.first_paragraph ?? section.content;
      const cost = estimateTokens(section.heading + display) + 10;
      if (used + cost > maxTokens) continue;
      // Convert lat section to a synthetic KnowledgeEntry for formatKnowledge()
      result.push({
        id: section.id,
        project_id: section.project_id,
        category: "lat.md",
        title: `[${section.file}] ${section.heading}`,
        content: display,
        source_session: null,
        cross_project: 0,
        confidence: 1.0,
        created_at: section.updated_at,
        updated_at: section.updated_at,
        metadata: null,
      });
      used += cost;
    }
  }

  return result;
}

export function all(): KnowledgeEntry[] {
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge WHERE confidence > 0.2 ORDER BY confidence DESC, updated_at DESC`,
    )
    .all() as KnowledgeEntry[];
}

// LIKE-based fallback for when FTS5 fails unexpectedly.
function searchLike(input: {
  query: string;
  projectPath?: string;
  limit: number;
}): KnowledgeEntry[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  const conditions = terms
    .map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)")
    .join(" AND ");
  const likeParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  if (input.projectPath) {
    const pid = ensureProject(input.projectPath);
    return db()
      .query(
        `SELECT ${KNOWLEDGE_COLS} FROM knowledge WHERE (project_id = ? OR project_id IS NULL OR cross_project = 1) AND confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pid, ...likeParams, input.limit) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge WHERE confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...likeParams, input.limit) as KnowledgeEntry[];
}

export function search(input: {
  query: string;
  projectPath?: string;
  limit?: number;
}): KnowledgeEntry[] {
  const limit = input.limit ?? 20;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge k
       JOIN knowledge_fts f ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND k.confidence > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge k
       JOIN knowledge_fts f ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND k.confidence > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`;

  const { title, content, category } = ftsWeights();
  const ftsParams = pid
    ? [q, pid, title, content, category, limit]
    : [q, title, content, category, limit];

  try {
    const results = db().query(ftsSQL).all(...ftsParams) as KnowledgeEntry[];
    if (results.length) return results;

    // AND returned nothing — try OR fallback for broader recall
    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];

    const ftsParamsOr = pid
      ? [qOr, pid, title, content, category, limit]
      : [qOr, title, content, category, limit];
    return db().query(ftsSQL).all(...ftsParamsOr) as KnowledgeEntry[];
  } catch {
    return searchLike({
      query: input.query,
      projectPath: input.projectPath,
      limit,
    });
  }
}

export type ScoredKnowledgeEntry = KnowledgeEntry & { rank: number };

/**
 * Search with BM25 scores included. Returns results with raw FTS5 rank values
 * for use in cross-source score fusion (RRF).
 */
export function searchScored(input: {
  query: string;
  projectPath?: string;
  limit?: number;
}): ScoredKnowledgeEntry[] {
  const limit = input.limit ?? 20;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;
  const { title, content, category } = ftsWeights();

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge k
       JOIN knowledge_fts f ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND k.confidence > 0.2
       ORDER BY rank LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge k
       JOIN knowledge_fts f ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND k.confidence > 0.2
       ORDER BY rank LIMIT ?`;

  const ftsParams = pid
    ? [title, content, category, q, pid, limit]
    : [title, content, category, q, limit];

  try {
    const results = db().query(ftsSQL).all(...ftsParams) as ScoredKnowledgeEntry[];
    if (results.length) return results;

    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    const ftsParamsOr = pid
      ? [title, content, category, qOr, pid, limit]
      : [title, content, category, qOr, limit];
    return db().query(ftsSQL).all(...ftsParamsOr) as ScoredKnowledgeEntry[];
  } catch {
    return [];
  }
}

/**
 * Search knowledge entries from OTHER projects — entries that are project-specific
 * (cross_project=0) and belong to a different project_id than the given one.
 * Used by the recall tool in "all" scope to surface relevant knowledge from
 * the user's other projects ("tunnel" discovery across projects).
 */
export function searchScoredOtherProjects(input: {
  query: string;
  excludeProjectPath: string;
  limit?: number;
}): ScoredKnowledgeEntry[] {
  const limit = input.limit ?? 10;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const excludePid = ensureProject(input.excludeProjectPath);
  const { title, content, category } = ftsWeights();

  // Find entries from other projects that are NOT cross-project (those are
  // already included in the normal search via the cross_project=1 filter).
  // Also exclude entries with no project_id (global) — already included.
  const ftsSQL = `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge k
     JOIN knowledge_fts f ON k.rowid = f.rowid
     WHERE knowledge_fts MATCH ?
     AND k.project_id IS NOT NULL
     AND k.project_id != ?
     AND k.cross_project = 0
     AND k.confidence > 0.2
     ORDER BY rank LIMIT ?`;

  const ftsParams = [title, content, category, q, excludePid, limit];

  try {
    const results = db().query(ftsSQL).all(...ftsParams) as ScoredKnowledgeEntry[];
    if (results.length) return results;

    // AND returned nothing — try OR fallback
    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    const ftsParamsOr = [title, content, category, qOr, excludePid, limit];
    return db().query(ftsSQL).all(...ftsParamsOr) as ScoredKnowledgeEntry[];
  } catch {
    return [];
  }
}

export function get(id: string): KnowledgeEntry | null {
  return db()
    .query(`SELECT ${KNOWLEDGE_COLS} FROM knowledge WHERE id = ?`)
    .get(id) as KnowledgeEntry | null;
}

/**
 * Prune knowledge entries whose content exceeds maxLength characters.
 * These are typically corrupted entries from AGENTS.md roundtrip escaping bugs
 * or curator hallucinations with full code dumps.
 *
 * Rather than hard-deleting, sets confidence to 0 so they're excluded from
 * queries (confidence > 0.2) but can be inspected for debugging.
 *
 * @returns Number of entries pruned
 */
export function pruneOversized(maxLength: number): number {
  const result = db()
    .query(
      "UPDATE knowledge SET confidence = 0, updated_at = ? WHERE LENGTH(content) > ? AND confidence > 0",
    )
    .run(Date.now(), maxLength);
  // node:sqlite returns `changes` as `number | bigint`; coerce for cross-runtime parity.
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Wiki-link cross-references ([[entry-id]] / [[Entry Title]])
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Resolve a wiki-link reference to a knowledge entry ID.
 * - UUID format → direct O(1) lookup
 * - Title text → FTS5 best-match search
 * Returns null if the reference can't be resolved.
 */
export function resolveRef(ref: string): string | null {
  if (UUID_RE.test(ref)) {
    const entry = get(ref);
    return entry ? entry.id : null;
  }
  // Title search — FTS5 best match
  const results = search({ query: ref, limit: 1 });
  return results.length ? results[0].id : null;
}

/**
 * Extract [[...]] wiki-link references from entry content.
 * Returns the raw ref strings (UUIDs or titles).
 */
export function extractRefs(content: string): string[] {
  const refs: string[] = [];
  let match;
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  while ((match = re.exec(content)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Populate the knowledge_refs join table for an entry by resolving its [[...]] links.
 * Clears existing outgoing refs for this entry first.
 */
export function syncRefs(entryId: string): number {
  const entry = get(entryId);
  if (!entry) return 0;

  // Clear existing outgoing refs
  db().query("DELETE FROM knowledge_refs WHERE from_id = ?").run(entryId);

  const refs = extractRefs(entry.content);
  if (!refs.length) return 0;

  let synced = 0;
  const insertStmt = db().query(
    "INSERT OR IGNORE INTO knowledge_refs (from_id, to_id) VALUES (?, ?)",
  );

  for (const ref of refs) {
    const targetId = resolveRef(ref);
    if (targetId && targetId !== entryId) {
      insertStmt.run(entryId, targetId);
      synced++;
    }
  }

  return synced;
}

/**
 * Cascade-replace an entry ID in all knowledge content and the refs table.
 * Used when an entry ID changes (future-proofing — current consolidation
 * uses update-in-place so IDs don't change, but the mechanism exists).
 */
export function cascadeRefReplace(oldId: string, newId: string): number {
  const oldRef = `[[${oldId}]]`;
  const newRef = `[[${newId}]]`;

  // Rewrite content in entries that reference the old ID
  const result = db()
    .query(
      `UPDATE knowledge SET content = REPLACE(content, ?, ?), updated_at = ?
       WHERE content LIKE ?`,
    )
    .run(oldRef, newRef, Date.now(), `%${oldRef}%`);

  // Update the join table
  db().query("UPDATE OR IGNORE knowledge_refs SET to_id = ? WHERE to_id = ?").run(newId, oldId);
  db().query("UPDATE OR IGNORE knowledge_refs SET from_id = ? WHERE from_id = ?").run(newId, oldId);

  // Clean up any rows that became self-referential
  db().query("DELETE FROM knowledge_refs WHERE from_id = to_id").run();

  // node:sqlite returns `changes` as `number | bigint`; coerce for cross-runtime parity.
  return Number(result.changes);
}

/**
 * Clean dead references — remove [[uuid]] patterns pointing to deleted entries.
 * Strips dead refs from content and purges orphan knowledge_refs rows.
 *
 * @returns Number of entries whose content was cleaned
 */
export function cleanDeadRefs(): number {
  // Step 1: Find orphan refs (target entry no longer exists)
  const orphans = db()
    .query(
      `SELECT DISTINCT kr.from_id, kr.to_id FROM knowledge_refs kr
       WHERE NOT EXISTS (SELECT 1 FROM knowledge k WHERE k.id = kr.to_id)`,
    )
    .all() as Array<{ from_id: string; to_id: string }>;

  if (!orphans.length) return 0;

  // Step 2: Strip [[dead-uuid]] from referring entries' content
  const now = Date.now();
  let cleaned = 0;

  for (const ref of orphans) {
    const deadRef = `[[${ref.to_id}]]`;
    const result = db()
      .query(
        `UPDATE knowledge SET content = REPLACE(content, ?, ''), updated_at = ?
         WHERE id = ? AND content LIKE ?`,
      )
      .run(deadRef, now, ref.from_id, `%${deadRef}%`);
    if (result.changes > 0) cleaned++;
  }

  // Step 3: Delete orphan rows from knowledge_refs
  db()
    .query(
      "DELETE FROM knowledge_refs WHERE to_id NOT IN (SELECT id FROM knowledge)",
    )
    .run();

  if (cleaned > 0) {
    log.info(`cleaned ${cleaned} entries with dead [[ref]] links`);
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Knowledge integrity checking
// ---------------------------------------------------------------------------

export type IntegrityIssue = {
  entryId: string;
  type: "duplicate" | "stale-path" | "oversized" | "empty";
  description: string;
  suggestion?: string;
};

/**
 * Check knowledge entries for integrity issues.
 * Returns a list of issues found — does NOT auto-fix.
 *
 * Checks:
 * 1. Duplicate detection — FTS5 title similarity between entries
 * 2. Content quality — empty content, oversized entries
 */
export function check(projectPath: string): IntegrityIssue[] {
  const entries = forProject(projectPath, false);
  const issues: IntegrityIssue[] = [];

  // Oversized entries (>1200 chars with confidence > 0)
  for (const entry of entries) {
    if (entry.content.length > 1200) {
      issues.push({
        entryId: entry.id,
        type: "oversized",
        description: `Content is ${entry.content.length} chars (max 1200)`,
        suggestion: "Trim or split into multiple entries",
      });
    }
  }

  // Empty or near-empty content
  for (const entry of entries) {
    if (entry.content.trim().length < 10) {
      issues.push({
        entryId: entry.id,
        type: "empty",
        description: `Content is empty or near-empty (${entry.content.trim().length} chars)`,
        suggestion: "Delete or add meaningful content",
      });
    }
  }

  // Duplicate detection: for each entry, search by title and check for high overlap
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const q = ftsQuery(entry.title);
    if (q === EMPTY_QUERY) continue;

    try {
      const { title, content, category } = config().search.ftsWeights;
      const matches = db()
        .query(
          `SELECT k.id, k.title FROM knowledge k
           JOIN knowledge_fts f ON k.rowid = f.rowid
           WHERE knowledge_fts MATCH ?
           AND k.id != ?
           AND k.confidence > 0.2
           ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 3`,
        )
        .all(q, entry.id, title, content, category) as Array<{
        id: string;
        title: string;
      }>;

      for (const match of matches) {
        if (seen.has(match.id)) continue;
        // Check title similarity (case-insensitive)
        const a = entry.title.toLowerCase();
        const b = match.title.toLowerCase();
        // Simple overlap: if one title contains the other or they share >70% of words
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = [...wordsA].filter((w) => wordsB.has(w));
        const overlap = intersection.length / Math.min(wordsA.size, wordsB.size);
        if (overlap >= 0.7) {
          issues.push({
            entryId: entry.id,
            type: "duplicate",
            description: `Possibly duplicates "${match.title}" (${match.id.slice(0, 8)}...)`,
            suggestion: `Merge with ${match.id}`,
          });
          seen.add(match.id);
        }
      }
    } catch {
      // FTS5 error — skip this entry
    }
    seen.add(entry.id);
  }

  return issues;
}
