/**
 * git.ts — Git repository identification utilities.
 *
 * Extracts and normalizes git remote URLs to identify projects by their
 * repository identity rather than filesystem path. This enables:
 *  - Worktree awareness: main checkout and worktrees share one project
 *  - Clone deduplication: same repo cloned to different paths is one project
 *  - Fork awareness: prefers `upstream` remote to unify forks with their source
 *
 * Remote URL normalization strips protocol, auth, and `.git` suffix to produce
 * a stable canonical identifier (e.g. "github.com/user/repo") regardless of
 * how the remote was configured (SSH, HTTPS, git://).
 */

import { execSync } from "child_process";
import { isHostedMode } from "./hosted";

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a git remote URL to a canonical form for comparison.
 *
 * Strips protocol, auth, `.git` suffix, and normalizes SSH ↔ HTTPS
 * to produce a stable identifier regardless of how the remote was
 * configured.
 *
 * Examples:
 *   git@github.com:user/repo.git     → github.com/user/repo
 *   https://github.com/user/repo.git → github.com/user/repo
 *   ssh://git@github.com/user/repo   → github.com/user/repo
 *   git://github.com/user/repo.git   → github.com/user/repo
 *   https://user:token@github.com/user/repo → github.com/user/repo
 */
export function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim();

  // SSH shorthand: git@host:user/repo.git → host/user/repo
  const sshMatch = normalized.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // Strip protocol (https://, http://, ssh://, git://)
    normalized = normalized.replace(/^[\w+]+:\/\//, "");
    // Strip auth (user@, user:pass@)
    normalized = normalized.replace(/^[^@/]+@/, "");
  }

  // Strip .git suffix
  normalized = normalized.replace(/\.git$/, "");
  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  // Lowercase the host portion for case-insensitive comparison.
  // Host is everything before the first `/`.
  const slashIdx = normalized.indexOf("/");
  if (slashIdx > 0) {
    normalized =
      normalized.slice(0, slashIdx).toLowerCase() + normalized.slice(slashIdx);
  } else {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Remote extraction
// ---------------------------------------------------------------------------

/**
 * In-memory cache for git remote lookups. Keyed by absolute path, values are
 * normalized remote URLs (or null for non-git directories). Prevents repeated
 * subprocess spawns for the same path within a single process lifetime.
 */
const gitRemoteCache = new Map<string, string | null>();

/**
 * Clear the in-memory git remote cache.
 *
 * Intended for test harnesses that need deterministic behavior across
 * test cases without leaking cached results.
 */
export function clearGitRemoteCache(): void {
  gitRemoteCache.clear();
}

/**
 * Get the canonical git remote URL for a repository at the given path.
 *
 * Prefers `upstream` remote (for forks) over `origin`, then falls back
 * to any other remote. Returns null if the path is not in a git repo
 * or has no remotes configured.
 *
 * Results are cached in-memory for the process lifetime to avoid repeated
 * subprocess calls — `git remote -v` only runs once per unique path.
 */
export function getGitRemote(path: string): string | null {
  // In hosted mode, never run git subprocesses with client-controlled cwd.
  if (isHostedMode()) return null;

  const cached = gitRemoteCache.get(path);
  if (cached !== undefined) return cached;

  try {
    // git remote -v outputs lines like:
    //   origin  git@github.com:user/repo.git (fetch)
    //   upstream  https://github.com/org/repo.git (fetch)
    const output = execSync("git remote -v", {
      cwd: path,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"], // suppress stderr
    });

    const remotes = new Map<string, string>();
    for (const line of output.split("\n")) {
      // Only parse fetch URLs (avoid duplicates from push lines)
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
      if (match) {
        remotes.set(match[1], match[2]);
      }
    }

    if (remotes.size === 0) {
      gitRemoteCache.set(path, null);
      return null;
    }

    // Prefer upstream (fork source) > origin > any other
    const url =
      remotes.get("upstream") ??
      remotes.get("origin") ??
      remotes.values().next().value;
    if (!url) {
      gitRemoteCache.set(path, null);
      return null;
    }

    const result = normalizeRemoteUrl(url);
    gitRemoteCache.set(path, result);
    return result;
  } catch {
    // Not a git repo, git not installed, timeout, etc.
    gitRemoteCache.set(path, null);
    return null;
  }
}
