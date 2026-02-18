import { db, ensureProject } from "./db";
import type { Message, Part } from "@opencode-ai/sdk";

// Estimate token count from text length (rough: 1 token ≈ 4 chars)
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function partsToText(parts: Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") chunks.push(part.text);
    else if (part.type === "reasoning" && part.text)
      chunks.push(`[reasoning] ${part.text}`);
    else if (part.type === "tool" && part.state.status === "completed")
      chunks.push(`[tool:${part.tool}] ${part.state.output}`);
  }
  return chunks.join("\n");
}

function messageMetadata(info: Message, parts: Part[]): string {
  const meta: Record<string, unknown> = {};
  if (info.role === "user") {
    meta.agent = info.agent;
    meta.model = info.model;
  } else {
    meta.modelID = info.modelID;
    meta.providerID = info.providerID;
    meta.mode = info.mode;
  }
  const tools = parts
    .filter((p) => p.type === "tool")
    .map((p) => (p as Extract<Part, { type: "tool" }>).tool);
  if (tools.length) meta.tools = tools;
  return JSON.stringify(meta);
}

export function store(input: {
  projectPath: string;
  info: Message;
  parts: Part[];
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

export function search(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
}): TemporalMessage[] {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 20;
  // FTS5 query with project filtering via join
  const query = input.sessionID
    ? `SELECT m.* FROM temporal_messages m
       JOIN temporal_fts f ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ? AND m.session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT m.* FROM temporal_messages m
       JOIN temporal_fts f ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND m.project_id = ?
       ORDER BY rank LIMIT ?`;
  const params = input.sessionID
    ? [input.query, pid, input.sessionID, limit]
    : [input.query, pid, limit];
  return db()
    .query(query)
    .all(...params) as TemporalMessage[];
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
