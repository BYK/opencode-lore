#!/usr/bin/env bun
/**
 * Check if recent Claude Code versions have known cch seeds.
 *
 * Fetches all published versions of @anthropic-ai/claude-code from npm,
 * identifies every version between the highest known seed and the latest
 * dist-tag that lacks a seed, and reports them for extraction.
 *
 * Usage:
 *   bun run scripts/check-cc-version.ts          # human-readable output
 *   bun run scripts/check-cc-version.ts --json    # machine-readable JSON
 *
 * JSON output includes:
 *   - latestVersion: the latest dist-tag version (becomes WORKER_VERSION)
 *   - missingVersions: all versions between last known seed and latest (inclusive)
 *     that don't have a seed yet, sorted ascending
 *
 * Used by the cch-seed-check CI workflow to trigger automated seed extraction.
 */

import { parseArgs } from "util";
import { VERSION_SEEDS, _parseSemver, _compareSemver } from "../packages/gateway/src/cch";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage:
  bun run scripts/check-cc-version.ts [--json]

Checks if recent Claude Code versions on npm have known cch seeds.
Exits 0 if all versions are known, 1 if any needs extraction.

JSON output fields:
  needsExtraction   Whether any version needs seed extraction
  latestVersion     The npm 'latest' dist-tag version
  missingVersions   All versions needing extraction, sorted ascending
  knownSeeds        Currently known seed versions

Options:
  --json    Output machine-readable JSON
  -h        Show this help`);
  process.exit(0);
}

interface NpmRegistryData {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, unknown>;
}

async function fetchRegistry(): Promise<NpmRegistryData> {
  const res = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code");
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as NpmRegistryData;
}

/**
 * Extract the base version (MAJOR.MINOR.PATCH) from a possibly suffixed
 * version string. Claude Code versions are plain semver.
 */
function baseVersion(v: string): string {
  const m = /^(\d+\.\d+\.\d+)/.exec(v);
  return m ? m[1] : v;
}

/**
 * Compare two semver strings. Returns negative if a < b, positive if a > b, 0 if equal.
 */
function cmpVersions(a: string, b: string): number {
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  if (!pa || !pb) return 0;
  return _compareSemver(pa, pb);
}

async function main() {
  const registry = await fetchRegistry();
  const distTags = registry["dist-tags"] ?? {};
  const allPublished = Object.keys(registry.versions ?? {});

  const latestTag = distTags.latest ? baseVersion(distTags.latest) : null;
  if (!latestTag) {
    console.error("No 'latest' dist-tag found on npm for @anthropic-ai/claude-code");
    process.exit(1);
  }

  // Find the highest known seed version
  const knownVersions = Object.keys(VERSION_SEEDS);
  const sortedKnown = [...knownVersions].sort(cmpVersions);
  const highestKnown = sortedKnown[sortedKnown.length - 1];

  // Find all published versions > highestKnown and <= latest that lack seeds
  const missingVersions = allPublished
    .map(baseVersion)
    .filter((v) => {
      if (VERSION_SEEDS[v]) return false; // already known
      if (!_parseSemver(v)) return false; // skip unparseable
      return cmpVersions(v, highestKnown) > 0 && cmpVersions(v, latestTag) <= 0;
    })
    .sort(cmpVersions);

  // Deduplicate (baseVersion could collapse pre-release suffixes)
  const uniqueMissing = [...new Set(missingVersions)];

  const needsExtraction = uniqueMissing.length > 0;

  if (args.json) {
    const output = {
      needsExtraction,
      latestVersion: latestTag,
      missingVersions: uniqueMissing,
      knownSeeds: knownVersions,
    };
    console.log(JSON.stringify(output));
  } else {
    console.log("Claude Code version check:");
    console.log(`  Known seeds: ${sortedKnown.join(", ")}`);
    console.log(`  Highest known: ${highestKnown}`);
    console.log(`  Latest on npm: ${latestTag}`);
    console.log();
    if (needsExtraction) {
      console.log(`Missing seeds for ${uniqueMissing.length} version(s):`);
      for (const v of uniqueMissing) {
        console.log(`  ✗ ${v}`);
      }
      console.log(
        `\nRun: bun run scripts/extract-cch-seed.ts --version <VERSION>`,
      );
    } else {
      console.log("All published versions have known seeds.");
    }
  }

  process.exit(needsExtraction ? 1 : 0);
}

await main();
