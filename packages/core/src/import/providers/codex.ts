/**
 * Codex (OpenAI) conversation history provider.
 *
 * Reads JSONL session files from ~/.codex/sessions/YYYY/MM/DD/<rollout>.jsonl
 * and archived sessions from ~/.codex/archived_sessions/*.jsonl
 *
 * Each JSONL file starts with a session_meta line containing { id, cwd, timestamp, ... }
 * followed by response_item, event_msg, compacted, and turn_context lines.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_DIR = join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_DIR, "sessions");
const ARCHIVED_DIR = join(CODEX_DIR, "archived_sessions");
const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// ---------------------------------------------------------------------------
// JSONL types (only the fields we read)
// ---------------------------------------------------------------------------

type CodexLine =
  | {
      type: "session_meta";
      payload: {
        meta: {
          id: string;
          timestamp: string;
          cwd: string;
          source?: string;
          model_provider?: string;
          cli_version?: string;
        };
      };
    }
  | {
      type: "response_item";
      payload: ResponseItem;
    }
  | {
      type: "event_msg";
      payload: {
        type?: string;
        output?: string;
        truncated?: boolean;
      };
    }
  | {
      type: "compacted";
      payload: {
        replacement_history?: ResponseItem[];
      };
    }
  | { type: string; payload?: unknown };

type ResponseItem = {
  type?: string;
  role?: string;
  content?: string | ContentPart[];
  name?: string;
  arguments?: string;
  output?: string;
  status?: string;
};

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

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

/** Recursively find all .jsonl files under a directory. */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (stat.isFile() && entry.endsWith(".jsonl")) results.push(full);
      } catch {
        // Skip inaccessible entries
      }
    }
  };

  walk(dir);
  return results;
}

/** Extract text content from a ResponseItem. */
function responseItemToText(item: ResponseItem): string | null {
  if (!item) return null;

  // Message items (user/assistant text)
  if (item.type === "message" && item.role && item.content) {
    const text = extractContent(item.content);
    if (text) return `[${item.role}] ${text}`;
  }

  // Function/tool call items
  if (item.type === "function_call" && item.name) {
    const args = item.arguments
      ? truncate(item.arguments, MAX_TOOL_OUTPUT_CHARS)
      : "";
    return `[tool: ${item.name}] ${args}`;
  }

  // Function/tool output items
  if (item.type === "function_call_output" && item.output) {
    return `[tool_result] ${truncate(item.output, MAX_TOOL_OUTPUT_CHARS)}`;
  }

  return null;
}

/** Extract text from content (string or array of content parts). */
function extractContent(content: string | ContentPart[]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if ("text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Parse a JSONL file, returning typed lines. */
function parseJSONL(filePath: string): CodexLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines: CodexLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as CodexLine);
    } catch {
      // Skip malformed
    }
  }
  return lines;
}

/** Get session metadata from the first line of a JSONL file. */
function getSessionMeta(
  filePath: string,
): {
  id: string;
  cwd: string;
  timestamp: string;
  messageCount: number;
  fileSize: number;
} | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  // First line should be session_meta
  let meta: CodexLine;
  try {
    meta = JSON.parse(lines[0]) as CodexLine;
  } catch {
    return null;
  }

  if (meta.type !== "session_meta") return null;

  const payload = meta.payload as {
    meta: { id: string; cwd: string; timestamp: string };
  };

  // Count message-like lines
  let messageCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CodexLine;
      if (parsed.type === "response_item" || parsed.type === "event_msg") {
        messageCount++;
      }
    } catch {
      // Skip
    }
  }

  return {
    id: payload.meta.id,
    cwd: payload.meta.cwd,
    timestamp: payload.meta.timestamp,
    messageCount,
    fileSize: raw.length,
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const codexProvider: AgentHistoryProvider = {
  name: "codex",
  displayName: "Codex",

  detect(projectPath: string): DetectedSession[] {
    const sessions: DetectedSession[] = [];

    // Scan both active and archived sessions
    const allFiles = [
      ...findJsonlFiles(SESSIONS_DIR),
      ...findJsonlFiles(ARCHIVED_DIR),
    ];

    for (const filePath of allFiles) {
      const meta = getSessionMeta(filePath);
      if (!meta) continue;

      // Match by CWD — the session must have been started in this project
      if (meta.cwd !== projectPath) continue;

      // Skip trivially small sessions
      if (meta.messageCount < 3) continue;

      const ts = new Date(meta.timestamp).getTime();
      const estimatedTokens = Math.ceil(meta.fileSize / 5);
      const dateStr = new Date(ts).toISOString().slice(0, 10);

      sessions.push({
        id: filePath,
        label: `${dateStr} (${meta.messageCount} messages)`,
        startedAt: ts,
        lastActivityAt: ts, // Best approximation without reading all lines
        estimatedTokens,
        messageCount: meta.messageCount,
      });
    }

    return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  },

  readChunks(
    _projectPath: string,
    sessionIds: string[],
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): ConversationChunk[] {
    const chunks: ConversationChunk[] = [];

    for (const filePath of sessionIds) {
      const lines = parseJSONL(filePath);
      const messages: { text: string; timestamp: number }[] = [];

      // Find session timestamp for labeling
      let sessionTimestamp = Date.now();
      const firstLine = lines[0];
      if (firstLine?.type === "session_meta") {
        const meta = firstLine as Extract<CodexLine, { type: "session_meta" }>;
        const ts = new Date(meta.payload.meta.timestamp).getTime();
        if (!Number.isNaN(ts)) sessionTimestamp = ts;
      }

      for (const line of lines) {
        if (line.type === "response_item") {
          const ri = line as Extract<CodexLine, { type: "response_item" }>;
          const text = responseItemToText(ri.payload);
          if (text) {
            messages.push({ text, timestamp: sessionTimestamp });
          }
        } else if (line.type === "event_msg") {
          const ev = line as Extract<CodexLine, { type: "event_msg" }>;
          if (ev.payload.output) {
            messages.push({
              text: `[exec] ${truncate(ev.payload.output, MAX_TOOL_OUTPUT_CHARS)}`,
              timestamp: sessionTimestamp,
            });
          }
        } else if (line.type === "compacted") {
          const comp = line as Extract<CodexLine, { type: "compacted" }>;
          if (comp.payload.replacement_history) {
            // After compaction, the replacement_history is the compressed conversation
            for (const item of comp.payload.replacement_history) {
              const text = responseItemToText(item);
              if (text) {
                messages.push({ text, timestamp: sessionTimestamp });
              }
            }
          }
        }
      }

      if (messages.length === 0) continue;

      // Build chunks respecting maxTokens boundaries
      let currentTexts: string[] = [];
      let currentTokens = 0;
      let chunkIndex = 0;

      const flushChunk = () => {
        if (currentTexts.length === 0) return;
        chunkIndex++;
        const text = currentTexts.join("\n\n");
        chunks.push({
          label: `Codex ${new Date(sessionTimestamp).toISOString().slice(0, 10)} (${chunkIndex})`,
          text,
          estimatedTokens: estimateTokens(text),
          timestamp: sessionTimestamp,
        });
        currentTexts = [];
        currentTokens = 0;
      };

      for (const msg of messages) {
        const msgTokens = estimateTokens(msg.text);
        if (currentTokens > 0 && currentTokens + msgTokens > maxTokens) {
          flushChunk();
        }
        currentTexts.push(msg.text);
        currentTokens += msgTokens;
      }

      flushChunk();
    }

    return chunks;
  },
};

// Auto-register on import
registerProvider(codexProvider);
