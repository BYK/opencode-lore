/**
 * Binary Management
 *
 * Shared utilities for installing, replacing, and managing the CLI binary.
 * Adapted from Sentry CLI's binary.ts for the Lore upgrade system.
 *
 * Key differences from Sentry CLI:
 * - No musl detection (Lore doesn't target Alpine)
 * - Lore binary naming: `lore-{os}-{arch}[.exe]`
 * - Install dirs: ~/.lore/bin, ~/.local/bin
 * - No Sentry SDK telemetry
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { VERSION } from "../version";
import { stringifyUnknown, UpgradeError } from "./errors";

/** GitHub owner/repo for Lore releases */
const GITHUB_OWNER = "BYK";
const GITHUB_REPO = "loreai";

/** GitHub API base URL for releases */
export const GITHUB_RELEASES_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

/** Known directories where the curl installer may place the binary */
export const KNOWN_CURL_DIRS = [".local/bin", "bin", ".lore/bin"];

/**
 * Build the platform-specific binary base name.
 *
 * Matches the naming convention used by GitHub Releases and GHCR:
 * `lore-{os}-{arch}[.exe]`
 */
export function getPlatformBinaryName(): string {
  let os: string;
  if (process.platform === "darwin") {
    os = "darwin";
  } else if (process.platform === "win32") {
    os = "windows";
  } else {
    os = "linux";
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const suffix = process.platform === "win32" ? ".exe" : "";
  return `lore-${os}-${arch}${suffix}`;
}

/**
 * Build the download URL for a platform-specific binary from GitHub releases.
 */
export function getBinaryDownloadUrl(version: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${version}/${getPlatformBinaryName()}`;
}

/**
 * Detect whether a version string identifies a nightly build.
 *
 * Nightlies use the format `X.Y.Z-dev.<unix-seconds>`.
 */
export function isNightlyVersion(version: string): boolean {
  return version.includes("-dev.");
}

/**
 * Compare two version strings and return their ordering.
 *
 * Uses `Bun.semver.order` which handles both stable (`X.Y.Z`) and
 * nightly (`X.Y.Z-dev.<unix-seconds>`) versions correctly.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return Bun.semver.order(a, b);
}

/**
 * Check whether moving from `current` to `target` is a downgrade.
 */
export function isDowngrade(current: string, target: string): boolean {
  return compareVersions(current, target) === 1;
}

/**
 * Get the binary filename for the current platform.
 */
export function getBinaryFilename(): string {
  return process.platform === "win32" ? "lore.exe" : "lore";
}

/**
 * Build paths object from an install path.
 */
export function getBinaryPaths(installPath: string): {
  installPath: string;
  tempPath: string;
  oldPath: string;
  lockPath: string;
} {
  return {
    installPath,
    tempPath: `${installPath}.download`,
    oldPath: `${installPath}.old`,
    lockPath: `${installPath}.lock`,
  };
}

/**
 * Determine the install directory for a curl-installed binary.
 *
 * Priority:
 * 1. $LORE_INSTALL_DIR environment variable
 * 2. ~/.local/bin (if exists AND in $PATH)
 * 3. ~/bin (if exists AND in $PATH)
 * 4. ~/.lore/bin (fallback)
 */
export function determineInstallDir(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const pathDirs = (env.PATH ?? "").split(delimiter);

  if (env.LORE_INSTALL_DIR) {
    return env.LORE_INSTALL_DIR;
  }

  const candidates = [join(homeDir, ".local", "bin"), join(homeDir, "bin")];

  for (const dir of candidates) {
    if (existsSync(dir) && pathDirs.includes(dir)) {
      return dir;
    }
  }

  return join(homeDir, ".lore", "bin");
}

/**
 * Build headers for GitHub API requests.
 */
export function getGitHubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": getUserAgent(),
  };
}

/**
 * Generate the User-Agent string for API requests.
 */
export function getUserAgent(): string {
  const runtime =
    typeof process.versions.bun !== "undefined"
      ? `bun/${process.versions.bun}`
      : `node/${process.versions.node}`;
  return `lore/${VERSION} (${process.platform}-${process.arch}) ${runtime}`;
}

/**
 * Fetch wrapper that converts network errors to UpgradeError.
 */
export async function fetchWithUpgradeError(
  url: string,
  init: RequestInit,
  serviceName: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    const msg = stringifyUnknown(error);
    throw new UpgradeError(
      "network_error",
      `Failed to connect to ${serviceName}: ${msg}`,
    );
  }
}

/**
 * Replace the binary at the install path, handling platform differences.
 *
 * Intentionally synchronous: the multi-step rename sequence must be
 * uninterruptible to avoid leaving the install path in a broken state.
 *
 * - Unix: Atomic rename overwrites the target
 * - Windows: Rename old binary to .old first, then rename temp into place
 */
export function replaceBinarySync(tempPath: string, installPath: string): void {
  if (process.platform === "win32") {
    const oldPath = `${installPath}.old`;
    try {
      renameSync(installPath, oldPath);
    } catch {
      try {
        unlinkSync(oldPath);
        renameSync(installPath, oldPath);
      } catch {
        // Current binary might not exist — that's fine
      }
    }
    renameSync(tempPath, installPath);
  } else {
    renameSync(tempPath, installPath);
  }
}

/**
 * Clean up leftover .old files from previous upgrades.
 * Called on CLI startup. Fire-and-forget.
 */
export function cleanupOldBinary(oldPath: string): void {
  unlink(oldPath).catch(() => {
    // Intentionally ignore — file may not exist
  });
}

// Lock Management

/**
 * Check if a process with the given PID is still running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Acquire an exclusive lock for binary installation/upgrade.
 * Uses atomic file creation with 'wx' flag to prevent race conditions.
 */
export function acquireLock(lockPath: string): void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    handleExistingLock(lockPath);
  }
}

function handleExistingLock(lockPath: string): void {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      acquireLock(lockPath);
      return;
    }
    throw error;
  }

  const existingPid = Number.parseInt(content, 10);

  if (!Number.isNaN(existingPid) && isProcessRunning(existingPid)) {
    // Allow re-entry from the same process (e.g. downloadBinaryToTemp
    // acquires the lock, then installBinary tries to acquire the same lock
    // when source and target directories are identical).
    if (existingPid === process.pid) {
      return;
    }
    // Allow child process to take over parent's lock (exec-based restart).
    if (existingPid === process.ppid) {
      writeFileSync(lockPath, String(process.pid));
      return;
    }
    throw new UpgradeError(
      "execution_failed",
      "Another upgrade is already in progress",
    );
  }

  // Stale lock from dead process — remove and retry
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  acquireLock(lockPath);
}

/**
 * Release the binary lock.
 */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore — file might already be gone
  }
}

/**
 * Install a binary to the target directory.
 */
export async function installBinary(
  sourcePath: string,
  installDir: string,
): Promise<string> {
  await mkdir(installDir, { recursive: true, mode: 0o755 });

  const installPath = join(installDir, getBinaryFilename());
  const { tempPath, lockPath } = getBinaryPaths(installPath);

  acquireLock(lockPath);

  try {
    if (resolve(sourcePath) !== resolve(tempPath)) {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore if doesn't exist
      }

      await Bun.write(tempPath, Bun.file(sourcePath));

      if (process.platform !== "win32") {
        await chmod(tempPath, 0o755);
      }
    }

    replaceBinarySync(tempPath, installPath);
  } finally {
    releaseLock(lockPath);
  }

  return installPath;
}

/**
 * Get the Lore config directory.
 * Uses $LORE_CONFIG_DIR if set, otherwise ~/.lore
 */
export function getConfigDir(): string {
  if (process.env.LORE_CONFIG_DIR) {
    return process.env.LORE_CONFIG_DIR;
  }
  const home =
    process.env.HOME ?? process.env.USERPROFILE ?? require("node:os").homedir();
  return join(home, ".lore");
}
