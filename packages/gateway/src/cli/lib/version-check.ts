/**
 * Background Version Check
 *
 * Provides "new version available" notifications for the Lore CLI.
 * On startup, a non-blocking background fetch checks for the latest version.
 * The result is cached to disk and displayed on subsequent invocations.
 *
 * For nightly builds (version contains "-dev."), checks GHCR via the OCI
 * manifest annotation. For stable builds, checks GitHub Releases.
 *
 * Adapted from Sentry CLI's version-check.ts for Lore:
 * - File-based persistence instead of SQLite
 * - No Sentry SDK telemetry — errors are silently swallowed
 * - Inline ANSI codes instead of external color library
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./binary";
import { VERSION } from "../version";
import {
  prefetchNightlyPatches,
  prefetchStablePatches,
} from "./delta-upgrade";
import { cleanupPatchCache } from "./patch-cache";
import { fetchLatestFromGitHub, fetchLatestNightlyVersion, getReleaseChannel } from "./upgrade";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target check interval: ~24 hours */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum time between successive "new version available" notifications.
 *
 * Rate-limits the banner to once per 24h regardless of how many commands
 * run in that window, preventing clutter in scripts, CI output, and
 * screen-sharing sessions.
 */
const NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Jitter factor for probabilistic checking (±20%) */
const JITTER_FACTOR = 0.2;

/** Commands/flags that should not show update notifications */
const SUPPRESSED_ARGS = new Set([
  "upgrade",
  "--version",
  "-v",
  "--json",
  "help",
]);

// ---------------------------------------------------------------------------
// ANSI color helpers (inline, no external deps)
// ---------------------------------------------------------------------------

const isColorSupported =
  process.env.FORCE_COLOR !== "0" &&
  process.env.NO_COLOR === undefined &&
  (process.stderr.isTTY ?? false);

function cyan(text: string): string {
  return isColorSupported ? `\x1b[36m${text}\x1b[39m` : text;
}

function dim(text: string): string {
  return isColorSupported ? `\x1b[2m${text}\x1b[22m` : text;
}

// ---------------------------------------------------------------------------
// File-based persistence (replaces Sentry CLI's SQLite)
// ---------------------------------------------------------------------------

const VERSION_CHECK_FILE = "version-check.json";

type VersionCheckData = {
  lastChecked: number | null;
  latestVersion: string | null;
  lastNotified: number | null;
};

function getVersionCheckPath(): string {
  return join(getConfigDir(), VERSION_CHECK_FILE);
}

function readVersionCheckData(): VersionCheckData {
  try {
    const content = readFileSync(getVersionCheckPath(), "utf-8");
    const data = JSON.parse(content) as Partial<VersionCheckData>;
    return {
      lastChecked: typeof data.lastChecked === "number" ? data.lastChecked : null,
      latestVersion: typeof data.latestVersion === "string" ? data.latestVersion : null,
      lastNotified: typeof data.lastNotified === "number" ? data.lastNotified : null,
    };
  } catch {
    return { lastChecked: null, latestVersion: null, lastNotified: null };
  }
}

function writeVersionCheckData(data: VersionCheckData): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(getVersionCheckPath(), JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort — don't fail CLI if persistence fails
  }
}

function setVersionCheckInfo(latestVersion: string): void {
  const existing = readVersionCheckData();
  writeVersionCheckData({
    ...existing,
    lastChecked: Date.now(),
    latestVersion,
  });
}

function markUpdateNotified(): void {
  const existing = readVersionCheckData();
  writeVersionCheckData({
    ...existing,
    lastNotified: Date.now(),
  });
}

/**
 * Clear the cached version check state.
 *
 * Should be called when the release channel changes so that stale version
 * data from the previous channel is not shown in update notifications.
 */
export function clearVersionCheckCache(): void {
  writeVersionCheckData({
    lastChecked: null,
    latestVersion: null,
    lastNotified: null,
  });
}

// ---------------------------------------------------------------------------
// Check scheduling (probabilistic, ~24h interval with jitter)
// ---------------------------------------------------------------------------

/**
 * Determine if we should check for updates based on time since last check.
 * Uses probabilistic approach: probability increases as we approach/pass the interval.
 */
function shouldCheckForUpdate(): boolean {
  const { lastChecked } = readVersionCheckData();

  if (lastChecked === null) {
    return true;
  }

  const elapsed = Date.now() - lastChecked;

  // Add jitter to the interval (±20%)
  const jitter = (Math.random() - 0.5) * 2 * JITTER_FACTOR;
  const effectiveInterval = CHECK_INTERVAL_MS * (1 + jitter);

  // Probability ramps up as we approach/exceed the interval
  // At 0% of interval: ~0% chance
  // At 100% of interval: ~63% chance (1 - 1/e)
  // At 200% of interval: ~86% chance
  const probability = 1 - Math.exp(-elapsed / effectiveInterval);

  return Math.random() < probability;
}

// ---------------------------------------------------------------------------
// Notification rate limiting
// ---------------------------------------------------------------------------

/** Whether we've already returned an update notification this process. */
let notifiedThisProcess = false;

/**
 * Check whether enough time has passed since the last notification.
 * Returns true on first-ever notification (lastNotified === null).
 */
