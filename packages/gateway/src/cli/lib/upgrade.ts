/**
 * Upgrade Module
 *
 * Orchestrates binary self-upgrade: version fetching, delta patch
 * application with full-download fallback, and binary replacement.
 *
 * Lore is distributed as a standalone binary only — no package manager
 * detection or Homebrew support needed. The upgrade flow is:
 *
 * 1. Check latest version (GitHub Releases for stable, GHCR for nightly)
 * 2. Try delta upgrade (tiny patches instead of full ~30MB binary)
 * 3. Fall back to full .gz download if no patches available
 * 4. Verify binary, set permissions, replace self atomically
 *
 * Adapted from Sentry CLI's upgrade.ts — stripped of brew/npm/pnpm/yarn
 * detection, setup spawning, and Sentry SDK telemetry.
 */

import { chmodSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getMeta, setMeta } from "@loreai/core";

import {
  acquireLock,
  cleanupOldBinary,
  fetchWithUpgradeError,
  getBinaryFilename,
  getBinaryPaths,
  getConfigDir,
  getGitHubHeaders,
  getPlatformBinaryName,
  GITHUB_RELEASES_URL,
  getBinaryDownloadUrl,
  isNightlyVersion,
  KNOWN_CURL_DIRS,
  releaseLock,
  replaceBinarySync,
} from "./binary";
import { VERSION } from "../version";
import { attemptDeltaUpgrade, type DeltaResult } from "./delta-upgrade";
import { UpgradeError } from "./errors";
import {
  downloadNightlyBlob,
  fetchManifest,
  fetchNightlyManifest,
  findLayerByFilename,
  getAnonymousToken,
  getNightlyVersion,
} from "./ghcr";
import { clearPatchCache } from "./patch-cache";

/** Regex to strip 'v' prefix from version strings */
export const VERSION_PREFIX_REGEX = /^v/;

/** The git tag used for the rolling nightly GitHub release */
export const NIGHTLY_TAG = "nightly";

/** Release channel type */
export type ReleaseChannel = "stable" | "nightly";

/**
 * How the current upgrade reached the offline code path.
 */
export type OfflineMode = false | "explicit" | "network-fallback";

// ---------------------------------------------------------------------------
// Channel persistence
// ---------------------------------------------------------------------------

const CHANNEL_FILE = "channel";
const CHANNEL_META_KEY = "release_channel";

/**
 * Read the persisted release channel.
 *
 * Checks the metadata table first, then falls back to the legacy
 * ~/.lore/channel file for backwards compatibility. If the file
 * exists but the DB doesn't have the value, migrates to DB.
 *
 * Returns "stable" if not set or on any error.
 */
export function getReleaseChannel(): ReleaseChannel {
  // 1. Check metadata table (primary)
  try {
    const dbValue = getMeta(CHANNEL_META_KEY);
    if (dbValue === "nightly") return "nightly";
    if (dbValue === "stable") return "stable";
  } catch {
    // DB not available — fall through to file
  }

  // 2. Fall back to legacy file
  try {
    const content = require("node:fs")
      .readFileSync(join(getConfigDir(), CHANNEL_FILE), "utf-8")
      .trim();
    if (content === "nightly") {
      // Migrate file value to DB
      try { setMeta(CHANNEL_META_KEY, "nightly"); } catch { /* best-effort */ }
      return "nightly";
    }
  } catch {
    // File doesn't exist or unreadable — default to stable
  }
  return "stable";
}

/**
 * Persist the release channel to the metadata table.
 *
 * Also writes the legacy file for older binary versions that may
 * still read it.
 */
export function setReleaseChannel(channel: ReleaseChannel): void {
  // Primary: metadata table
  try {
    setMeta(CHANNEL_META_KEY, channel);
  } catch {
    // Best-effort — don't fail the upgrade if DB write fails
  }

  // Legacy: file (for backwards compat with older binaries)
  try {
    const fs = require("node:fs");
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, CHANNEL_FILE), channel, "utf-8");
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Install path resolution
// ---------------------------------------------------------------------------

const sep = require("node:path").sep;

/**
 * Known curl install paths, resolved at runtime against the user's home.
 */
const KNOWN_CURL_PATHS = KNOWN_CURL_DIRS.map(
  (dir: string) => join(homedir(), dir) + sep,
);

