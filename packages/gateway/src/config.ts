/**
 * Gateway configuration — loaded from environment variables with sensible
 * defaults. No Zod, no file-based config — minimal @loreai/core dependency
 * (only `normalizeRemoteUrl` for git URL canonicalization).
 */

import { normalizeRemoteUrl } from "@loreai/core";

// ---------------------------------------------------------------------------
// Port defaults
// ---------------------------------------------------------------------------

/**
 * Default port preference order when LORE_LISTEN_PORT is not set.
 *
 * - 3207: flip upside-down → 7=L, 0=O, 2=R, 3=E → LORE (calculator-word)
 * - 5673: T9 phone keypad → 5=L, 6=O, 7=R, 3=E → LORE
 */
export const DEFAULT_PORTS = [3207, 5673] as const;

/** The primary default port (first in the fallback chain). */
export const DEFAULT_PORT = DEFAULT_PORTS[0];

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Port to listen on. Default: 3207. Env: LORE_LISTEN_PORT */
  port: number;
  /** True when the port was explicitly set via LORE_LISTEN_PORT or --port. */
  portExplicit: boolean;
  /**
   * Hosts to bind to. Default: ["127.0.0.1"].
   * Env: LORE_LISTEN_HOST (comma-separated for multiple addresses).
   * CLI: --host (can be specified multiple times, or comma-separated).
   */
  hosts: string[];
  /** Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC */
  upstreamAnthropic: string;
  /** Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI */
  upstreamOpenAI: string;
  /** Idle timeout in seconds before triggering background work. Default: 60 */
  idleTimeoutSeconds: number;
  /** Whether to log requests. Default: false. Env: LORE_DEBUG */
  debug: boolean;
  /** Remote gateway URL. When set, `lore run` delegates to this gateway instead of starting a local one. Env: LORE_REMOTE_URL */
  remoteUrl?: string;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/** Load gateway configuration from environment variables with defaults. */
export function loadConfig(): GatewayConfig {
  const env = process.env;
  return {
    port: parsePort(env.LORE_LISTEN_PORT, DEFAULT_PORT),
    portExplicit: !!env.LORE_LISTEN_PORT,
    hosts: parseHosts(env.LORE_LISTEN_HOST),
    upstreamAnthropic: trimTrailingSlash(
      env.LORE_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
    ),
    upstreamOpenAI: trimTrailingSlash(
      env.LORE_UPSTREAM_OPENAI || "https://api.openai.com",
    ),
    idleTimeoutSeconds: parsePositiveInt(env.LORE_IDLE_TIMEOUT, 60),
    debug: isTruthy(env.LORE_DEBUG),
    remoteUrl: env.LORE_REMOTE_URL
      ? trimTrailingSlash(env.LORE_REMOTE_URL)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Upstream routing — model name → provider URL + protocol
// ---------------------------------------------------------------------------

export type UpstreamRoute = {
  url: string;
  protocol: "anthropic" | "openai" | "openai-responses";
};

/**
 * Model prefix → upstream provider routing table.
 *
 * Ordered from most-specific to most-general so that e.g. `claude-3-5-haiku`
 * matches `claude-` before any catch-all. Unknown models fall back to the
 * env-var-configured defaults.
 */
const UPSTREAM_ROUTES: Array<{ prefix: string; url: string; protocol: "anthropic" | "openai" | "openai-responses" }> = [
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
  // CLAUDE.md / AGENTS.md / .lore.md file path → take the directory
  /(\/(?:home|Users)\/[^\s"',]+)\/(?:CLAUDE|AGENTS|\.lore)\.md/,
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

export type ProjectPathSource = "header" | "inferred" | "cwd";

export type ProjectPathResult = {
  path: string;
  source: ProjectPathSource;
  /** Normalized git remote URL from `X-Lore-Git-Remote` header, if provided. */
  gitRemote?: string;
};

/**
 * Resolve the project path for a request. Checks in order:
 *  1. `X-Lore-Project` header (explicit override)
 *  2. `inferProjectPath(systemPrompt)` (zero-config extraction)
 *  3. `process.cwd()` (last resort fallback)
 *
 * Returns a `{ path, source }` tuple so callers can distinguish a
 * successful resolution from a cwd fallback and take corrective action
 * (e.g. upgrading from session-cached state).
 *
 * NOTE: The cwd fallback does NOT log a warning — callers are responsible
 * for logging after any post-hoc upgrades (e.g. from session state) so
 * the warning only fires when the fallback truly sticks.
 */
export function getProjectPath(
  systemPrompt: string,
  headers: Record<string, string>,
): ProjectPathResult {
  // Extract git remote from header (independent of path resolution).
  const gitRemote = extractGitRemoteHeader(headers);

  // 1. Explicit header override
  const headerPath = headers["x-lore-project"];
  if (headerPath) return { path: headerPath, source: "header", gitRemote };

  // 2. Infer from system prompt content
  const inferred = inferProjectPath(systemPrompt);
  if (inferred) return { path: inferred, source: "inferred", gitRemote };

  // 3. Fall back to gateway's own cwd
  return { path: process.cwd(), source: "cwd", gitRemote };
}

// ---------------------------------------------------------------------------
// Git remote header extraction
// ---------------------------------------------------------------------------

/** Maximum allowed length for a git remote header value. */
const MAX_GIT_REMOTE_LENGTH = 512;

/**
 * Extract and validate the `X-Lore-Git-Remote` header from a request.
 * Normalizes SSH/HTTPS/git:// variants to a canonical form and strips
 * any control characters (prevents header injection via crafted remote URLs).
 * Returns `undefined` when the header is absent or invalid.
 */
export function extractGitRemoteHeader(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers["x-lore-git-remote"];
  if (!raw) return undefined;

  // Strip control characters (newlines, carriage returns, null bytes) to
  // prevent header injection and DB corruption.
  const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!sanitized || sanitized.length > MAX_GIT_REMOTE_LENGTH) return undefined;

  return normalizeRemoteUrl(sanitized);
}

// ---------------------------------------------------------------------------
// Helpers (not exported — internal only)
// ---------------------------------------------------------------------------

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) {
    console.error(
      `[lore] warning: invalid port "${value}", using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(
      `[lore] warning: invalid value "${value}", using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parseHosts(value: string | undefined): string[] {
  if (!value) return ["127.0.0.1"];
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length ? hosts : ["127.0.0.1"];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
