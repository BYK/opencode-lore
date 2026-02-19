import { db, ensureProject } from "./db";

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
}): string {
  const pid =
    input.scope === "project" && input.projectPath
      ? ensureProject(input.projectPath)
      : null;
  const id = crypto.randomUUID();
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

export function all(): KnowledgeEntry[] {
  return db()
    .query(
      "SELECT * FROM knowledge WHERE confidence > 0.2 ORDER BY confidence DESC, updated_at DESC",
    )
    .all() as KnowledgeEntry[];
}

// Prepare a query for FTS5: split into words, append * to each for prefix matching
function ftsQuery(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return raw;
  return words.map((w) => `${w}*`).join(" ");
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
    return db()
      .query(
        `SELECT k.* FROM knowledge k
         WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?)
         AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
         AND k.confidence > 0.2
         ORDER BY k.updated_at DESC LIMIT ?`,
      )
      .all(q, pid, limit) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT k.* FROM knowledge k
       WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?)
       AND k.confidence > 0.2
       ORDER BY k.updated_at DESC LIMIT ?`,
    )
    .all(q, limit) as KnowledgeEntry[];
}

export function get(id: string): KnowledgeEntry | null {
  return db()
    .query("SELECT * FROM knowledge WHERE id = ?")
    .get(id) as KnowledgeEntry | null;
}
