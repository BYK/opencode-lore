/**
 * Aider conversation history provider.
 *
 * Reads from Aider's per-project chat history file:
 *   <project-dir>/.aider.chat.history.md
 *
 * Format: Markdown with role headers like "#### user" / "#### assistant"
 * separated by horizontal rules (---).
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_FILE = ".aider.chat.history.md";
const DEFAULT_MAX_TOKENS = 12288;

// Aider uses "#### role" headers and "---" separators
const ROLE_HEADER_RE = /^####\s+(user|assistant|system)\s*$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

type ParsedMessage = {
  role: string;
  text: string;
};

/**
 * Parse Aider's markdown chat history into messages.
 *
 * Format:
 * ```
 * #### user
 * message text here
 *
 * #### assistant
 * response text here
 * ```
 *
 * Messages are separated by `---` or by new `#### role` headers.
 */
function parseAiderHistory(content: string): ParsedMessage[] {
  const lines = content.split("\n");
  const messages: ParsedMessage[] = [];
  let currentRole: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRole && currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text) {
        messages.push({ role: currentRole, text });
      }
    }
    currentLines = [];
  };

  for (const line of lines) {
    // Check for role header
    const match = ROLE_HEADER_RE.exec(line);
    if (match) {
      flush();
      currentRole = match[1].toLowerCase();
      continue;
    }

    // Check for separator — starts a new conversation turn
    if (line.trim() === "---") {
      flush();
      currentRole = null;
      continue;
    }

    // Accumulate content if we're in a message
    if (currentRole) {
      currentLines.push(line);
    }
  }

  // Flush final message
  flush();

  return messages;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const aiderProvider: AgentHistoryProvider = {
  name: "aider",
  displayName: "Aider",

  detect(projectPath: string): DetectedSession[] {
    const filePath = join(projectPath, HISTORY_FILE);
    if (!existsSync(filePath)) return [];

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return [];
    }

    if (!stat.isFile() || stat.size === 0) return [];

    // Quick scan to count messages without full parsing
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    const messages = parseAiderHistory(content);
    if (messages.length < 3) return [];

    const estimatedTokens = estimateTokens(content);

    return [
      {
        id: filePath,
        label: `Chat history (${messages.length} messages, ${Math.round(stat.size / 1024)}KB)`,
        startedAt: stat.birthtimeMs || stat.ctimeMs,
        lastActivityAt: stat.mtimeMs,
        estimatedTokens,
        messageCount: messages.length,
      },
    ];
  },

  readChunks(
    projectPath: string,
    sessionIds: string[],
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): ConversationChunk[] {
    const chunks: ConversationChunk[] = [];

    for (const filePath of sessionIds) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const messages = parseAiderHistory(content);
      if (messages.length === 0) continue;

      // Get file mtime for timestamp
      let fileTimestamp: number;
      try {
        fileTimestamp = statSync(filePath).mtimeMs;
      } catch {
        fileTimestamp = Date.now();
      }

      // Build chunks respecting maxTokens boundaries
      let currentTexts: string[] = [];
      let currentTokens = 0;
      let chunkIndex = 0;

      const flushChunk = () => {
        if (currentTexts.length === 0) return;
        chunkIndex++;
        const text = currentTexts.join("\n\n");
        chunks.push({
          label: `Aider history (${chunkIndex})`,
          text,
          estimatedTokens: estimateTokens(text),
          timestamp: fileTimestamp,
        });
        currentTexts = [];
        currentTokens = 0;
      };

      for (const msg of messages) {
        const formatted = `[${msg.role}] ${msg.text}`;
        const msgTokens = estimateTokens(formatted);

        if (currentTokens > 0 && currentTokens + msgTokens > maxTokens) {
          flushChunk();
        }

        currentTexts.push(formatted);
        currentTokens += msgTokens;
      }

      flushChunk();
    }

    return chunks;
  },
};

// Auto-register on import
registerProvider(aiderProvider);