function canNotifyAgain(lastNotified: number | null): boolean {
  if (lastNotified === null) {
    return true;
  }
  return Date.now() - lastNotified >= NOTIFICATION_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Background check
// ---------------------------------------------------------------------------

/** AbortController for pending version check fetch */
let pendingAbortController: AbortController | null = null;

/**
 * Pre-fetch delta patches for a newly discovered version.
 * Best-effort: errors are silently caught so the version check still succeeds.
 */
async function maybePrefetchPatches(
  channel: "stable" | "nightly",
  latestVersion: string,
  signal: AbortSignal,
): Promise<void> {
  if (Bun.semver.order(latestVersion, VERSION) !== 1) {
    return;
  }
  try {
    if (channel === "nightly") {
      await prefetchNightlyPatches(latestVersion, signal);
    } else {
      await prefetchStablePatches(latestVersion, signal);
    }
  } catch {
    // Pre-fetch is best-effort
  }

  // Opportunistic cleanup of stale cached patches
  try {
    await cleanupPatchCache();
  } catch {
    /* ignore */
  }
}

/**
 * Start a background check for new versions.
 * Does not block — fires a fetch and lets it complete in the background.
 * Never throws — errors are silently swallowed.
 */
function checkForUpdateInBackgroundImpl(): void {
  try {
    if (!shouldCheckForUpdate()) {
      return;
    }
  } catch {
    return;
  }

  pendingAbortController = new AbortController();
  const { signal } = pendingAbortController;

  const channel = getReleaseChannel();

  // Fire-and-forget — this promise is intentionally not awaited.
  // The version check runs concurrently with the main command.
  // Results are cached to disk for the next invocation to display.
  (async () => {
    try {
      const latestVersion =
        channel === "nightly"
          ? await fetchLatestNightlyVersion(signal)
          : await fetchLatestFromGitHub(signal);
      setVersionCheckInfo(latestVersion);

      // Pre-fetch delta patches so `lore upgrade` can apply them offline
      await maybePrefetchPatches(channel, latestVersion, signal);
    } catch {
      // Errors here are expected (network failures, timeouts, aborts).
      // Silently swallow — the user will just not see the update nag.
    } finally {
      pendingAbortController = null;
    }
  })();
}

// ---------------------------------------------------------------------------
// Notification message
// ---------------------------------------------------------------------------

/**
 * Check whether stderr is attached to a TTY.
 *
 * Non-TTY output covers scripts piping into other commands, CI logs, and
 * editors capturing CLI output. The update banner is human-only signal —
 * suppress it when no human will read it.
 */
function isStderrTTY(): boolean {
  return Boolean(process.stderr.isTTY);
}

/**
 * Build the update notification message.
 * Returns null if up-to-date, no cached info, rate-limited, non-TTY, or error.
 */
function getUpdateNotificationImpl(): string | null {
  // Gate 1: non-TTY stderr (scripts, CI, pipes)
  if (!isStderrTTY()) {
    return null;
  }

  // Gate 2: don't double-emit within the same process
  if (notifiedThisProcess) {
    return null;
  }

  try {
    const { latestVersion, lastNotified } = readVersionCheckData();

    if (!latestVersion) {
      return null;
    }

    // Only notify if latest is strictly newer than current
    if (Bun.semver.order(latestVersion, VERSION) !== 1) {
      return null;
    }

    // Gate 3: daily rate limit across CLI invocations
    if (!canNotifyAgain(lastNotified)) {
      return null;
    }

    const channel = getReleaseChannel();
    const label =
      channel === "nightly" ? "New nightly available:" : "Update available:";

    // Record that we're about to print the banner so repeat invocations
    // within the rate-limit window stay silent.
    try {
      markUpdateNotified();
    } catch {
      // Non-fatal: banner still prints, won't be rate-limited next run
    }
    notifiedThisProcess = true;

    return `\n${dim(label)} ${cyan(VERSION)} -> ${cyan(latestVersion)}  Run ${cyan('"lore upgrade"')} to update.\n`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if update notifications should be suppressed for these args.
 */
export function shouldSuppressNotification(args: string[]): boolean {
  return args.some((arg) => SUPPRESSED_ARGS.has(arg));
}

/**
 * Check if update checking is disabled via environment variable.
 */
function isUpdateCheckDisabled(): boolean {
  return process.env.LORE_NO_UPDATE_CHECK === "1";
}

/**
 * Start a background check for new versions (if not disabled).
 * Does not block — fires a fetch and lets it complete in the background.
 */
export function maybeCheckForUpdateInBackground(): void {
  if (isUpdateCheckDisabled()) {
    return;
  }
  checkForUpdateInBackgroundImpl();
}

/**
 * Get the update notification message if a new version is available.
 * Returns null if disabled, up-to-date, no cached info, or on error.
 */
export function getUpdateNotification(): string | null {
  if (isUpdateCheckDisabled()) {
    return null;
  }
  return getUpdateNotificationImpl();
}

/**
 * Abort any pending version check to allow process exit.
 * Call this when main CLI work is complete.
 */
export function abortPendingVersionCheck(): void {
  pendingAbortController?.abort();
  pendingAbortController = null;
}
