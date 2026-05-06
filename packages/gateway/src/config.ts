/**
 * Gateway configuration — loaded from environment variables with sensible
 * defaults. No Zod, no file-based config, no @loreai/core dependency.
 */

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Port to listen on. Default: 6969. Env: LORE_LISTEN_PORT */
  port: number;
  /** Host to bind to. Default: "127.0.0.1". Env: LORE_LISTEN_HOST */
  host: string;
  /** Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC */
  upstreamAnthropic: string;
  /** Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI */
  upstreamOpenAI: string;
  /** Idle timeout in seconds before triggering background work. Default: 60 */
  idleTimeoutSeconds: number;
  /** Whether to log requests. Default: false. Env: LORE_DEBUG */
  debug: boolean;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/** Load gateway configuration from environment variables with defaults. */
export function loadConfig(): GatewayConfig {
  const env = process.env;
  return {
    port: parsePort(env.LORE_LISTEN_PORT, 6969),
    host: env.LORE_LISTEN_HOST || "127.0.0.1",
    upstreamAnthropic: trimTrailingSlash(
      env.LORE_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
    ),
    upstreamOpenAI: trimTrailingSlash(
      env.LORE_UPSTREAM_OPENAI || "https://api.openai.com",
    ),
    idleTimeoutSeconds: parsePositiveInt(env.LORE_IDLE_TIMEOUT, 60),
    debug: isTruthy(env.LORE_DEBUG),
  };
}

// ---------------------------------------------------------------------------
// Upstream routing — model name → provider URL + protocol
// ---------------------------------------------------------------------------

export type UpstreamRoute = {
  url: string;
  protocol: "anthropic" | "openai";
};

/**
 * Model prefix → upstream provider routing table.
 *
 * Ordered from most-specific to most-general so that e.g. `claude-3-5-haiku`
 * matches `claude-` before any catch-all. Unknown models fall back to the
 * env-var-configured defaults.
 */
const UPSTREAM_ROUTES: Array<{ prefix: string; url: string; protocol: "anthropic" | "openai" }> = [
  // Anthropic
  { prefix: "claude-",        url: "https://api.anthropic.com",          protocol: "anthropic" },
  // Nvidia NIM
  { prefix: "nvidia/",        url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  { prefix: "meta/",          url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  { prefix: "mistralai/",     url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  { prefix: "google/",        url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  { prefix: "qwen/",          url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  { prefix: "deepseek/",      url: "https://integrate.api.nvidia.com",   protocol: "openai" },
  // OpenAI
  { prefix: "gpt-",           url: "https://api.openai.com",             protocol: "openai" },
  { prefix: "o1-",            url: "https://api.openai.com",             protocol: "openai" },
  { prefix: "o3-",            url: "https://api.openai.com",             protocol: "openai" },
  { prefix: "o4-",            url: "https://api.openai.com",             protocol: "openai" },
  // xAI
  { prefix: "grok-",          url: "https://api.x.ai",                   protocol: "openai" },
  // Mistral (direct)
  { prefix: "mistral-",       url: "https://api.mistral.ai",             protocol: "openai" },
  { prefix: "codestral-",     url: "https://api.mistral.ai",             protocol: "openai" },
  // Google (direct)
  { prefix: "gemini-",        url: "https://generativelanguage.googleapis.com", protocol: "openai" },
];

/**
 * Resolve which upstream to use for a given model name.
 *
 * Returns the inferred route, or null if the model doesn't match any known
 * prefix (caller should fall back to env-var-configured defaults).
 */
export function resolveUpstreamRoute(model: string): UpstreamRoute | null {
  for (const route of UPSTREAM_ROUTES) {
    if (model.startsWith(route.prefix)) {
      return { url: route.url, protocol: route.protocol };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Project path inference
// ---------------------------------------------------------------------------

/**
 * Regex patterns to extract an absolute project path from a system prompt.
 *
 * Claude Code embeds absolute paths in several places:
 *  - CLAUDE.md content references (`/home/user/project/CLAUDE.md`)
 *  - Tool definitions mention cwd (`"cwd": "/home/user/project"`)
 *  - Working directory lines (`Working directory: /Users/…/project`)
 *
 * Each pattern captures the directory portion (no trailing filename when
 * possible). Ordered from most-specific to most-general.
 */
const PROJECT_PATH_PATTERNS: RegExp[] = [
  // "cwd": "/home/…/project" or "cwd":"/Users/…/project" (JSON-style)
  /["']?cwd["']?\s*[:=]\s*["']?(\/(?:home|Users)\/[^\s"',}]+)/,
  // Working directory: /home/user/project
  /[Ww]orking\s+directory[:=]\s*(\/(?:home|Users)\/[^\s"',]+)/,
  // CLAUDE.md / AGENTS.md file path → take the directory
  /(\/(?:home|Users)\/[^\s"',]+)\/(?:CLAUDE|AGENTS)\.md/,
  // Generic absolute path starting with /home/ or /Users/ — first occurrence
  // Captures until whitespace, quote, comma, or bracket.
  /(\/(?:home|Users)\/[\w./-]+)/,
];

/**
 * Try to extract a project path from the system prompt content.
 *
 * Claude Code includes absolute paths in its system prompt (CLAUDE.md
 * content, tool definitions, working directory references). Returns the
 * extracted path or `null` if nothing looks like a project directory.
 */
export function inferProjectPath(systemPrompt: string): string | null {
  for (const pattern of PROJECT_PATH_PATTERNS) {
    const match = pattern.exec(systemPrompt);
    if (match?.[1]) {
      // Strip trailing slashes for consistency
      return match[1].replace(/\/+$/, "") || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// getProjectPath
// ---------------------------------------------------------------------------

/**
 * Resolve the project path for a request. Checks in order:
 *  1. `X-Lore-Project` header (explicit override)
 *  2. `inferProjectPath(systemPrompt)` (zero-config extraction)
 *  3. `process.cwd()` (last resort fallback)
 */
export function getProjectPath(
  systemPrompt: string,
  headers: Record<string, string>,
): string {
  // 1. Explicit header override
  const headerPath = headers["x-lore-project"];
  if (headerPath) return headerPath;

  // 2. Infer from system prompt content
  const inferred = inferProjectPath(systemPrompt);
  if (inferred) return inferred;

  // 3. Fall back to gateway's own cwd
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Helpers (not exported — internal only)
// ---------------------------------------------------------------------------

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