/**
 * Get file paths for the curl-installed binary.
 */
export function getCurlInstallPaths(): {
  installPath: string;
  tempPath: string;
  oldPath: string;
  lockPath: string;
} {
  // Check if we're running from a known curl install location
  for (const dir of KNOWN_CURL_PATHS) {
    if (process.execPath.startsWith(dir)) {
      return getBinaryPaths(process.execPath);
    }
  }

  // Fallback to default path
  const defaultPath = join(homedir(), ".lore", "bin", getBinaryFilename());
  return getBinaryPaths(defaultPath);
}

/**
 * Start cleanup of .old binary. Called on CLI startup. Fire-and-forget.
 */
export function startCleanupOldBinary(): void {
  const { oldPath } = getCurlInstallPaths();
  cleanupOldBinary(oldPath);
}

// ---------------------------------------------------------------------------
// Version Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the latest stable version from GitHub releases.
 */
export async function fetchLatestFromGitHub(
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithUpgradeError(
    `${GITHUB_RELEASES_URL}/latest`,
    { headers: getGitHubHeaders(), signal },
    "GitHub",
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `Failed to fetch from GitHub: ${response.status}`,
    );
  }

  const data = (await response.json()) as { tag_name?: string };

  if (!data.tag_name) {
    throw new UpgradeError(
      "network_error",
      "No version found in GitHub release",
    );
  }

  return data.tag_name.replace(VERSION_PREFIX_REGEX, "");
}

/**
 * Fetch the latest nightly version from GHCR.
 */
export async function fetchLatestNightlyVersion(
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Aborted");

  const token = await getAnonymousToken(signal);

  if (signal?.aborted) throw new Error("Aborted");

  const manifest = await fetchNightlyManifest(token);
  return getNightlyVersion(manifest);
}

/**
 * Fetch the latest available version based on channel.
 */
export function fetchLatestVersion(
  channel: ReleaseChannel = "stable",
  signal?: AbortSignal,
): Promise<string> {
  if (channel === "nightly") {
    return fetchLatestNightlyVersion(signal);
  }
  return fetchLatestFromGitHub(signal);
}

/**
 * Check if a specific version exists in the appropriate registry.
 */
