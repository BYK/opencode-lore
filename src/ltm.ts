import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "./db";
import { ftsQuery } from "./temporal";

// Rough token estimate: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  // Note: when an explicit id is provided (cross-machine import), skip dedup —
  // the caller (importFromFile) already handles duplicate detection by UUID.
  if (!input.id) {
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
      (input.crossProject ?? true) ? 1 : 0,
      now,
      now,
    );
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
        `SELECT * FROM knowledge
         WHERE (project_id = ? OR (project_id IS NULL) OR (cross_project = 1))
         AND confidence > 0.2
         ORDER BY confidence DESC, updated_at DESC`,
      )
      .all(pid) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT * FROM knowledge
       WHERE (project_id = ? OR project_id IS NULL)
       AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid) as KnowledgeEntry[];
}

type Scored = { entry: KnowledgeEntry; score: number };

/** Max entries per pool to include on first turn when no session context exists. */
const NO_CONTEXT_FALLBACK_CAP = 10;

/** Number of top-confidence project entries always included as a safety net,
 *  even when they don't match any session context terms. This guards against
 *  the coarse term-overlap scoring accidentally excluding important project
 *  knowledge. */
const PROJECT_SAFETY_NET = 5;

/**
 * Score entries by term overlap with session context.
 * Returns score = (fraction of topTerms matched) * entry.confidence.
 */
function scoreEntries(
  entries: KnowledgeEntry[],
  topTerms: string[],
): Scored[] {
  return entries.map((entry) => {
    const haystack =
      (entry.title + " " + entry.content).replace(/[^\w\s]/g, " ").toLowerCase();
    let hits = 0;
    for (const term of topTerms) {
      if (haystack.includes(term)) hits++;
    }
    const relevance = topTerms.length > 0 ? hits / topTerms.length : 0;
    return { entry, score: relevance * entry.confidence };
  });
}

/**
 * Extract the top 30 meaningful terms (>3 chars) from text, sorted by frequency.
 */
function extractTopTerms(text: string): string[] {
  const freq = text
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .reduce<Map<string, number>>((acc, w) => {
      acc.set(w, (acc.get(w) ?? 0) + 1);
      return acc;
    }, new Map());

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);
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
      `SELECT * FROM knowledge
       WHERE project_id = ? AND cross_project = 0 AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid) as KnowledgeEntry[];

  // --- 2. Load cross-project candidates ---
  const crossEntries = db()
    .query(
      `SELECT * FROM knowledge
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
    const topTerms = extractTopTerms(sessionContext);

    // Score project entries — include matched + safety net of top-N by confidence
    const rawScored = scoreEntries(projectEntries, topTerms);
    const matched = rawScored.filter((s) => s.score > 0);
    const matchedIds = new Set(matched.map((s) => s.entry.id));

    // Safety net: top PROJECT_SAFETY_NET entries by confidence that weren't already matched.
    // Given a tiny score (0.001 * confidence) so they sort below genuinely matched entries.
    const safetyNet = projectEntries
      .filter((e) => !matchedIds.has(e.id))
      .slice(0, PROJECT_SAFETY_NET)
      .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

    scoredProject = [...matched, ...safetyNet];

    // Score cross-project entries — only include entries with at least one term match
    scoredCross = scoreEntries(crossEntries, topTerms).filter((s) => s.score > 0);
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

  return result;
}

export function all(): KnowledgeEntry[] {
  return db()
    .query(
      "SELECT * FROM knowledge WHERE confidence > 0.2 ORDER BY confidence DESC, updated_at DESC",
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
        `SELECT * FROM knowledge WHERE (project_id = ? OR project_id IS NULL OR cross_project = 1) AND confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pid, ...likeParams, input.limit) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT * FROM knowledge WHERE confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
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
  if (input.projectPath) {
    const pid = ensureProject(input.projectPath);
    try {
      return db()
        .query(
          `SELECT k.* FROM knowledge k
           WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?)
           AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
           AND k.confidence > 0.2
           ORDER BY k.updated_at DESC LIMIT ?`,
        )
        .all(q, pid, limit) as KnowledgeEntry[];
    } catch {
      return searchLike({
        query: input.query,
        projectPath: input.projectPath,
        limit,
      });
    }
  }
  try {
    return db()
      .query(
        `SELECT k.* FROM knowledge k
         WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?)
         AND k.confidence > 0.2
         ORDER BY k.updated_at DESC LIMIT ?`,
      )
      .all(q, limit) as KnowledgeEntry[];
  } catch {
    return searchLike({ query: input.query, limit });
  }
}

export function get(id: string): KnowledgeEntry | null {
  return db()
    .query("SELECT * FROM knowledge WHERE id = ?")
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
  return result.changes;
}
