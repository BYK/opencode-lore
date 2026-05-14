/**
 * Continue (VS Code/JetBrains extension) conversation history provider.
 *
 * Reads JSON session files from ~/.continue/sessions/<sessionId>.json
 * with the sessions index at ~/.continue/sessions/sessions.json.
 *
 * Each session JSON contains:
 *   { sessionId, title, workspaceDirectory, history: ChatHistoryItem[] }
 *
 * The CONTINUE_GLOBAL_DIR env var overrides the default ~/.continue path.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// ---------------------------------------------------------------------------
// Types (Continue's format)
// ---------------------------------------------------------------------------

type SessionMetadata = {
  sessionId: string;
  title: string;
  dateCreated: string;
  workspaceDirectory?: string;
  messageCount?: number;
};

type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "imageUrl"; imageUrl?: { url: string } }
  | { type: string; [key: string]: unknown };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatHistoryItem = {
  message: ChatMessage;
  contextItems?: unknown[];
  toolCallStates?: Array<{
    toolCallId: string;
    status: string;
    output?: string;
  }>;
};

type SessionFile = {
  sessionId: string;
  title: string;
  workspaceDirectory?: string;
  history: ChatHistoryItem[];
  mode?: string;
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

/** Get the Continue global directory. */
function continueDir(): string {
  return process.env.CONTINUE_GLOBAL_DIR || join(homedir(), ".continue");
}

/** Load the sessions index. */
function loadSessionIndex(): SessionMetadata[] {
  const indexPath = join(continueDir(), "sessions", "sessions.json");
  if (!existsSync(indexPath)) return [];

  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Load a full session file. */
function loadSession(sessionId: string): SessionFile | null {
  const filePath = join(continueDir(), "sessions", `${sessionId}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
}

/** Extract text from a chat message's content. */
function extractMessageContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof (part as { text?: string }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Convert a ChatHistoryItem to text. */
function historyItemToText(item: ChatHistoryItem): string | null {
  const msg = item.message;
  if (!msg) return null;

  // Skip system messages
  if (msg.role === "system") return null;

  const parts: string[] = [];

  // Message content
  const content = extractMessageContent(msg.content);
  if (content) parts.push(content);

  // Tool calls (from assistant)
  if (msg.toolCalls) {
    for (const call of msg.toolCalls) {
      if (call.function) {
        const args = truncate(call.function.arguments || "{}", MAX_TOOL_OUTPUT_CHARS);
        parts.push(`[tool: ${call.function.name}] ${args}`);
      }
    }
  }

  // Tool call results
  if (item.toolCallStates) {
    for (const state of item.toolCallStates) {
      if (state.output && state.status === "done") {
        parts.push(`[tool_result] ${truncate(state.output, MAX_TOOL_OUTPUT_CHARS)}`);
      }
    }
  }

  if (parts.length === 0) return null;

  const role = msg.role === "tool" ? "tool_result" : msg.role;
  return `[${role}] ${parts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const continueProvider: AgentHistoryProvider = {
  name: "continue",
  displayName: "Continue",

  detect(projectPath: string): DetectedSession[] {
    const sessions: DetectedSession[] = [];
    const index = loadSessionIndex();

    for (const meta of index) {
      // Filter by workspace directory
      if (meta.workspaceDirectory !== projectPath) continue;

      // Load the full session to count messages
      const session = loadSession(meta.sessionId);
      if (!session || !session.history || session.history.length < 3) continue;

      const ts = new Date(meta.dateCreated).getTime();
      const dateStr = new Date(ts).toISOString().slice(0, 10);
      const messageCount = session.history.length;

      const label = meta.title
        ? `${dateStr} - ${truncate(meta.title, 60)} (${messageCount} messages)`
        : `${dateStr} (${messageCount} messages)`;

      // Estimate tokens
      const estimatedTokens = messageCount * 500;

      sessions.push({
        id: meta.sessionId,
        label,
        startedAt: ts,
        lastActivityAt: ts,
        estimatedTokens,
        messageCount,
      });
    }

    // Also scan for session files not in the index (some versions don't maintain it)
    const sessionsDir = join(continueDir(), "sessions");
    if (existsSync(sessionsDir)) {
      const existingIds = new Set(sessions.map((s) => s.id));
      let entries: string[];
      try {
        entries = readdirSync(sessionsDir);
      } catch {
        entries = [];
      }

      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry === "sessions.json") continue;
        const sessionId = entry.replace(".json", "");
        if (existingIds.has(sessionId)) continue;

        const session = loadSession(sessionId);
        if (!session) continue;
        if (session.workspaceDirectory !== projectPath) continue;
        if (!session.history || session.history.length < 3) continue;

        const dateStr = session.title ? truncate(session.title, 60) : sessionId.slice(0, 8);
        sessions.push({
          id: sessionId,
          label: `${dateStr} (${session.history.length} messages)`,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          estimatedTokens: session.history.length * 500,
          messageCount: session.history.length,
        });
      }
    }

    return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  },

  readChunks(
    _projectPath: string,
    sessionIds: string[],
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): ConversationChunk[] {
    const chunks: ConversationChunk[] = [];

    for (const sessionId of sessionIds) {
      const session = loadSession(sessionId);
      if (!session || !session.history) continue;

      const textMessages: { text: string }[] = [];
      for (const item of session.history) {
        const text = historyItemToText(item);
        if (text) textMessages.push({ text });
      }

      if (textMessages.length === 0) continue;

      // Session timestamp
      const sessionTimestamp = Date.now();

      // Build chunks respecting maxTokens boundaries
      let currentTexts: string[] = [];
      let currentTokens = 0;
      let chunkIndex = 0;

      const flushChunk = () => {
        if (currentTexts.length === 0) return;
        chunkIndex++;
        const text = currentTexts.join("\n\n");
        chunks.push({
          label: `Continue ${session.title || sessionId.slice(0, 8)} (${chunkIndex})`,
          text,
          estimatedTokens: estimateTokens(text),
          timestamp: sessionTimestamp,
        });
        currentTexts = [];
        currentTokens = 0;
      };

      for (const msg of textMessages) {
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
registerProvider(continueProvider);
