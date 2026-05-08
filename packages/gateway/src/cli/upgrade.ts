/**
 * `lore upgrade [version]` — self-update command.
 *
 * Self-update the Lore CLI to the latest or a specific version.
 * After upgrading, replaces the running binary atomically.
 *
 * Supports two release channels:
 * - stable (default): tracks the latest GitHub release
 * - nightly: tracks the rolling nightly prerelease from GHCR
 *
 * The channel can be set via --channel or by passing "nightly"/"stable"
 * as the version argument. The choice is persisted in ~/.lore/channel.
 *
 * Flags:
 *   --check    Check for updates without installing
 *   --force    Force re-download even if up to date
 *   --offline  Upgrade from cached patches (no network)
 *   --channel  Set release channel (stable or nightly)
 *
 * Adapted from Sentry CLI's upgrade command — stripped of brew/npm
 * detection, setup spawning, release notes, and Sentry SDK telemetry.
 */

import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { VERSION } from "./version";
import {
  isDowngrade,
  installBinary,
  determineInstallDir,
  releaseLock,
} from "./lib/binary";
import { UpgradeError } from "./lib/errors";
import {
  executeUpgrade,
  fetchLatestVersion,
  getCurlInstallPaths,
  getReleaseChannel,
  NIGHTLY_TAG,
  type OfflineMode,
  type ReleaseChannel,
  setReleaseChannel,
  versionExists,
  VERSION_PREFIX_REGEX,
} from "./lib/upgrade";

/** Special version strings that select a channel */
const CHANNEL_VERSIONS = new Set(["nightly", "stable"]);

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface UpgradeFlags {
  check: boolean;
  force: boolean;
  offline: boolean;
  channel?: string;
}

function parseUpgradeFlags(args: string[]): {
  flags: UpgradeFlags;
  versionArg: string | undefined;
} {
  const { values, positionals } = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      channel: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    flags: {
      check: !!values.check,
      force: !!values.force,
      offline: !!values.offline,
      channel: values.channel as string | undefined,
    },
    versionArg: positionals[0],
  };
}

// ---------------------------------------------------------------------------
// Channel + version resolution
// ---------------------------------------------------------------------------

function resolveChannelAndVersion(
  versionArg: string | undefined,
  channelFlag: string | undefined,
): {
  channel: ReleaseChannel;
  cleanVersionArg: string | undefined;
} {
  // "nightly" and "stable" as positional args select the channel
  const lower = versionArg?.toLowerCase();
  if (lower === "nightly" || lower === "stable") {
    return { channel: lower, cleanVersionArg: undefined };
  }

  // --channel flag overrides persisted channel
  if (channelFlag === "nightly" || channelFlag === "stable") {
    return { channel: channelFlag, cleanVersionArg: versionArg };
  }

  return {
    channel: getReleaseChannel(),
    cleanVersionArg: versionArg,
  };
}

// ---------------------------------------------------------------------------
// Cached version for offline mode
// ---------------------------------------------------------------------------

/** Simple file-based cache for last-known latest version */
function getCachedLatestVersion(): string | null {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { getConfigDir } = require("./lib/binary");
    const content = fs
      .readFileSync(path.join(getConfigDir(), "latest-version"), "utf-8")
      .trim();
    return content || null;
  } catch {
    return null;
  }
}

function setCachedLatestVersion(version: string): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { getConfigDir } = require("./lib/binary");
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest-version"), version, "utf-8");
  } catch {
    // Best-effort
  }
}

