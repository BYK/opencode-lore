/**
 * Cline (VS Code extension) conversation history provider.
 *
 * Reads JSON task files from VS Code's globalStorage for the Cline extension:
 *   ~/.vscode/data/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/
 *
 * Each task directory contains:
 *   - api_conversation_history.json — Anthropic MessageParam[] format
 *   - task_metadata.json — optional metadata
 *
 * The task history index at:
 *   globalStorage/saoudrizwan.claude-dev/state/taskHistory.json
 * maps tasks to their CWD (cwdOnTaskInitialization).
 */
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentHistoryProvider, ConversationChunk, DetectedSession } from "../types";
import { registerProvider } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT_CHARS = 500;
const DEFAULT_MAX_TOKENS = 12288;

// Extension IDs — Cline has been published under multiple IDs
const EXTENSION_IDS = [
  "saoudrizwan.claude-dev",
  "cline.cline",
];

// ---------------------------------------------------------------------------
// Types (Cline's Anthropic-compatible format)
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] }
  | { type: "image"; source?: unknown }
  | { type: string };

type ClineMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

type TaskHistoryItem = {
  id: string;
  ts: number;
  task: string;
  tokensIn?: number;
  tokensOut?: number;
  totalCost?: number;
  cwdOnTaskInitialization?: string;
  modelId?: string;
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
 * Find the VS Code globalStorage directories to search.
 * Checks multiple VS Code variants (stable, insiders, OSS) and extension IDs.
 */
function findGlobalStorageDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  // VS Code storage paths by platform
  const basePaths: string[] = [];
  const platform = process.platform;

  if (platform === "darwin") {
    basePaths.push(
      join(home, "Library", "Application Support", "Code", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Code - Insiders", "User", "globalStorage"),
      join(home, "Library", "Application Support", "VSCodium", "User", "globalStorage"),
    );
  } else if (platform === "win32") {
    const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
    basePaths.push(
      join(appdata, "Code", "User", "globalStorage"),
      join(appdata, "Code - Insiders", "User", "globalStorage"),
      join(appdata, "VSCodium", "User", "globalStorage"),
    );
  } else {
    // Linux
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    basePaths.push(
      join(configHome, "Code", "User", "globalStorage"),
      join(configHome, "Code - Insiders", "User", "globalStorage"),
      join(configHome, "VSCodium", "User", "globalStorage"),
    );
    // Also check the older data path
    basePaths.push(
      join(home, ".vscode", "data", "User", "globalStorage"),
      join(home, ".vscode-insiders", "data", "User", "globalStorage"),
    );
  }

  for (const base of basePaths) {
    for (const extId of EXTENSION_IDS) {
      const dir = join(base, extId);
      if (existsSync(dir)) dirs.push(dir);
    }
  }

  return dirs;
}

/** Load the task history index and filter by project CWD. */
function loadTaskHistory(
  storageDir: string,
  projectPath: string,
): TaskHistoryItem[] {
  // Try both known locations for the history file
  const paths = [
    join(storageDir, "state", "taskHistory.json"),
    join(storageDir, "taskHistory.json"),
  ];

  for (const historyPath of paths) {
    if (!existsSync(historyPath)) continue;

    try {
      const raw = readFileSync(historyPath, "utf-8");
      const items = JSON.parse(raw) as TaskHistoryItem[];
      if (!Array.isArray(items)) continue;

      return items.filter(
        (item) => item.cwdOnTaskInitialization === projectPath,
      );
    } catch {
      continue;
    }
  }

  return [];
}

/** Read the API conversation history for a task. */
function readConversation(taskDir: string): ClineMessage[] {
  const filePath = join(taskDir, "api_conversation_history.json");
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const messages = JSON.parse(raw) as ClineMessage[];
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/** Convert a content block to text. */
function blockToText(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return (block as { type: "text"; text: string }).text;
    case "tool_use": {
      const tu = block as { type: "tool_use"; name: string; input: Record<string, unknown> };
      return `[tool: ${tu.name}] ${truncate(JSON.stringify(tu.input), MAX_TOOL_OUTPUT_CHARS)}`;
    }
    case "tool_result": {
      const tr = block as { type: "tool_result"; content: string | ContentBlock[] };
      let content: string;
      if (typeof tr.content === "string") {
        content = tr.content;
      } else if (Array.isArray(tr.content)) {
        content = tr.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      } else {
        content = "";
      }
      return content ? `[tool_result] ${truncate(content, MAX_TOOL_OUTPUT_CHARS)}` : null;
    }
    default:
      return null;
  }
}

/** Convert a ClineMessage to text. */
function messageToText(msg: ClineMessage): string | null {
  if (typeof msg.content === "string") {
    return msg.content ? `[${msg.role}] ${msg.content}` : null;
  }

  const parts = (msg.content as ContentBlock[])
    .map(blockToText)
    .filter(Boolean) as string[];
  return parts.length > 0 ? `[${msg.role}] ${parts.join("\n")}` : null;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const clineProvider: AgentHistoryProvider = {
  name: "cline",
  displayName: "Cline",

  detect(projectPath: string): DetectedSession[] {
    const sessions: DetectedSession[] = [];
    const storageDirs = findGlobalStorageDirs();

    for (const storageDir of storageDirs) {
      const tasks = loadTaskHistory(storageDir, projectPath);

      for (const task of tasks) {
        const taskDir = join(storageDir, "tasks", task.id);
        if (!existsSync(taskDir)) continue;

        // Quick count of messages
        const messages = readConversation(taskDir);
        if (messages.length < 3) continue;

        const dateStr = new Date(task.ts).toISOString().slice(0, 10);
        const label = task.task
          ? `${dateStr} - ${truncate(task.task, 60)} (${messages.length} messages)`
          : `${dateStr} (${messages.length} messages)`;

        // Estimate tokens from file size
        const historyFile = join(taskDir, "api_conversation_history.json");
        let estimatedTokens = messages.length * 500;
        try {
          const stat = statSync(historyFile);
          estimatedTokens = Math.ceil(stat.size / 5);
        } catch {
          // Use the message-count-based estimate
        }

        sessions.push({
          id: taskDir,
          label,
          startedAt: task.ts,
          lastActivityAt: task.ts,
          estimatedTokens,
          messageCount: messages.length,
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

    for (const taskDir of sessionIds) {
      const messages = readConversation(taskDir);
      if (messages.length === 0) continue;

      // Get timestamp from directory stat
      let sessionTimestamp: number;
      try {
        sessionTimestamp = statSync(taskDir).mtimeMs;
      } catch {
        sessionTimestamp = Date.now();
      }

      const textMessages: { text: string }[] = [];
      for (const msg of messages) {
        const text = messageToText(msg);
        if (text) textMessages.push({ text });
      }

      if (textMessages.length === 0) continue;

      // Build chunks respecting maxTokens boundaries
      let currentTexts: string[] = [];
      let currentTokens = 0;
      let chunkIndex = 0;

      const flushChunk = () => {
        if (currentTexts.length === 0) return;
        chunkIndex++;
        const text = currentTexts.join("\n\n");
        chunks.push({
          label: `Cline ${new Date(sessionTimestamp).toISOString().slice(0, 10)} (${chunkIndex})`,
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
registerProvider(clineProvider);
