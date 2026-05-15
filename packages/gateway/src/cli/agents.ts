/**
 * Agent registry — known AI coding agents that can be launched through
 * the gateway.
 *
 * Each agent defines:
 *  - How to detect it (binary name on PATH)
 *  - What env vars to set so it talks through the gateway
 */
import { getGitRemote } from "@loreai/core";

// ---------------------------------------------------------------------------
// which() — cross-runtime binary lookup
// ---------------------------------------------------------------------------

/**
 * Find a binary on PATH. Uses Bun.which() when available (Bun runtime),
 * falls back to `which`/`where` via child_process (Node.js runtime).
 */
function which(binary: string): string | null {
  // Bun runtime
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(binary);
  }

  // Node.js runtime
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [binary], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const path = result.trim().split("\n")[0];
    return path || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface AgentDef {
  /** Internal identifier, e.g. "claude-code" */
  name: string;
  /** Human-readable name, e.g. "Claude Code" */
  displayName: string;
  /** Binary to search for on PATH */
  binary: string;
  /** Returns the binary path if found, or null */
  detect: () => string | null;
  /** Env vars to inject given the gateway URL (e.g. "http://127.0.0.1:3207") and project cwd */
  envVars: (gatewayUrl: string, cwd: string) => Record<string, string>;
}

/**
 * Sanitize a git remote URL for safe embedding in env vars / headers.
 * Strips control characters to prevent injection attacks.
 */
function safeRemote(cwd: string): string | null {
  const remote = getGitRemote(cwd);
  if (!remote) return null;
  return remote.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Append a header to ANTHROPIC_CUSTOM_HEADERS (curl-style format:
 * "Name: Value" newline-separated).
 */
function appendCustomHeader(
  env: Record<string, string>,
  envKey: string,
  name: string,
  value: string,
): void {
  const existing = process.env[envKey] ?? "";
  const header = `${name}: ${value}`;
  env[envKey] = existing ? `${existing}\n${header}` : header;
}

export const AGENTS: AgentDef[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binary: "claude",
    detect: () => which("claude"),
    envVars: (url, cwd) => {
      const env: Record<string, string> = {
        ANTHROPIC_BASE_URL: url,
        DISABLE_AUTO_COMPACT: "1",
      };
      // Inject git remote via ANTHROPIC_CUSTOM_HEADERS so the remote gateway
      // can identify the project by git remote without filesystem access.
      const remote = safeRemote(cwd);
      if (remote) {
        appendCustomHeader(env, "ANTHROPIC_CUSTOM_HEADERS", "X-Lore-Git-Remote", remote);
      }
      return env;
    },
  },
  {
    name: "codex",
    displayName: "Codex",
    binary: "codex",
    detect: () => which("codex"),
    envVars: (url, cwd) => {
      const env: Record<string, string> = { OPENAI_BASE_URL: `${url}/v1` };
      // Codex supports custom headers via env_http_headers config (since 0.3.0).
      // Set LORE_GIT_REMOTE so users can map it in their config.toml:
      //   [model_provider.custom.env_http_headers]
      //   X-Lore-Git-Remote = "LORE_GIT_REMOTE"
      const remote = safeRemote(cwd);
      if (remote) env.LORE_GIT_REMOTE = remote;
      return env;
    },
  },
  {
    name: "pi",
    displayName: "Pi",
    binary: "pi",
    detect: () => which("pi"),
    envVars: (url, _cwd) => ({
      ANTHROPIC_BASE_URL: url,
      LORE_GATEWAY_URL: url,
      // Pi's @loreai/pi extension handles git remote header injection
      // via registerProviders() when LORE_GATEWAY_URL is set.
    }),
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    detect: () => which("opencode"),
    envVars: (url, _cwd) => ({
      OPENAI_BASE_URL: `${url}/v1`,
      // OpenCode's @loreai/opencode plugin handles git remote header
      // injection via chat.headers hook.
    }),
  },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectedAgent {
  def: AgentDef;
  path: string;
}

/**
 * Scan PATH for all known agents. Returns the ones found with their
 * binary paths.
 */
export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const def of AGENTS) {
    const path = def.detect();
    if (path) found.push({ def, path });
  }
  return found;
}
