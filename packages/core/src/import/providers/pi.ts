/**
 * Pi coding agent conversation history provider.
 *
 * Reads JSONL session files from ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
 *
 * CWD encoding: "--<cwd-with-slashes-replaced-by-dashes>--"
 * e.g. /home/byk/Code/foo → --home-byk-Code-foo--
 *
 * Pi uses a tree-structured session format where each entry has id/parentId.
 * We reconstruct the linear conversation by following the chain from root to
 * the latest leaf.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PI_DIR = join(homedir(), ".pi", "agent", "sessions");
const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// ---------------------------------------------------------------------------
// JSONL types (only the fields we read)
// ---------------------------------------------------------------------------

type PiLine =
  | {
      type: "session";
      id: string;
      timestamp: string;
      cwd: string;
      version?: number;
    }
  | {
      type: "message";
      id: string;
      parentId: string;
      timestamp: string;
      message: {
        role: "user" | "assistant";
        content: string;
        provider?: string;
        model?: string;
      };
    }
  | {
      type: "compaction";
      id: string;
      parentId: string;
      summary: string;
    }
  | {
      type: "custom" | "custom_message";
      id: string;
      parentId: string;
      customType?: string;
      content?: string;
    }
  | {
      type: string;
      id?: string;
      parentId?: string;
      timestamp?: string;
    };

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
 * Encode a CWD path to Pi's directory naming convention.
 * /home/byk/Code/foo → --home-byk-Code-foo--
 */
function encodeCwd(cwd: string): string {
  // Remove leading slash, replace remaining slashes with dashes
  const encoded = cwd.replace(/^\//, "").replace(/\//g, "-");
  return `--${encoded}--`;
}

/** Parse a JSONL file into typed lines. */
function parseJSONL(filePath: string): PiLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines: PiLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as PiLine);
    } catch {
      // Skip malformed
    }
  }
  return lines;
}

/**
 * Reconstruct the linear conversation from tree-structured entries.
 *
 * Pi sessions use a tree structure where each entry has id/parentId.
 * Multiple branches can exist (e.g. user edits a message, creating a fork).
 * We follow the longest path from root to the latest leaf to get the
 * "main" conversation thread.
 */
function linearize(lines: PiLine[]): PiLine[] {
  if (lines.length === 0) return [];

  // Build adjacency map: parentId → children
  const children = new Map<string, PiLine[]>();
  const byId = new Map<string, PiLine>();
  let rootLine: PiLine | null = null;

  for (const line of lines) {
    if (line.type === "session") {
      rootLine = line;
      continue;
    }

    if (!line.id) continue;
    byId.set(line.id, line);

    const pid = (line as { parentId?: string }).parentId;
    if (pid) {
      const siblings = children.get(pid) ?? [];
      siblings.push(line);
      children.set(pid, siblings);
    }
  }

  if (!rootLine || !rootLine.id) return lines.filter((l) => l.type === "message");

  // Walk from root, always picking the child with the latest timestamp
  // (or the last one appended if timestamps are equal)
  const result: PiLine[] = [];
  let currentId: string | undefined = rootLine.id;

  while (currentId) {
    const kids = children.get(currentId);
    if (!kids || kids.length === 0) break;

    // Pick the last child (append-only means last is most recent on the main branch)
    const next = kids[kids.length - 1];
    result.push(next);
    currentId = next.id;
  }

  return result;
}

/** Get session metadata from a JSONL file. */
function getSessionMeta(
  filePath: string,
): {
  id: string;
  cwd: string;
  timestamp: number;
  messageCount: number;
  fileSize: number;
} | null {
  const lines = parseJSONL(filePath);
  if (lines.length === 0) return null;

  const header = lines[0];
  if (header.type !== "session") return null;
  const session = header as Extract<PiLine, { type: "session" }>;

  const messageCount = lines.filter((l) => l.type === "message").length;
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    fileSize = 0;
  }

  const ts = new Date(session.timestamp).getTime();

  return {
    id: session.id,
    cwd: session.cwd,
    timestamp: Number.isNaN(ts) ? Date.now() : ts,
    messageCount,
    fileSize,
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const piProvider: AgentHistoryProvider = {
  name: "pi",
  displayName: "Pi",

  detect(projectPath: string): DetectedSession[] {
    const encoded = encodeCwd(projectPath);
    const dir = join(PI_DIR, encoded);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return []; // Directory doesn't exist
    }

    const sessions: DetectedSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;

      const filePath = join(dir, entry);
      const meta = getSessionMeta(filePath);
      if (!meta) continue;

      // Skip trivially small sessions
      if (meta.messageCount < 3) continue;

      const dateStr = new Date(meta.timestamp).toISOString().slice(0, 10);
      const estimatedTokens = Math.ceil(meta.fileSize / 5);

      sessions.push({
        id: filePath,
        label: `${dateStr} (${meta.messageCount} messages)`,
        startedAt: meta.timestamp,
        lastActivityAt: meta.timestamp,
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
      const allLines = parseJSONL(filePath);
      const linearLines = linearize(allLines);

      // Find session timestamp for labeling
      let sessionTimestamp = Date.now();
      const header = allLines.find((l) => l.type === "session");
      if (header?.type === "session") {
        const session = header as Extract<PiLine, { type: "session" }>;
        const ts = new Date(session.timestamp).getTime();
        if (!Number.isNaN(ts)) sessionTimestamp = ts;
      }

      const messages: { text: string; timestamp: number }[] = [];

      for (const line of linearLines) {
        if (line.type === "message") {
          const msg = line as Extract<PiLine, { type: "message" }>;
          const content = msg.message.content;
          if (!content) continue;

          const ts = new Date(msg.timestamp).getTime();
          messages.push({
            text: `[${msg.message.role}] ${content}`,
            timestamp: Number.isNaN(ts) ? sessionTimestamp : ts,
          });
        } else if (line.type === "compaction") {
          const comp = line as Extract<PiLine, { type: "compaction" }>;
          if (comp.summary) {
            messages.push({
              text: `[summary] ${truncate(comp.summary, MAX_TOOL_OUTPUT_CHARS * 2)}`,
              timestamp: sessionTimestamp,
            });
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
          label: `Pi ${new Date(sessionTimestamp).toISOString().slice(0, 10)} (${chunkIndex})`,
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
registerProvider(piProvider);
