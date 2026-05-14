import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "./db";
import { config } from "./config";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY, extractTopTerms, filterTerms, runRelaxedSearch } from "./search";
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

  // IF-2: Global entries (pid=null) must be cross-project to avoid a data hole
  // where forSession() can't find them in either the project or cross-project pool.
  const crossProject = pid === null ? true : (input.crossProject ?? false);

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

    // Fuzzy dedup: check for title-similar entries via FTS5 + word-overlap.
    // This catches near-duplicates the curator creates with slightly different
    // titles for the same concept (e.g. "Upgrade lock bug" vs "Upgrade binary
    // lock re-entry bug"). Placed after exact checks (cheaper checks first).
    const fuzzyMatch = findFuzzyDuplicate({ title: input.title, projectId: pid });
    if (fuzzyMatch) {
      update(fuzzyMatch.id, { content: input.content });
      return fuzzyMatch.id;
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
      crossProject ? 1 : 0,
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
    // Clamp to [0.0, 1.0] — an LLM-provided value outside this range would
    // give disproportionate scoring weight (>1) or silently soft-delete (<0.2).
    sets.push("confidence = ?");
    params.push(Math.max(0, Math.min(1, input.confidence)));
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

// ---------------------------------------------------------------------------
// Fuzzy title dedup — word-overlap similarity
// ---------------------------------------------------------------------------

/**
 * Compute title word-overlap between two titles.
 * Returns { coefficient, intersectionSize } where:
 * - coefficient = |A ∩ B| / min(|A|, |B|) (0–1)
 * - intersectionSize = number of shared meaningful words
 * Filters stopwords and single-char tokens for meaningful comparison.
 */
function titleOverlap(a: string, b: string): { coefficient: number; intersectionSize: number } {
  const wordsA = new Set(filterTerms(a).map((w) => w.toLowerCase()));
  const wordsB = new Set(filterTerms(b).map((w) => w.toLowerCase()));
  if (wordsA.size === 0 || wordsB.size === 0) return { coefficient: 0, intersectionSize: 0 };
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  return {
    coefficient: intersection.length / Math.min(wordsA.size, wordsB.size),
    intersectionSize: intersection.length,
  };
}

/** Minimum word-overlap coefficient to consider two titles as duplicates. */
const FUZZY_DEDUP_THRESHOLD = 0.7;
/** Minimum number of overlapping meaningful words required for a fuzzy match.
 *  Prevents false positives on short titles where 2-3 common words produce
 *  a high overlap coefficient despite being genuinely different entries. */
const FUZZY_DEDUP_MIN_OVERLAP = 4;
/** Minimum cosine similarity for embedding-based dedup. Empirically tuned
 *  against 312 Nomic v1.5 entries:
 *  - 0.935+: all genuine duplicates (same topic, different wording)
 *  - 0.92–0.935: contains false positives from same-subsystem entries
 *    (e.g. "BGE Small unusable" ↔ "Nomic OOM" scored 0.9326 — related
 *    but distinct bugs). Star clustering amplifies this by bridging.
 *  - <0.92: mixed or unrelated entries */
const EMBEDDING_DEDUP_THRESHOLD = 0.935;

/**
 * Find an existing knowledge entry whose title is fuzzy-similar to the given title.
 *
 * Uses FTS5 to find up to 5 candidates, then applies word-overlap filtering.
 * This is the same algorithm used by `check()` but returns a single match
 * for use in the `create()` dedup guard.
 *
 * @returns The first matching entry (id + title), or null if no fuzzy match.
 */
export function findFuzzyDuplicate(input: {
  title: string;
  projectId: string | null;
  excludeId?: string;
}): { id: string; title: string } | null {
  const q = ftsQueryOr(input.title);
  if (q === EMPTY_QUERY) return null;

  const { title: tw, content: cw, category: catw } = config().search.ftsWeights;

  try {
    // Build query scoped to the same project + cross-project entries
    const excludeClause = input.excludeId ? "AND k.id != ?" : "";
    const sql = input.projectId !== null
      ? `SELECT k.id, k.title FROM knowledge_fts f
         CROSS JOIN knowledge k ON k.rowid = f.rowid
         WHERE knowledge_fts MATCH ?
         AND (k.project_id = ? OR k.cross_project = 1)
         AND k.confidence > 0.2
         ${excludeClause}
         ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 5`
      : `SELECT k.id, k.title FROM knowledge_fts f
         CROSS JOIN knowledge k ON k.rowid = f.rowid
         WHERE knowledge_fts MATCH ?
         AND (k.project_id IS NULL OR k.cross_project = 1)
         AND k.confidence > 0.2
         ${excludeClause}
         ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 5`;

    const params: (string | number)[] = input.projectId !== null
      ? [q, input.projectId, ...(input.excludeId ? [input.excludeId] : []), tw, cw, catw]
      : [q, ...(input.excludeId ? [input.excludeId] : []), tw, cw, catw];

    const candidates = db().query(sql).all(...params) as Array<{ id: string; title: string }>;

    for (const candidate of candidates) {
      const { coefficient, intersectionSize } = titleOverlap(input.title, candidate.title);
      if (coefficient >= FUZZY_DEDUP_THRESHOLD && intersectionSize >= FUZZY_DEDUP_MIN_OVERLAP) {
        return candidate;
      }
    }
  } catch {
    // FTS5 error — fall through to no match
  }

  return null;
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
          FROM knowledge_fts f
          CROSS JOIN knowledge k ON k.rowid = f.rowid
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

/** Options for `forSession()` to control entry selection. */
export type ForSessionOptions = {
  /** Caller-provided context (e.g., user's current message) for relevance
   *  scoring when no session context exists in the DB yet. */
  contextHint?: string;
  /** Restrict to these categories (e.g., `['preference']` for turn 1). */
  categories?: string[];
  /** Exclude these categories (e.g., `['preference']` for context-bound
   *  entries when preferences are already injected in a separate block). */
  excludeCategories?: string[];
};

/**
 * Build a relevance-ranked, budget-capped list of knowledge entries for injection
 * into the system prompt of a live session.
 *
 * Strategy:
 * 1. Both project-specific and cross-project entries are scored for relevance
 *    against recent session context (last distillation + recent raw messages).
 * 2. When embeddings are available, vector cosine similarity is used for scoring
 *    (captures semantic matches that keyword overlap misses). Falls back to
 *    FTS5 BM25 when embeddings are unavailable.
 * 3. Project entries get a safety net: the top PROJECT_SAFETY_NET entries by
 *    confidence are always included even if they have zero relevance score.
 *    This ensures the most important project knowledge is never lost to
 *    coarse scoring.
 * 4. All scored entries are merged into a single pool and greedily packed
 *    into the token budget by score descending.
 * 5. If there's no session context yet (first turn), fall back to top entries
 *    by confidence only (capped at NO_CONTEXT_FALLBACK_CAP per pool).
 *
 * @param projectPath   Current project path
 * @param sessionID     Current session ID (for context extraction)
 * @param maxTokens     Hard token budget for the entire formatted block
 * @param options       Optional category filter and context hint
 */
export async function forSession(
  projectPath: string,
  sessionID: string | undefined,
  maxTokens: number,
  options?: ForSessionOptions,
): Promise<KnowledgeEntry[]> {
  const pid = ensureProject(projectPath);
  const categoryFilter = options?.categories;
  const excludeFilter = options?.excludeCategories;

  // Build optional SQL category clauses (include / exclude are mutually exclusive)
  let categoryClause = "";
  let categoryParams: string[] = [];
  if (categoryFilter?.length) {
    categoryClause = ` AND category IN (${categoryFilter.map(() => "?").join(",")})`;
    categoryParams = categoryFilter;
  } else if (excludeFilter?.length) {
    categoryClause = ` AND category NOT IN (${excludeFilter.map(() => "?").join(",")})`;
    categoryParams = excludeFilter;
  }

  // --- 1. Load project-specific entries ---
  const projectEntries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE project_id = ? AND cross_project = 0 AND confidence > 0.2${categoryClause}
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid, ...categoryParams) as KnowledgeEntry[];

  // --- 2. Load cross-project candidates ---
  const crossEntries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE (project_id IS NULL OR cross_project = 1) AND confidence > 0.2${categoryClause}
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(...categoryParams) as KnowledgeEntry[];

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

  // Fall back to caller-provided context hint (e.g., user's first message)
  if (!sessionContext.trim() && options?.contextHint) {
    sessionContext = options.contextHint;
  }

  // --- 4. Score both pools by relevance ---
  let scoredProject: Scored[];
  let scoredCross: Scored[];

  if (sessionContext.trim().length > 20 && embedding.isAvailable()) {
    // Vector scoring: embed session context, score entries by cosine similarity.
    // Captures semantic matches (e.g., "OpenAI Batch API" ↔ "batch queue worker")
    // that keyword-based FTS5 misses.
    let vectorScores: Map<string, number>;
    try {
      const [contextVec] = await embedding.embed([sessionContext], "query");
      const hits = embedding.vectorSearch(contextVec, 50);
      vectorScores = new Map(hits.map((h) => [h.id, h.similarity]));
    } catch (err) {
      log.warn("Vector scoring failed, falling back to FTS5:", err);
      vectorScores = new Map();
    }

    if (vectorScores.size > 0) {
      // Hybrid scoring: vector search only covers entries with stored embeddings.
      // Entries without embeddings (e.g. newly created, async embed not yet done)
      // fall back to FTS5 so they aren't invisible to scoring.
      const ftsScores = scoreEntriesFTS(sessionContext);

      // Score project entries: prefer vector similarity, fall back to FTS5
      const rawScored: Scored[] = projectEntries.map((entry) => {
        const vecScore = vectorScores.get(entry.id);
        const score = vecScore != null
          ? vecScore * entry.confidence
          : (ftsScores.get(entry.id) ?? 0) * entry.confidence;
        return { entry, score };
      });
      const matched = rawScored.filter((s) => s.score > 0);
      const matchedIds = new Set(matched.map((s) => s.entry.id));

      // Safety net: top PROJECT_SAFETY_NET entries by confidence that weren't already matched.
      // Given a tiny score (0.001 * confidence) so they sort below genuinely matched entries.
      const safetyNet = projectEntries
        .filter((e) => !matchedIds.has(e.id))
        .slice(0, PROJECT_SAFETY_NET)
        .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

      scoredProject = [...matched, ...safetyNet];

      // Cross-project: include entries matched by vector OR FTS5
      scoredCross = crossEntries
        .filter((e) => vectorScores.has(e.id) || ftsScores.has(e.id))
        .map((e) => {
          const vecScore = vectorScores.get(e.id);
          const score = vecScore != null
            ? vecScore * e.confidence
            : (ftsScores.get(e.id) ?? 0) * e.confidence;
          return { entry: e, score };
        });
    } else {
      // Vector failed — fall through to FTS5
      const ftsScores = scoreEntriesFTS(sessionContext);
      ({ scoredProject, scoredCross } = scoreFTS(
        projectEntries,
        crossEntries,
        ftsScores,
      ));
    }
  } else if (sessionContext.trim().length > 20) {
    // Embeddings unavailable — use FTS5 BM25 as fallback
    const ftsScores = scoreEntriesFTS(sessionContext);
    ({ scoredProject, scoredCross } = scoreFTS(
      projectEntries,
      crossEntries,
      ftsScores,
    ));
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

/** Score entries using FTS5 BM25 — extracted for reuse in the vector-fallback path. */
function scoreFTS(
  projectEntries: KnowledgeEntry[],
  crossEntries: KnowledgeEntry[],
  ftsScores: Map<string, number>,
): { scoredProject: Scored[]; scoredCross: Scored[] } {
  const rawScored: Scored[] = projectEntries.map((entry) => ({
    entry,
    score: (ftsScores.get(entry.id) ?? 0) * entry.confidence,
  }));
  const matched = rawScored.filter((s) => s.score > 0);
  const matchedIds = new Set(matched.map((s) => s.entry.id));

  const safetyNet = projectEntries
    .filter((e) => !matchedIds.has(e.id))
    .slice(0, PROJECT_SAFETY_NET)
    .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

  const scoredProject = [...matched, ...safetyNet];

  const scoredCross = crossEntries
    .filter((e) => ftsScores.has(e.id))
    .map((e) => ({
      entry: e,
      score: (ftsScores.get(e.id) ?? 0) * e.confidence,
    }));

  return { scoredProject, scoredCross };
}

export function all(): KnowledgeEntry[] {
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge WHERE confidence > 0.2 ORDER BY confidence DESC, updated_at DESC`,
    )
    .all() as KnowledgeEntry[];
}

/** Return all cross-project and global (user-level) knowledge entries. */
export function crossProject(): KnowledgeEntry[] {
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE (project_id IS NULL OR cross_project = 1) AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
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

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND k.confidence > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND k.confidence > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`;

  const { title, content, category } = ftsWeights();

  try {
    return runRelaxedSearch(input.query, (matchExpr) => {
      const params = pid
        ? [matchExpr, pid, title, content, category, limit]
        : [matchExpr, title, content, category, limit];
      return db().query(ftsSQL).all(...params) as KnowledgeEntry[];
    });
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

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;
  const { title, content, category } = ftsWeights();

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND k.confidence > 0.2
       ORDER BY rank LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       AND k.confidence > 0.2
       ORDER BY rank LIMIT ?`;

  try {
    return runRelaxedSearch(input.query, (matchExpr) => {
      const params = pid
        ? [title, content, category, matchExpr, pid, limit]
        : [title, content, category, matchExpr, limit];
      return db().query(ftsSQL).all(...params) as ScoredKnowledgeEntry[];
    });
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

  const excludePid = ensureProject(input.excludeProjectPath);
  const { title, content, category } = ftsWeights();

  // Find entries from other projects that are NOT cross-project (those are
  // already included in the normal search via the cross_project=1 filter).
  // Also exclude entries with no project_id (global) — already included.
  const ftsSQL = `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
     CROSS JOIN knowledge k ON k.rowid = f.rowid
     WHERE knowledge_fts MATCH ?
     AND k.project_id IS NOT NULL
     AND k.project_id != ?
     AND k.cross_project = 0
     AND k.confidence > 0.2
     ORDER BY rank LIMIT ?`;

  try {
    return runRelaxedSearch(input.query, (matchExpr) => {
      const params = [title, content, category, matchExpr, excludePid, limit];
      return db().query(ftsSQL).all(...params) as ScoredKnowledgeEntry[];
    });
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
          `SELECT k.id, k.title FROM knowledge_fts f
           CROSS JOIN knowledge k ON k.rowid = f.rowid
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

// ---------------------------------------------------------------------------
// Deduplication — embedding-based semantic clustering with word-overlap fallback
// ---------------------------------------------------------------------------

export type DedupCluster = {
  surviving: { id: string; title: string };
  merged: Array<{ id: string; title: string }>;
};

export type DedupResult = {
  clusters: DedupCluster[];
  totalRemoved: number;
};

/**
 * Deduplicate knowledge entries for a project.
 *
 * Uses two complementary signals with "star" clustering (no transitive
 * chains) to prevent snowball merging:
 *
 * 1. **Title word-overlap** (Jaccard on meaningful words) — catches entries
 *    with similar titles regardless of content wording.
 * 2. **Embedding cosine similarity** (when embeddings are available) — catches
 *    entries with different titles but semantically identical content. Nomic
 *    v1.5 produces a same-domain spread of 0.46–0.70 for distinct entries,
 *    making threshold-based dedup viable at 0.935+ (lower thresholds catch
 *    related-but-distinct entries as false positives, especially via star
 *    clustering where a hub entry bridges two distinct topics).
 *
 * Pairs matching either signal are clustered together. For each cluster,
 * picks a survivor (highest confidence, then most recently updated, then
 * shortest title) and removes the rest.
 *
 * @param projectPath   Project root path
 * @param opts.dryRun   If true (default), report clusters without deleting
 * @returns             Cluster report and count of removed entries
 */
/** Core dedup logic — operates on an arbitrary list of entries. */
function _dedup(entries: KnowledgeEntry[], dryRun: boolean): DedupResult {
  if (entries.length < 2) return { clusters: [], totalRemoved: 0 };

  // --- Build neighbor map using title overlap + embedding similarity ---
  // Two entries are considered neighbors (potential duplicates) if EITHER:
  //   (a) title word-overlap ≥ 0.7 with ≥ 4 shared words, OR
  //   (b) embedding cosine similarity ≥ 0.935
  // Star clustering (no transitivity) prevents snowball merging.
  // O(n²) pairwise comparison — acceptable for n ≤ 25 (maxEntries cap).

  // Load embeddings for the given entries (if available).
  // We query directly rather than using vectorSearch() because we need
  // pairwise comparison among entries, not a query-vs-all search.
  const embeddingMap = new Map<string, Float32Array>();
  {
    const entryIds = entries.map((e) => e.id);
    // Build parameterized IN clause for the entry IDs
    const placeholders = entryIds.map(() => "?").join(",");
    const rows = db()
      .query(`SELECT id, embedding FROM knowledge WHERE embedding IS NOT NULL AND id IN (${placeholders})`)
      .all(...entryIds) as Array<{ id: string; embedding: Buffer }>;
    for (const row of rows) {
      try {
        embeddingMap.set(row.id, embedding.fromBlob(row.embedding));
      } catch {
        // Skip corrupted embeddings — entry falls back to title-overlap only.
        log.info(`skipping corrupted embedding for entry ${row.id}`);
      }
    }
  }

  // Pre-compute neighbors for all pairs
  type DedupHit = { id: string; score: number };
  const neighborMap = new Map<string, DedupHit[]>();

  for (const entry of entries) {
    const neighbors: DedupHit[] = [];
    const entryVec = embeddingMap.get(entry.id);

    for (const other of entries) {
      if (other.id === entry.id) continue;

      // Signal 1: title word-overlap
      const { coefficient, intersectionSize } = titleOverlap(entry.title, other.title);
      const titleMatch = coefficient >= FUZZY_DEDUP_THRESHOLD && intersectionSize >= FUZZY_DEDUP_MIN_OVERLAP;

      // Signal 2: embedding cosine similarity
      let embeddingMatch = false;
      let similarity = 0;
      if (entryVec) {
        const otherVec = embeddingMap.get(other.id);
        if (otherVec && entryVec.length === otherVec.length) {
          similarity = embedding.cosineSimilarity(entryVec, otherVec);
          embeddingMatch = similarity >= EMBEDDING_DEDUP_THRESHOLD;
        }
      }

      if (titleMatch || embeddingMatch) {
        // Use the stronger signal as the match score for cluster priority
        neighbors.push({ id: other.id, score: Math.max(coefficient, similarity) });
      }
    }
    neighbors.sort((a, b) => b.score - a.score);
    neighborMap.set(entry.id, neighbors);
  }

  // Greedy star clustering — process entries with most neighbors first
  const claimed = new Set<string>();
  const rawClusters = new Map<string, string[]>();

  const sortedIds = [...neighborMap.keys()].sort(
    (a, b) => neighborMap.get(b)!.length - neighborMap.get(a)!.length,
  );

  for (const centerId of sortedIds) {
    if (claimed.has(centerId)) continue;
    claimed.add(centerId);
    const members = [centerId];

    for (const { id: neighborId } of neighborMap.get(centerId)!) {
      if (claimed.has(neighborId)) continue;
      claimed.add(neighborId);
      members.push(neighborId);
    }

    if (members.length > 1) {
      rawClusters.set(centerId, members);
    }
  }

  // Build clusters and pick survivors
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const result: DedupCluster[] = [];
  let totalRemoved = 0;

  for (const members of rawClusters.values()) {
    if (members.length < 2) continue;

    // Pick survivor: highest confidence → most recent → shortest title
    const sorted = members
      .map((id) => entryById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
        return a.title.length - b.title.length;
      });

    const survivor = sorted[0];
    const merged = sorted.slice(1);

    result.push({
      surviving: { id: survivor.id, title: survivor.title },
      merged: merged.map((e) => ({ id: e.id, title: e.title })),
    });

    if (!dryRun) {
      for (const entry of merged) {
        remove(entry.id);
      }
    }

    totalRemoved += merged.length;
  }

  // Sort clusters by size descending for readability
  result.sort((a, b) => b.merged.length - a.merged.length);

  return { clusters: result, totalRemoved };
}

export async function deduplicate(
  projectPath: string,
  opts?: { dryRun?: boolean },
): Promise<DedupResult> {
  const entries = forProject(projectPath, false);
  return _dedup(entries, opts?.dryRun ?? true);
}

/** Deduplicate global (cross-project) entries that have no project_id. */
export async function deduplicateGlobal(
  opts?: { dryRun?: boolean },
): Promise<DedupResult> {
  const entries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge
       WHERE project_id IS NULL
       AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all() as KnowledgeEntry[];
  return _dedup(entries, opts?.dryRun ?? true);
}