export async function versionExists(
  version: string,
  channel: ReleaseChannel,
): Promise<boolean> {
  if (isNightlyVersion(version) || channel === "nightly") {
    try {
      const token = await getAnonymousToken();
      await fetchManifest(token, `nightly-${version}`);
      return true;
    } catch (error) {
      if (
        error instanceof UpgradeError &&
        (error.message.includes("HTTP 404") ||
          error.message.includes("HTTP 403"))
      ) {
        return false;
      }
      throw error;
    }
  }

  const response = await fetchWithUpgradeError(
    `${GITHUB_RELEASES_URL}/tags/${version}`,
    { method: "HEAD", headers: getGitHubHeaders() },
    "GitHub",
  );
  return response.ok;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type DownloadResult = {
  tempBinaryPath: string;
  lockPath: string;
  patchBytes?: number;
};

/**
 * Stream a response body through gzip decompression to disk.
 */
async function streamDecompressToFile(
  body: ReadableStream<Uint8Array>,
  destPath: string,
): Promise<void> {
  const stream = body.pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const writer = Bun.file(destPath).writer();
  try {
    for await (const chunk of stream) {
      writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
}

function getNightlyGzFilename(): string {
  return `${getPlatformBinaryName()}.gz`;
}

/**
 * Download a nightly binary from GHCR and decompress it.
 */
async function downloadNightlyToPath(
  destPath: string,
  version?: string,
): Promise<void> {
  const token = await getAnonymousToken();
  const manifest = version
    ? await fetchManifest(token, `nightly-${version}`)
    : await fetchNightlyManifest(token);
  const filename = getNightlyGzFilename();
  const layer = findLayerByFilename(manifest, filename);
  const response = await downloadNightlyBlob(token, layer.digest);

  if (!response.body) {
    throw new UpgradeError(
      "execution_failed",
      "GHCR blob response had no body",
    );
  }
  await streamDecompressToFile(response.body, destPath);
}

/**
 * Download a stable binary from GitHub Releases.
 * Tries gzip first, falls back to raw binary.
 */
async function downloadStableToPath(
  version: string,
  destPath: string,
): Promise<void> {
  const url = getBinaryDownloadUrl(version);
  const headers = getGitHubHeaders();

  // Try gzip-compressed download first (~60% smaller)
  try {
    const gzResponse = await fetchWithUpgradeError(
      `${url}.gz`,
      { headers },
      "GitHub",
    );
    if (gzResponse.ok && gzResponse.body) {
      await streamDecompressToFile(gzResponse.body, destPath);
      return;
    }
  } catch {
    // Fall through to raw download
  }

  const response = await fetchWithUpgradeError(url, { headers }, "GitHub");

  if (!response.ok) {
    throw new UpgradeError(
      "execution_failed",
      `Failed to download binary: HTTP ${response.status}`,
    );
  }

  const body = await response.arrayBuffer();
  await Bun.write(destPath, body);
}

/** Max probe attempts before giving up */
const VERIFY_MAX_ATTEMPTS = 6;
const VERIFY_BASE_DELAY_MS = 100;

function probeBinaryFile(path: string): number | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats?.isFile() && stats.size > 0) return stats.size;
  return null;
}

/**
 * Wait for a freshly written binary to become visible by path.
 * Handles Windows filesystem visibility race.
 */
async function waitForBinaryVisible(path: string): Promise<number> {
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
    const size = probeBinaryFile(path);
    if (size !== null) return size;
    if (attempt === VERIFY_MAX_ATTEMPTS) break;
    const delay = VERIFY_BASE_DELAY_MS * 2 ** (attempt - 1);
    await Bun.sleep(delay);
  }
  throw new UpgradeError(
    "execution_failed",
    `Downloaded binary is missing or empty at ${path}. ` +
      "This is usually transient — rerun `lore upgrade` to retry.",
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Download the new binary to a temporary path and return its location.
 *
 * Tries delta upgrade first, falls back to full download.
 * The lock is held on success so concurrent upgrades are blocked.
 */
export async function downloadBinaryToTemp(
  version: string,
  downloadTag?: string,
  offline?: OfflineMode,
): Promise<DownloadResult> {
  const { tempPath, lockPath } = getCurlInstallPaths();

  acquireLock(lockPath);

  try {
    // Clean up leftover temp file
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore
    }

    // Try delta upgrade first
    const deltaResult = await attemptDeltaUpgrade(
      version,
      process.execPath,
      tempPath,
      !!offline,
    );

    let patchBytes: number | undefined;
    if (deltaResult) {
      patchBytes = deltaResult.patchBytes;
      console.error(
        `[lore] Applied delta patch (${formatBytes(patchBytes)} downloaded)`,
      );
    } else if (offline) {
      throw new UpgradeError(
        "offline_cache_miss",
        offline === "explicit"
          ? `Cannot upgrade to ${version} in offline mode — no pre-downloaded update is available. ` +
              "Run `lore upgrade` without `--offline` to download the update directly."
          : `Cannot upgrade to ${version} — the network is unavailable and no pre-downloaded update was found. ` +
              "Check your internet connection and try again.",
      );
    } else {
      // Full download
      if (isNightlyVersion(version)) {
        await downloadNightlyToPath(tempPath, version);
      } else {
        await downloadStableToPath(downloadTag ?? version, tempPath);
      }
    }

    const verifiedSize = await waitForBinaryVisible(tempPath);
    console.error(`[lore] Binary verified (${formatBytes(verifiedSize)})`);

    // Clear consumed patch cache
    clearPatchCache().catch(() => {});

    // Set executable permission (Unix only)
    if (process.platform !== "win32") {
      chmodSync(tempPath, 0o755);
    }

    return { tempBinaryPath: tempPath, lockPath, patchBytes };
  } catch (error) {
    releaseLock(lockPath);
    throw error;
  }
}

/**
 * Execute the full upgrade: download binary, replace self.
 *
 * Returns the download result with paths for the caller to
 * handle lock release.
 */
export async function executeUpgrade(
  version: string,
  downloadTag?: string,
  offline?: OfflineMode,
): Promise<DownloadResult> {
  return downloadBinaryToTemp(version, downloadTag, offline);
}
