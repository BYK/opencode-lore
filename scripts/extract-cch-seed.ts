#!/usr/bin/env bun
/**
 * Extract the xxHash64 seed from a Claude Code binary using oracle pairs.
 *
 * Oracle pairs are (body_with_placeholder, expected_cch) tuples captured
 * from live traffic — the gateway sees the client's signed cch and can
 * reconstruct the body with `cch=00000` by replacing the signed value.
 *
 * Usage:
 *   bun run scripts/extract-cch-seed.ts --version 2.1.138 --oracle oracle-pairs.json
 *   bun run scripts/extract-cch-seed.ts --binary ./claude --oracle oracle-pairs.json
 *
 * Oracle pairs JSON format:
 *   [
 *     { "body": "{...cch=00000...}", "cch": "a39d0" },
 *     { "body": "{...cch=00000...}", "cch": "6fc47" }
 *   ]
 *
 * The script:
 *   1. Downloads the ARM64 macOS binary from npm (or uses --binary)
 *   2. Tests every 8-byte aligned offset as a candidate seed
 *   3. Reports matches that satisfy ALL oracle pairs
 *   4. Falls back to 1-byte aligned scan if no 8-byte match found
 *
 * Performance: ~8s for 8-byte aligned scan of a 196MB binary.
 * Two oracle pairs eliminate all false positives (1-in-2^40 collision).
 */

import { readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", short: "v" },
    binary: { type: "string", short: "b" },
    oracle: { type: "string", short: "o" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help || (!args.version && !args.binary) || !args.oracle) {
  console.log(`Usage:
  bun run scripts/extract-cch-seed.ts --version <VERSION> --oracle <pairs.json>
  bun run scripts/extract-cch-seed.ts --binary <path> --oracle <pairs.json>

Options:
  -v, --version   Claude Code version to download from npm (e.g. 2.1.138)
  -b, --binary    Path to existing ARM64 macOS binary
  -o, --oracle    Path to oracle pairs JSON file
  -h, --help      Show this help

Oracle pairs JSON format:
  [{"body": "...body with cch=00000...", "cch": "a39d0"}, ...]

At least 2 oracle pairs are recommended to eliminate false positives.`);
  process.exit(args.help ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Load oracle pairs
// ---------------------------------------------------------------------------

interface OraclePair {
  body: string;
  cch: string;
}

const oraclePath = args.oracle!;
if (!existsSync(oraclePath)) {
  console.error(`Oracle file not found: ${oraclePath}`);
  process.exit(1);
}

const pairs: OraclePair[] = JSON.parse(readFileSync(oraclePath, "utf-8"));
if (!Array.isArray(pairs) || pairs.length === 0) {
  console.error("Oracle file must contain a non-empty JSON array");
  process.exit(1);
}

for (const [i, pair] of pairs.entries()) {
  if (!pair.body || !pair.cch) {
    console.error(`Oracle pair ${i} missing 'body' or 'cch' field`);
    process.exit(1);
  }
  if (!pair.body.includes("cch=00000")) {
    console.error(
      `Oracle pair ${i} body must contain 'cch=00000' placeholder`,
    );
    process.exit(1);
  }
  if (!/^[0-9a-f]{5}$/.test(pair.cch)) {
    console.error(
      `Oracle pair ${i} cch must be a 5-char lowercase hex string, got: ${pair.cch}`,
    );
    process.exit(1);
  }
}

console.log(`Loaded ${pairs.length} oracle pair(s)`);
if (pairs.length < 2) {
  console.warn(
    "WARNING: <2 oracle pairs — expect false positives (~11 per pair)",
  );
}

// ---------------------------------------------------------------------------
// Obtain binary
// ---------------------------------------------------------------------------

let binaryPath: string;

if (args.binary) {
  binaryPath = args.binary;
  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    process.exit(1);
  }
} else {
  const version = args.version!;
  const pkg = `@anthropic-ai/claude-code-darwin-arm64@${version}`;
  const tmpDir = "/tmp/cch-seed-extract";
  mkdirSync(tmpDir, { recursive: true });

  console.log(`Downloading ${pkg} from npm...`);
  try {
    execSync(`npm pack ${pkg} --pack-destination ${tmpDir}`, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpDir,
    });
  } catch (e: any) {
    console.error(`Failed to download ${pkg}: ${e.message}`);
    process.exit(1);
  }

  // Find the tarball
  const tgzFiles = new Bun.Glob("anthropic-ai-claude-code-darwin-arm64-*.tgz");
  let tgzPath = "";
  for (const file of tgzFiles.scanSync(tmpDir)) {
    tgzPath = `${tmpDir}/${file}`;
    break;
  }
  if (!tgzPath) {
    console.error("Could not find downloaded tarball");
    process.exit(1);
  }

  console.log("Extracting binary from tarball...");
  execSync(`tar xzf "${tgzPath}" -C "${tmpDir}"`, { stdio: "pipe" });
  binaryPath = `${tmpDir}/package/claude`;

  if (!existsSync(binaryPath)) {
    console.error(`Expected binary at ${binaryPath} after extraction`);
    process.exit(1);
  }

  // Clean up tarball
  try {
    unlinkSync(tgzPath);
  } catch {}
}

const binary = readFileSync(binaryPath);
console.log(`Binary: ${binaryPath} (${(binary.length / 1024 / 1024).toFixed(1)} MB)`);

// ---------------------------------------------------------------------------
// Scan for seed
// ---------------------------------------------------------------------------

function testCandidate(seed: bigint, pairs: OraclePair[]): boolean {
  for (const pair of pairs) {
    const hash = Bun.hash.xxHash64(pair.body, seed);
    const cch = (hash & 0xFFFFFn).toString(16).padStart(5, "0");
    if (cch !== pair.cch) return false;
  }
  return true;
}

function scan(alignment: number): bigint | null {
  const candidates = Math.floor((binary.length - 7) / alignment);
  const label = alignment === 8 ? "8-byte aligned" : "1-byte aligned";
  console.log(`\nScanning ${candidates.toLocaleString()} ${label} candidates...`);

  const start = performance.now();
  let tested = 0;
  const matches: Array<{ offset: number; seed: bigint }> = [];

  for (let offset = 0; offset + 8 <= binary.length; offset += alignment) {
    const candidate = binary.readBigUInt64LE(offset);
    if (candidate === 0n) continue;

    if (testCandidate(candidate, pairs)) {
      matches.push({ offset, seed: candidate });
      console.log(
        `  MATCH at offset 0x${offset.toString(16)}: seed = 0x${candidate.toString(16).padStart(16, "0")}`,
      );
    }
    tested++;
  }

  const elapsed = performance.now() - start;
  console.log(
    `Scan complete: ${tested.toLocaleString()} tested in ${(elapsed / 1000).toFixed(1)}s`,
  );

  if (matches.length === 0) {
    console.log("No matches found.");
    return null;
  }

  if (matches.length === 1) {
    console.log(`\n✓ Found exactly 1 seed: 0x${matches[0].seed.toString(16).padStart(16, "0")}`);
    return matches[0].seed;
  }

  console.log(
    `\n⚠ Found ${matches.length} matches — add more oracle pairs to disambiguate`,
  );
  return null;
}

// Try 8-byte aligned first
let seed = scan(8);

// Fall back to 1-byte aligned if needed
if (seed === null) {
  console.log("\nFalling back to 1-byte aligned scan...");
  seed = scan(1);
}

if (seed !== null) {
  const hex = seed.toString(16).padStart(16, "0").toUpperCase();
  const version = args.version ?? "UNKNOWN";
  console.log(`
================================================================================
Add this to VERSION_SEEDS in packages/gateway/src/cch.ts:

  "${version}": 0x${hex}n,

Then update WORKER_VERSION and WORKER_SALT if pinning to this version.
================================================================================`);
} else {
  console.error(
    "\nFailed to find seed. Possible causes:\n" +
      "  - Oracle pairs are incorrect (wrong body or cch value)\n" +
      "  - Seed is constructed at runtime (not stored as raw bytes)\n" +
      "  - Binary is for the wrong platform/version",
  );
  process.exit(1);
}
