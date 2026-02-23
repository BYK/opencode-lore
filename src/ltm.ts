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

/**
 * Build a relevance-ranked, budget-capped list of knowledge entries for injection
 * into the system prompt of a live session.
 *
 * Strategy:
 * 1. Project-specific entries (project_id = current project, cross_project = 0)
 *    always get priority — they were curated specifically for this codebase.
 * 2. Cross-project entries are scored for relevance against recent session context
 *    (last distillation + recent raw messages). Only entries that match are included.
 * 3. All candidates are ranked by score * confidence, then greedily packed into
 *    the token budget (smallest-first within same score band to maximize count).
 * 4. If there's no session context yet (first turn), fall back to top entries by
 *    confidence only.
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

  // --- 1. Load project-specific entries (always relevant) ---
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
  // Combine the most recent distillation text + last ~10 raw messages for this session
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

  // --- 4. Score cross-project entries by relevance ---
  // Use FTS5 matching: extract terms from session context and score each entry
  type Scored = { entry: KnowledgeEntry; score: number };
  let scoredCross: Scored[];

  if (sessionContext.trim().length > 20) {
    // Build a term set from session context (top 30 meaningful words)
    const contextTerms = sessionContext
      .replace(/[^\w\s]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .reduce<Map<string, number>>((acc, w) => {
        acc.set(w, (acc.get(w) ?? 0) + 1);
        return acc;
      }, new Map());

    // Sort by frequency, take top 30 terms
    const topTerms = [...contextTerms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([w]) => w);

    scoredCross = crossEntries.map((entry) => {
      const haystack =
        (entry.title + " " + entry.content).replace(/[^\w\s]/g, " ").toLowerCase();
      let hits = 0;
      for (const term of topTerms) {
        // Count how many context terms appear in this entry (simple overlap)
        if (haystack.includes(term)) hits++;
      }
      // Score = fraction of top terms matched, weighted by confidence
      const relevance = topTerms.length > 0 ? hits / topTerms.length : 0;
      return { entry, score: relevance * entry.confidence };
    });

    // Only keep entries with at least one term match
    scoredCross = scoredCross.filter((s) => s.score > 0);
  } else {
    // No session context yet — take top cross-project entries by confidence
    scoredCross = crossEntries.slice(0, 10).map((entry) => ({
      entry,
      score: entry.confidence,
    }));
  }

  // Sort cross-project by score desc
  scoredCross.sort((a, b) => b.score - a.score);

  // --- 5. Pack into token budget ---
  // Project entries get first pick (fully relevant); cross entries fill remaining budget.
  // Use a greedy fit: iterate candidates and include if they fit.
  const HEADER_OVERHEAD_TOKENS = 15; // "## Long-term Knowledge\n"
  let used = HEADER_OVERHEAD_TOKENS;
  const result: KnowledgeEntry[] = [];

  function tryAdd(entry: KnowledgeEntry): boolean {
    const cost = estimateTokens(entry.title + entry.content) + 10;
    if (used + cost > maxTokens) return false;
    result.push(entry);
    used += cost;
    return true;
  }

  // Project-specific first
  for (const entry of projectEntries) {
    tryAdd(entry);
  }

  // Then cross-project by relevance score
  for (const { entry } of scoredCross) {
    if (used >= maxTokens) break;
    tryAdd(entry);
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
