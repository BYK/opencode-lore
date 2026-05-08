/**
 * Delta Upgrade Module
 *
 * Discovers and applies binary delta patches for CLI self-upgrades.
 * Instead of downloading the full ~30 MB gzipped binary, downloads
 * tiny patches (50-500 KB) and applies them to the currently installed
 * binary using the TRDIFF10 format (zig-bsdiff with zstd compression).
 *
 * Supports two channels:
 * - **Stable**: patches stored as GitHub Release assets with predictable names
 * - **Nightly**: patches stored in GHCR with `:patch-<version>` tags
 *
 * Falls back to full download when:
 * - No patch is available (404)
 * - Chain of patches exceeds 60% of the full download size
 * - Chain exceeds the maximum depth (10 steps)
 * - Any error occurs during patch download or application
 *
 * Adapted from Sentry CLI's delta-upgrade.ts for Lore.
 * All Sentry SDK telemetry removed — uses plain logging.
 */

import { unlinkSync } from "node:fs";

import {
  GITHUB_RELEASES_URL,
  getPlatformBinaryName,
  getUserAgent,
  isDowngrade,
  isNightlyVersion,
} from "./binary";
import { applyPatch } from "./bspatch";
import { VERSION } from "../version";
import {
  downloadLayerBlob,
  fetchManifest,
  getAnonymousToken,
  listTags,
  type OciManifest,
} from "./ghcr";
import { loadCachedChain, savePatchesToCache } from "./patch-cache";

/** Maximum stable patches to chain before falling back to full download */
const MAX_STABLE_CHAIN_DEPTH = 10;

/**
 * Maximum nightly patches to chain before falling back to full download.
 */
const MAX_NIGHTLY_CHAIN_DEPTH = 30;

/**
 * Maximum ratio of total patch chain size to full download size.
 */
const SIZE_THRESHOLD_RATIO = 0.6;

const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]+)$/i;

/** A single link in the patch chain */
type PatchLink = {
  data: Uint8Array;
  size: number;
};

/** A resolved chain of patches from current version to target version */
export type PatchChain = {
  patches: PatchLink[];
  totalSize: number;
  expectedSha256: string;
  steps?: { fromVersion: string; toVersion: string }[];
};

/** Result of a successful delta upgrade */
export type DeltaResult = {
  sha256: string;
  patchBytes: number;
  chainLength: number;
};

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

/**
 * Check whether delta upgrade can be attempted.
 */