function resolveOfflineTarget(versionArg: string | undefined): string {
  if (versionArg) {
    return versionArg.replace(VERSION_PREFIX_REGEX, "");
  }
  const cached = getCachedLatestVersion();
  if (!cached) {
    throw new UpgradeError(
      "network_error",
      "No cached version available. Run `lore upgrade` with network access first, then retry with --offline.",
    );
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function commandUpgrade(args: string[]): Promise<void> {
  const { flags, versionArg: rawVersionArg } = parseUpgradeFlags(args);

  const { channel, cleanVersionArg } = resolveChannelAndVersion(
    rawVersionArg,
    flags.channel,
  );

  const currentChannel = getReleaseChannel();
  const channelChanged = channel !== currentChannel;

  console.error(`[lore] Current version: ${VERSION}`);
  console.error(`[lore] Channel: ${channel}`);

  // Resolve target version
  let target: string;
  let offline: OfflineMode = false;

  if (flags.offline) {
    // Read cached version BEFORE persisting channel
    target = resolveOfflineTarget(cleanVersionArg);
    offline = "explicit";
    console.error(`[lore] Offline mode: using cached target ${target}`);
  } else {
    try {
      const latest = await fetchLatestVersion(channel);
      target = cleanVersionArg?.replace(VERSION_PREFIX_REGEX, "") ?? latest;

      // Cache the latest version for future offline use
      setCachedLatestVersion(latest);
    } catch (error) {
      // Try offline fallback
      if (error instanceof UpgradeError && error.reason === "network_error") {
        try {
          target = resolveOfflineTarget(cleanVersionArg);
          offline = "network-fallback";
          console.error(
            "[lore] Network unavailable, falling back to cached upgrade target",
          );
        } catch {
          throw error; // Re-throw original network error
        }
      } else {
        throw error;
      }
    }
  }

  // Persist channel preference
  if (channelChanged || CHANNEL_VERSIONS.has(rawVersionArg ?? "")) {
    setReleaseChannel(channel);
  }

  // --check: just report status
  if (flags.check) {
    if (VERSION === target) {
      console.error(`[lore] Already up to date (${VERSION})`);
    } else {
      const direction = isDowngrade(VERSION, target)
        ? "Downgrade"
        : "Update";
      console.error(`[lore] ${direction} available: ${VERSION} -> ${target}`);
      console.error(`[lore] Run 'lore upgrade' to update.`);
    }
    if (offline) {
      console.error("[lore] (resolved from cache — network unavailable)");
    }
    return;
  }

  // Already on target — unless forced or switching channels
  if (VERSION === target && !flags.force && !channelChanged) {
    console.error(`[lore] Already up to date (${VERSION})`);
    return;
  }

  // Validate pinned version exists (skip for channel keywords)
  if (
    cleanVersionArg &&
    !CHANNEL_VERSIONS.has(cleanVersionArg) &&
    !offline
  ) {
    const exists = await versionExists(target, channel);
    if (!exists) {
      throw new UpgradeError(
        "version_not_found",
        `Version ${target} not found`,
      );
    }
  }

  const downgrade = isDowngrade(VERSION, target);
  const verb = downgrade ? "Downgrading" : "Upgrading";
  console.error(`[lore] ${verb} to ${target}...`);

  // Use the rolling "nightly" tag only when upgrading to latest nightly
  const downloadTag =
    channel === "nightly" && !cleanVersionArg ? NIGHTLY_TAG : undefined;

  // Download the new binary
  const downloadResult = await executeUpgrade(target, downloadTag, offline);

  if (downloadResult.patchBytes) {
    console.error(
      `[lore] Applied delta patch (${formatBytes(downloadResult.patchBytes)} downloaded)`,
    );
  }

  // Install: replace the current binary atomically
  try {
    const currentInstallDir = dirname(getCurlInstallPaths().installPath);
    const installDir = determineInstallDir(
      require("node:os").homedir(),
      process.env,
    );
    // Use current install dir if we're already in a known location
    const targetDir = process.execPath.startsWith(currentInstallDir)
      ? currentInstallDir
      : installDir;

    const installedPath = await installBinary(
      downloadResult.tempBinaryPath,
      targetDir,
    );

    console.error(
      `[lore] ${downgrade ? "Downgraded" : "Upgraded"} successfully: ${VERSION} -> ${target}`,
    );
    console.error(`[lore] Binary installed at: ${installedPath}`);
    if (offline) {
      console.error("[lore] (upgraded from cached patches)");
    }
  } finally {
    releaseLock(downloadResult.lockPath);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
