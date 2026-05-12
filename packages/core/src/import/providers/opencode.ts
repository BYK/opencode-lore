/**
 * OpenCode conversation history provider.
 *
 * Reads from OpenCode's SQLite database at ~/.local/share/opencode/opencode.db.
 * The message.data and part.data JSON fields use a format very close to lore's
 * own LoreMessage/LorePart types (since lore was designed for OpenCode).
 */
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "#db/driver";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCODE_DB_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "opencode.db",
);
const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Open OpenCode's database read-only.
 * Returns null if the DB doesn't exist or can't be opened.
 *
 * Bun's `Database` uses `{ readonly: true }` while Node.js's `DatabaseSync`
 * uses `{ readOnly: true }`. We pass both via a cast to cover both runtimes.
 */
function openDB(): InstanceType<typeof Database> | null {
  if (!existsSync(OPENCODE_DB_PATH)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Database(OPENCODE_DB_PATH, { readonly: true, readOnly: true } as any);
  } catch {
    return null;
  }
}

/** Check if a table exists in the database. */
function tableExists(database: InstanceType<typeof Database>, table: string): boolean {
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name: string } | null;
  return row != null;
}

type PartData = {
  type: string;
  text?: string;
  tool?: string;
  state?: {
    status: string;
    output?: string;
  };
};

/** Convert part data rows into conversation text. */
function partsToConversationText(parts: PartData[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      segments.push(part.text);
    } else if (part.type === "tool" && part.tool && part.state?.status === "completed" && part.state.output) {
      segments.push(`[tool: ${part.tool}] ${truncate(part.state.output, MAX_TOOL_OUTPUT_CHARS)}`);
    }
    // Skip reasoning, step-start, and other non-text parts
  }
  return segments.join("\n");
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const opencodeProvider: AgentHistoryProvider = {
  name: "opencode",
  displayName: "OpenCode",

  detect(projectPath: string): DetectedSession[] {
    const database = openDB();
    if (!database) return [];

    try {
      // Check required tables exist
      if (!tableExists(database, "project") || !tableExists(database, "session") || !tableExists(database, "message")) {
        return [];
      }

      // Find the project by worktree path
      const project = database
        .query("SELECT id FROM project WHERE worktree = ?")
        .get(projectPath) as { id: string } | null;
      if (!project) return [];

      // Get sessions with message counts
      const sessions = database
        .query(
          `SELECT s.id, s.title, s.time_created, s.time_updated,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count
           FROM session s
           WHERE s.project_id = ? AND s.parent_id IS NULL
           ORDER BY s.time_updated DESC`,
        )
        .all(project.id) as Array<{
        id: string;
        title: string;
        time_created: number;
        time_updated: number;
        msg_count: number;
      }>;

      const results: DetectedSession[] = [];
      for (const sess of sessions) {
        // Skip trivially small sessions
        if (sess.msg_count < 3) continue;

        // Estimate tokens from message count (rough: ~500 tokens/message avg)
        const estimatedTokens = sess.msg_count * 500;
        const dateStr = new Date(sess.time_created).toISOString().slice(0, 10);
        const label = sess.title
          ? `${dateStr} - ${sess.title} (${sess.msg_count} messages)`
          : `${dateStr} (${sess.msg_count} messages)`;

        results.push({
          id: sess.id,
          label,
          startedAt: sess.time_created,
          lastActivityAt: sess.time_updated,
          estimatedTokens,
          messageCount: sess.msg_count,
        });
      }

      return results;
    } finally {
      database.close();
    }
  },

  readChunks(
    _projectPath: string,
    sessionIds: string[],
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): ConversationChunk[] {
    const database = openDB();
    if (!database) return [];

    const chunks: ConversationChunk[] = [];

    try {
      const hasParts = tableExists(database, "part");

      for (const sessionId of sessionIds) {
        // Get messages ordered by time
        const messages = database
          .query(
            `SELECT id, data, time_created FROM message
             WHERE session_id = ?
             ORDER BY time_created ASC`,
          )
          .all(sessionId) as Array<{
          id: string;
          data: string;
          time_created: number;
        }>;

        if (messages.length === 0) continue;

        const textMessages: { text: string; timestamp: number }[] = [];

        for (const msg of messages) {
          let msgData: { role?: string };
          try {
            msgData = JSON.parse(msg.data);
          } catch {
            continue;
          }

          const role = msgData.role ?? "unknown";
          let contentText = "";

          if (hasParts) {
            // Read parts for this message
            const parts = database
              .query(
                `SELECT data FROM part
                 WHERE message_id = ?
                 ORDER BY time_created ASC`,
              )
              .all(msg.id) as Array<{ data: string }>;

            const parsedParts: PartData[] = [];
            for (const p of parts) {
              try {
                parsedParts.push(JSON.parse(p.data) as PartData);
              } catch {
                // Skip malformed parts
              }
            }
            contentText = partsToConversationText(parsedParts);
          }

          if (!contentText.trim()) continue;

          textMessages.push({
            text: `[${role}] ${contentText}`,
            timestamp: msg.time_created,
          });
        }

        if (textMessages.length === 0) continue;

        // Build chunks respecting maxTokens boundaries
        let currentTexts: string[] = [];
        let currentTokens = 0;
        let chunkStart = textMessages[0].timestamp;
        let chunkIndex = 0;

        const flushChunk = () => {
          if (currentTexts.length === 0) return;
          chunkIndex++;
          const text = currentTexts.join("\n\n");
          chunks.push({
            label: `OpenCode ${new Date(chunkStart).toISOString().slice(0, 10)} (${chunkIndex})`,
            text,
            estimatedTokens: estimateTokens(text),
            timestamp: chunkStart,
          });
          currentTexts = [];
          currentTokens = 0;
        };

        for (const msg of textMessages) {
          const msgTokens = estimateTokens(msg.text);
          if (currentTokens > 0 && currentTokens + msgTokens > maxTokens) {
            flushChunk();
            chunkStart = msg.timestamp;
          }
          currentTexts.push(msg.text);
          currentTokens += msgTokens;
        }

        flushChunk();
      }
    } finally {
      database.close();
    }

    return chunks;
  },
};

// Auto-register on import
registerProvider(opencodeProvider);