export function canAttemptDelta(targetVersion: string): boolean {
  if (VERSION === "dev" || VERSION === "0.0.0-dev") {
    return false;
  }

  // Cross-channel upgrades are rare one-off operations; skip delta
  if (isNightlyVersion(VERSION) !== isNightlyVersion(targetVersion)) {
    return false;
  }

  if (isDowngrade(VERSION, targetVersion)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Stable channel: GitHub Releases
// ---------------------------------------------------------------------------

export type GitHubAsset = {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name: string;
  assets: GitHubAsset[];
  body?: string;
};

/**
 * Fetch recent releases from GitHub, ordered newest-first.
 */
export async function fetchRecentReleases(
  signal?: AbortSignal,
): Promise<GitHubRelease[]> {
  const perPage = MAX_STABLE_CHAIN_DEPTH + 2;
  let response: Response;
  try {
    response = await fetch(`${GITHUB_RELEASES_URL}?per_page=${perPage}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": getUserAgent(),
      },
      signal,
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  return (await response.json()) as GitHubRelease[];
}

/**
 * Extract SHA-256 hex digest from a GitHub asset's digest field.
 */
export function extractSha256(asset: GitHubAsset): string | null {
  if (!asset.digest) return null;
  const match = SHA256_DIGEST_PATTERN.exec(asset.digest);
  return match ? (match[1]?.toLowerCase() ?? null) : null;
}

/**
 * Download a patch file from a GitHub Release asset URL.
 */
export async function downloadStablePatch(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": getUserAgent() },
      signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Extract the target binary SHA-256 from a GitHub Release.
 */
export function getStableTargetSha256(
  release: GitHubRelease,
  binaryName: string,
): string | null {
  const binaryAsset = release.assets.find((a) => a.name === binaryName);
  if (!binaryAsset) return null;
  return extractSha256(binaryAsset);
}

export type ExtractStableChainOpts = {
  releases: GitHubRelease[];
  currentVersion: string;
  targetVersion: string;
  binaryName: string;
  fullGzSize: number;
};

export type StableChainInfo = {
  patchUrls: string[];
  expectedSha256: string;
  steps: { fromVersion: string; toVersion: string }[];
};

/**
 * Extract the chain of patch URLs from an already-fetched release list.
 * Pure computation — no HTTP calls.
 */
export function extractStableChain(
  opts: ExtractStableChainOpts,
): StableChainInfo | null {
  const { releases, currentVersion, targetVersion, binaryName, fullGzSize } =
    opts;
  const patchAssetName = `${binaryName}.patch`;

  const targetIdx = releases.findIndex((r) => r.tag_name === targetVersion);
  const currentIdx = releases.findIndex((r) => r.tag_name === currentVersion);
  if (targetIdx === -1 || currentIdx === -1 || targetIdx >= currentIdx) {
    return null;
  }

  const chainReleases = releases.slice(targetIdx, currentIdx);
  if (chainReleases.length > MAX_STABLE_CHAIN_DEPTH) {
    return null;
  }

  const targetRelease = chainReleases[0];
  if (!targetRelease) return null;
  const expectedSha256 =
    getStableTargetSha256(targetRelease, binaryName) ?? "";
  if (!expectedSha256) return null;

  const patchUrls: string[] = [];
  let totalSize = 0;
  for (const release of chainReleases) {
    const patchAsset = release.assets.find((a) => a.name === patchAssetName);
    if (!patchAsset) return null;
    patchUrls.push(patchAsset.browser_download_url);
    totalSize += patchAsset.size;
    if (totalSize > fullGzSize * SIZE_THRESHOLD_RATIO) {
      return null;
    }
  }

  // Reverse to get apply order: oldest patch first
  patchUrls.reverse();

  const reversedReleases = [...chainReleases].reverse();
  const steps: { fromVersion: string; toVersion: string }[] = [];
  let prevVersion = currentVersion;
  for (const release of reversedReleases) {
    steps.push({ fromVersion: prevVersion, toVersion: release.tag_name });
    prevVersion = release.tag_name;
  }

  return { patchUrls, expectedSha256, steps };
}

/**
 * Resolve a chain of stable patches from current to target version.
 */
export async function resolveStableChain(
  currentVersion: string,
  targetVersion: string,
  signal?: AbortSignal,
): Promise<PatchChain | null> {
  const binaryName = getPlatformBinaryName();
  const releases = await fetchRecentReleases(signal);

  const targetRelease = releases.find((r) => r.tag_name === targetVersion);
  if (!targetRelease) return null;
  const gzAsset = targetRelease.assets.find(
    (a) => a.name === `${binaryName}.gz`,
  );
  if (!gzAsset) return null;

  const chainInfo = extractStableChain({
    releases,
    currentVersion,
    targetVersion,
    binaryName,
    fullGzSize: gzAsset.size,
  });
  if (!chainInfo) return null;

  // Parallel patch download
  const downloadResults = await Promise.all(
    chainInfo.patchUrls.map((url) => downloadStablePatch(url, signal)),
  );

  const patches: PatchLink[] = [];
  let totalSize = 0;
  for (const data of downloadResults) {
    if (!data) return null;
    patches.push({ data, size: data.byteLength });
    totalSize += data.byteLength;
  }

  return {
    patches,
    totalSize,
    expectedSha256: chainInfo.expectedSha256,
    steps: chainInfo.steps,
  };
}

// ---------------------------------------------------------------------------
// Nightly channel: GHCR
// ---------------------------------------------------------------------------

export function getPatchFromVersion(manifest: OciManifest): string | null {
  return manifest.annotations?.["from-version"] ?? null;
}

export function getPatchTargetSha256(
  manifest: OciManifest,
  binaryName: string,
): string | null {
  return manifest.annotations?.[`sha256-${binaryName}`] ?? null;
}

export const PATCH_TAG_PREFIX = "patch-";

/**
 * Filter patch tags to only those in the upgrade chain, sorted in apply order.
 */
export function filterAndSortChainTags(
  allTags: string[],
  currentVersion: string,
  targetVersion: string,
): string[] {
  const chainTags: { tag: string; version: string }[] = [];

  for (const tag of allTags) {
    const version = tag.slice(PATCH_TAG_PREFIX.length);
    if (
      Bun.semver.order(version, currentVersion) === 1 &&
      Bun.semver.order(version, targetVersion) !== 1
    ) {
      chainTags.push({ tag, version });
    }
  }

  chainTags.sort((a, b) => Bun.semver.order(a.version, b.version));
  return chainTags.map((t) => t.tag);
}

type NightlyChainValidation = {
  digests: string[];
  totalSize: number;
  expectedSha256: string;
};

type ValidateChainOpts = {
  manifests: OciManifest[];
  chainTags: string[];
  currentVersion: string;
  targetVersion: string;
  patchLayerName: string;
  binaryName: string;
  fullGzSize: number;
};

type ChainStepResult =
  | { ok: true; digest: string; size: number }
  | { ok: false };

export function validateChainStep(
  manifest: OciManifest,
  opts: { expectedFrom: string; patchLayerName: string; sizeLimit: number },
): ChainStepResult {
  const fromVersion = getPatchFromVersion(manifest);
  if (fromVersion !== opts.expectedFrom) {
    return { ok: false };
  }

  const layer = manifest.layers.find((l) => {
    const title = l.annotations?.["org.opencontainers.image.title"];
    return title === opts.patchLayerName;
  });
  if (!layer) return { ok: false };
  if (layer.size > opts.sizeLimit) return { ok: false };

  return { ok: true, digest: layer.digest, size: layer.size };
}

function validateNightlyChain(
  opts: ValidateChainOpts,
): NightlyChainValidation | null {
  const {
    manifests,
    chainTags,
    currentVersion,
    targetVersion,
    patchLayerName,
    binaryName,
    fullGzSize,
  } = opts;
  const digests: string[] = [];
  let totalSize = 0;
  let prevVersion = currentVersion;

  for (let i = 0; i < manifests.length; i++) {
    const manifest = manifests[i];
    const tag = chainTags[i];
    if (!(manifest && tag)) return null;

    const remainingBudget = fullGzSize * SIZE_THRESHOLD_RATIO - totalSize;
    const result = validateChainStep(manifest, {
      expectedFrom: prevVersion,
      patchLayerName,
      sizeLimit: remainingBudget,
    });
    if (!result.ok) return null;

    digests.push(result.digest);
    totalSize += result.size;
    prevVersion = tag.slice(PATCH_TAG_PREFIX.length);

    if (i === manifests.length - 1) {
      if (prevVersion !== targetVersion) return null;
      const sha256 = getPatchTargetSha256(manifest, binaryName) ?? "";
      if (!sha256) return null;
      return { digests, totalSize, expectedSha256: sha256 };
    }
  }

  return null;
}

/**
 * Resolve a chain of nightly patches from current to target version.
 */
export async function resolveNightlyChain(opts: {
  token: string;
  currentVersion: string;
  targetVersion: string;
  fullGzSize: number;
  preloadedTags?: string[];
  signal?: AbortSignal;
}): Promise<PatchChain | null> {
  const {
    token,
    currentVersion,
    targetVersion,
    fullGzSize,
    preloadedTags,
    signal,
  } = opts;
  const binaryName = getPlatformBinaryName();
  const patchLayerName = `${binaryName}.patch`;

  const allTags =
    preloadedTags ?? (await listTags(token, PATCH_TAG_PREFIX, signal));

  const chainTags = filterAndSortChainTags(
    allTags,
    currentVersion,
    targetVersion,
  );
  if (chainTags.length === 0 || chainTags.length > MAX_NIGHTLY_CHAIN_DEPTH) {
    return null;
  }

  // Fetch manifests for chain tags
  const fetchedManifests = new Map<string, OciManifest>();
  const results = await Promise.all(
    chainTags.map(async (tag) => {
      try {
        const manifest = await fetchManifest(token, tag, signal);
        return { tag, manifest };
      } catch {
        return { tag, manifest: null };
      }
    }),
  );

  for (const { tag, manifest } of results) {
    if (manifest) fetchedManifests.set(tag, manifest);
  }

  const manifests: (OciManifest | undefined)[] = chainTags.map((tag) =>
    fetchedManifests.get(tag),
  );
  if (manifests.some((m) => !m)) return null;

  const validation = validateNightlyChain({
    manifests: manifests as OciManifest[],
    chainTags,
    currentVersion,
    targetVersion,
    patchLayerName,
    binaryName,
    fullGzSize,
  });
  if (!validation) return null;

  // Parallel blob download
  const downloadResults = await Promise.all(
    validation.digests.map((digest) =>
      downloadLayerBlob(token, digest, signal).then(
        (buf) => new Uint8Array(buf),
      ),
    ),
  );

  const patches: PatchLink[] = [];
  let downloadedSize = 0;
  for (const data of downloadResults) {
    patches.push({ data, size: data.byteLength });
    downloadedSize += data.byteLength;
  }

  const steps: { fromVersion: string; toVersion: string }[] = [];
  let prevVersion = currentVersion;
  for (const tag of chainTags) {
    const toVersion = tag.slice(PATCH_TAG_PREFIX.length);
    steps.push({ fromVersion: prevVersion, toVersion });
    prevVersion = toVersion;
  }

  return {
    patches,
    totalSize: downloadedSize,
    expectedSha256: validation.expectedSha256,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: attempt delta upgrade
// ---------------------------------------------------------------------------

/**
 * Attempt to download and apply delta patches instead of a full binary.
 *
 * This is the main entry point called by `downloadBinaryToTemp()` in
 * the upgrade module. Falls back gracefully to null on any failure.
 */
export async function attemptDeltaUpgrade(
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
): Promise<DeltaResult | null> {
  if (!canAttemptDelta(targetVersion)) {
    return null;
  }

  const channel = isNightlyVersion(targetVersion) ? "nightly" : "stable";

  try {
    const result =
      channel === "nightly"
        ? await resolveAndApplyDelta({
            targetVersion,
            oldBinaryPath,
            destPath,
            resolveFromNetwork: () =>
              resolveNightlyChainWithContext(targetVersion),
            channel: "nightly",
            offline,
          })
        : await resolveAndApplyDelta({
            targetVersion,
            oldBinaryPath,
            destPath,
            resolveFromNetwork: () =>
              resolveStableChain(VERSION, targetVersion),
            channel: "stable",
            offline,
          });

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[lore] Delta upgrade failed (${msg}), falling back to full download`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared cache-first resolve + apply logic
// ---------------------------------------------------------------------------

type ResolveAndApplyOpts = {
  targetVersion: string;
  oldBinaryPath: string;
  destPath: string;
  resolveFromNetwork: () => Promise<PatchChain | null>;
  channel: string;
  offline?: boolean;
};

async function resolveAndApplyDelta(
  opts: ResolveAndApplyOpts,
): Promise<DeltaResult | null> {
  const {
    targetVersion,
    oldBinaryPath,
    destPath,
    resolveFromNetwork,
    channel,
    offline,
  } = opts;

  // Check patch cache first — enables fully offline upgrades
  const cached = await tryLoadCachedChain(VERSION, targetVersion);
  if (cached) {
    return await applyChainAndReturn(cached, oldBinaryPath, destPath);
  }

  if (offline) {
    return null;
  }

  const chain = await resolveFromNetwork();
  if (!chain) return null;

  // Save to cache for future offline upgrades, then apply
  if (chain.steps) {
    savePatchesToCache(chain, chain.steps).catch(() => {});
  }

  return await applyChainAndReturn(chain, oldBinaryPath, destPath);
}

async function tryLoadCachedChain(
  currentVersion: string,
  targetVersion: string,
): Promise<PatchChain | null> {
  try {
    return await loadCachedChain(currentVersion, targetVersion);
  } catch {
    return null;
  }
}

async function applyChainAndReturn(
  chain: PatchChain,
  oldBinaryPath: string,
  destPath: string,
): Promise<DeltaResult> {
  const sha256 = await applyPatchChain(chain, oldBinaryPath, destPath);
  return {
    sha256,
    patchBytes: chain.totalSize,
    chainLength: chain.patches.length,
  };
}

/**
 * Resolve a nightly chain with full context setup.
 */
async function resolveNightlyChainWithContext(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<PatchChain | null> {
  const token = await getAnonymousToken(signal);

  const binaryName = getPlatformBinaryName();
  const targetTag = `nightly-${targetVersion}`;

  const [nightlyManifest, patchTags] = await Promise.all([
    fetchManifest(token, targetTag, signal),
    listTags(token, PATCH_TAG_PREFIX, signal),
  ]);

  const gzLayer = nightlyManifest.layers.find((l) => {
    const title = l.annotations?.["org.opencontainers.image.title"];
    return title === `${binaryName}.gz`;
  });
  if (!gzLayer) return null;

  return await resolveNightlyChain({
    token,
    currentVersion: VERSION,
    targetVersion,
    fullGzSize: gzLayer.size,
    preloadedTags: patchTags,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

function cleanupIntermediates(destPath: string): void {
  for (const suffix of [".patching.a", ".patching.b"]) {
    try {
      unlinkSync(`${destPath}${suffix}`);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function applyPatchesSequentially(
  chain: PatchChain,
  oldBinaryPath: string,
  destPath: string,
): Promise<string> {
  let currentOldPath = oldBinaryPath;
  let sha256 = "";

  const intermediateA = `${destPath}.patching.a`;
  const intermediateB = `${destPath}.patching.b`;

  try {
    for (let i = 0; i < chain.patches.length; i++) {
      const patch = chain.patches[i];
      if (!patch) throw new Error(`Missing patch at index ${i}`);
      const isLast = i === chain.patches.length - 1;
      const intermediate = i % 2 === 0 ? intermediateA : intermediateB;
      const outputPath = isLast ? destPath : intermediate;

      sha256 = await applyPatch(currentOldPath, patch.data, outputPath);

      if (!isLast) {
        currentOldPath = outputPath;
      }
    }
  } finally {
    if (chain.patches.length > 1) {
      cleanupIntermediates(destPath);
    }
  }

  return sha256;
}

/**
 * Apply a resolved patch chain sequentially and verify the result.
 */
export async function applyPatchChain(
  chain: PatchChain,
  oldBinaryPath: string,
  destPath: string,
): Promise<string> {
  const sha256 = await applyPatchesSequentially(chain, oldBinaryPath, destPath);

  if (sha256 !== chain.expectedSha256) {
    throw new Error(
      `SHA-256 mismatch after patching: got ${sha256}, expected ${chain.expectedSha256}`,
    );
  }

  return sha256;
}

// ---------------------------------------------------------------------------
// Patch Pre-fetching (can be called during background version checks)
// ---------------------------------------------------------------------------

async function prefetchAndCache(
  targetVersion: string,
  signal: AbortSignal | undefined,
  resolveChain: () => Promise<PatchChain | null>,
): Promise<void> {
  if (!canAttemptDelta(targetVersion) || signal?.aborted) {
    return;
  }

  const chain = await resolveChain();
  if (!chain?.steps || signal?.aborted) {
    return;
  }

  await savePatchesToCache(chain, chain.steps);
}

/**
 * Pre-fetch nightly delta patches for a future upgrade.
 */
export function prefetchNightlyPatches(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return prefetchAndCache(targetVersion, signal, () =>
    resolveNightlyChainWithContext(targetVersion, signal),
  );
}

/**
 * Pre-fetch stable delta patches for a future upgrade.
 */
export function prefetchStablePatches(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return prefetchAndCache(targetVersion, signal, () =>
    resolveStableChain(VERSION, targetVersion, signal),
  );
}
