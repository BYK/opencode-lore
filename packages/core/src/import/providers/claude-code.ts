/**
 * Claude Code conversation history provider.
 *
 * Reads JSONL session files from ~/.claude/projects/<mangled-path>/<uuid>.jsonl
 * Path mangling: project path with "/" replaced by "-"
 *   e.g. /home/byk/Code/foo → -home-byk-Code-foo
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// JSONL line types (only the fields we read)
// ---------------------------------------------------------------------------

type ClaudeCodeLine =
  | {
      type: "user";
      message: { role: "user"; content: string | ContentBlock[] };
      uuid: string;
      timestamp: string;
      sessionId: string;
    }
  | {
      type: "assistant";
      message: {
        role: "assistant";
        content: ContentBlock[];
        model?: string;
      };
      uuid: string;
      timestamp: string;
      sessionId: string;
    }
  | { type: string; timestamp?: string; sessionId?: string };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] }
  | { type: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), ".claude", "projects");
const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mangle a project path for Claude Code's directory naming. */
function manglePath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

/** Estimate tokens from text length. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Truncate text to a max length, appending "..." if truncated. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/** Extract text content from a single content block. */
function blockToText(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return (block as { type: "text"; text: string }).text;
    case "tool_use": {
      const tu = block as { type: "tool_use"; name: string; input: Record<string, unknown> };
      // Summarize tool input compactly
      const inputSummary = truncate(JSON.stringify(tu.input), MAX_TOOL_OUTPUT_CHARS);
      return `[tool: ${tu.name}] ${inputSummary}`;
    }
    case "tool_result": {
      const tr = block as {
        type: "tool_result";
        content: string | ContentBlock[];
      };
      let content: string;
      if (typeof tr.content === "string") {
        content = tr.content;
      } else if (Array.isArray(tr.content)) {
        content = tr.content
          .map((b) => {
            if (b.type === "text") return (b as { type: "text"; text: string }).text;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      } else {
        content = "";
      }
      return content ? `[tool_result] ${truncate(content, MAX_TOOL_OUTPUT_CHARS)}` : null;
    }
    case "thinking":
      // Skip thinking/reasoning blocks entirely
      return null;
    default:
      return null;
  }
}

/** Extract conversation text from a parsed JSONL line. */
function lineToText(parsed: ClaudeCodeLine): string | null {
  if (parsed.type === "user") {
    const msg = parsed as Extract<ClaudeCodeLine, { type: "user" }>;
    const content = msg.message.content;
    if (typeof content === "string") {
      return `[user] ${content}`;
    }
    // Array content — extract text blocks, tool_result blocks
    const parts = (content as ContentBlock[])
      .map(blockToText)
      .filter(Boolean) as string[];
    return parts.length > 0 ? `[user] ${parts.join("\n")}` : null;
  }

  if (parsed.type === "assistant") {
    const msg = parsed as Extract<ClaudeCodeLine, { type: "assistant" }>;
    const blocks = msg.message.content;
    if (!Array.isArray(blocks)) return null;
    const parts = blocks.map(blockToText).filter(Boolean) as string[];
    return parts.length > 0 ? `[assistant] ${parts.join("\n")}` : null;
  }

  return null;
}

/** Parse a JSONL file into typed lines, skipping malformed lines. */
function parseJSONL(filePath: string): ClaudeCodeLine[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines: ClaudeCodeLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as ClaudeCodeLine);
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/**
 * Get metadata from a session file without reading the full contents.
 * Reads first and last few lines for timestamps and session ID.
 */
function getSessionMetadata(
  filePath: string,
): {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  estimatedTokens: number;
} | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  let sessionId: string | undefined;
  let startedAt = Infinity;
  let lastActivityAt = 0;
  let messageCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeLine;
      if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId;

      if (parsed.timestamp) {
        const ts = new Date(parsed.timestamp).getTime();
        if (!Number.isNaN(ts)) {
          if (ts < startedAt) startedAt = ts;
          if (ts > lastActivityAt) lastActivityAt = ts;
        }
      }

      if (parsed.type === "user" || parsed.type === "assistant") {
        messageCount++;
      }
    } catch {
      // Skip malformed
    }
  }

  if (!sessionId || messageCount === 0) return null;

  // Estimate tokens from file size (rough: ~3 chars per token, but JSONL
  // has structural overhead so use ~5 chars per token for files)
  const fileSize = raw.length;
  const estimatedTokens = Math.ceil(fileSize / 5);

  return {
    sessionId,
    startedAt: startedAt === Infinity ? Date.now() : startedAt,
    lastActivityAt,
    messageCount,
    estimatedTokens,
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const claudeCodeProvider: AgentHistoryProvider = {
  name: "claude-code",
  displayName: "Claude Code",

  detect(projectPath: string): DetectedSession[] {
    const mangled = manglePath(projectPath);
    const dir = join(CLAUDE_DIR, mangled);

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
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const meta = getSessionMetadata(filePath);
      if (!meta) continue;

      // Skip trivially small sessions (< 3 messages)
      if (meta.messageCount < 3) continue;

      const dateStr = new Date(meta.startedAt).toISOString().slice(0, 10);
      sessions.push({
        id: filePath,
        label: `${dateStr} (${meta.messageCount} messages)`,
        startedAt: meta.startedAt,
        lastActivityAt: meta.lastActivityAt,
        estimatedTokens: meta.estimatedTokens,
        messageCount: meta.messageCount,
      });
    }

    // Sort by most recent first
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

      // Extract conversation messages as text
      const messages: { text: string; timestamp: number }[] = [];
      for (const line of lines) {
        const text = lineToText(line);
        if (!text) continue;

        const ts = "timestamp" in line && line.timestamp
          ? new Date(line.timestamp as string).getTime()
          : Date.now();

        messages.push({ text, timestamp: ts });
      }

      if (messages.length === 0) continue;

      // Build chunks respecting maxTokens boundaries
      let currentTexts: string[] = [];
      let currentTokens = 0;
      let chunkStart = messages[0].timestamp;
      let chunkIndex = 0;

      const flushChunk = () => {
        if (currentTexts.length === 0) return;
        chunkIndex++;
        const text = currentTexts.join("\n\n");
        chunks.push({
          label: `Claude Code ${new Date(chunkStart).toISOString().slice(0, 10)} (${chunkIndex})`,
          text,
          estimatedTokens: estimateTokens(text),
          timestamp: chunkStart,
        });
        currentTexts = [];
        currentTokens = 0;
      };

      for (const msg of messages) {
        const msgTokens = estimateTokens(msg.text);

        // If adding this message would exceed the limit, flush first
        if (currentTokens > 0 && currentTokens + msgTokens > maxTokens) {
          flushChunk();
          chunkStart = msg.timestamp;
        }

        currentTexts.push(msg.text);
        currentTokens += msgTokens;
      }

      // Flush remaining
      flushChunk();
    }

    return chunks;
  },
};

// Auto-register on import
registerProvider(claudeCodeProvider);
