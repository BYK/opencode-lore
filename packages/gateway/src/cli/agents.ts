/**
 * Agent registry — known AI coding agents that can be launched through
 * the gateway.
 *
 * Each agent defines:
 *  - How to detect it (binary name on PATH)
 *  - What env vars to set so it talks through the gateway
 */

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
  /** Env vars to inject given the gateway URL (e.g. "http://127.0.0.1:6969") */
  envVars: (gatewayUrl: string) => Record<string, string>;
}

export const AGENTS: AgentDef[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binary: "claude",
    detect: () => which("claude"),
    envVars: (url) => ({
      ANTHROPIC_BASE_URL: url,
      DISABLE_AUTO_COMPACT: "1",
    }),
  },
  {
    name: "codex",
    displayName: "Codex",
    binary: "codex",
    detect: () => which("codex"),
    envVars: (url) => ({ OPENAI_BASE_URL: `${url}/v1` }),
  },
  {
    name: "pi",
    displayName: "Pi",
    binary: "pi",
    detect: () => which("pi"),
    envVars: (url) => ({ ANTHROPIC_BASE_URL: url, LORE_GATEWAY_URL: url }),
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    detect: () => which("opencode"),
    envVars: (url) => ({ OPENAI_BASE_URL: `${url}/v1` }),
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
