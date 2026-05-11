#!/usr/bin/env bun
/**
 * Check if the latest Claude Code version has a known cch seed.
 *
 * Compares the `latest` and `stable` npm dist-tags of @anthropic-ai/claude-code
 * against the VERSION_SEEDS map in cch.ts. Exits with code 1 if any published
 * version lacks a known seed.
 *
 * Usage:
 *   bun run scripts/check-cc-version.ts          # human-readable output
 *   bun run scripts/check-cc-version.ts --json    # machine-readable JSON
 *
 * Used by the cch-seed-check CI workflow to trigger automated seed extraction.
 */

import { parseArgs } from "util";
import { VERSION_SEEDS } from "../packages/gateway/src/cch";

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

Checks if the latest Claude Code versions on npm have known cch seeds.
Exits 0 if all versions are known, 1 if any needs extraction.

Options:
  --json    Output machine-readable JSON
  -h        Show this help`);
  process.exit(0);
}

interface DistTags {
  latest?: string;
  stable?: string;
  next?: string;
  [key: string]: string | undefined;
}

async function fetchDistTags(): Promise<DistTags> {
  const res = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code");
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { "dist-tags"?: DistTags };
  return data["dist-tags"] ?? {};
}

/**
 * Extract the base version (MAJOR.MINOR.PATCH) from a possibly suffixed
 * version string. Claude Code versions are plain semver.
 */
function baseVersion(v: string): string {
  const m = /^(\d+\.\d+\.\d+)/.exec(v);
  return m ? m[1] : v;
}

async function main() {
  const tags = await fetchDistTags();

  // Check both latest and stable tags
  const toCheck = new Map<string, string>(); // tag → version
  for (const tag of ["latest", "stable"] as const) {
    const v = tags[tag];
    if (v) toCheck.set(tag, baseVersion(v));
  }

  if (toCheck.size === 0) {
    console.error("No dist-tags found on npm for @anthropic-ai/claude-code");
    process.exit(1);
  }

  const knownVersions = new Set(Object.keys(VERSION_SEEDS));
  const results: Array<{
    tag: string;
    version: string;
    known: boolean;
  }> = [];

  let needsExtraction = false;
  let latestUnknown: string | null = null;

  for (const [tag, version] of toCheck) {
    const known = knownVersions.has(version);
    results.push({ tag, version, known });
    if (!known) {
      needsExtraction = true;
      // Prefer 'latest' for extraction; fall back to 'stable'
      if (!latestUnknown || tag === "latest") {
        latestUnknown = version;
      }
    }
  }

  if (args.json) {
    const output = {
      needsExtraction,
      latestVersion: latestUnknown ?? toCheck.get("latest") ?? "",
      tags: results,
      knownSeeds: Object.keys(VERSION_SEEDS),
    };
    console.log(JSON.stringify(output));
  } else {
    console.log("Claude Code version check:");
    console.log(`  Known seeds: ${[...knownVersions].join(", ")}`);
    console.log();
    for (const r of results) {
      const status = r.known ? "✓ known" : "✗ NEEDS EXTRACTION";
      console.log(`  ${r.tag}: ${r.version} — ${status}`);
    }
    if (needsExtraction) {
      console.log(
        `\nNew version detected: ${latestUnknown}`,
      );
      console.log(
        `Run: bun run scripts/extract-cch-seed.ts --version ${latestUnknown}`,
      );
    } else {
      console.log("\nAll published versions have known seeds.");
    }
  }

  process.exit(needsExtraction ? 1 : 0);
}

await main();
