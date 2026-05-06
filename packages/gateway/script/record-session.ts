#!/usr/bin/env bun
/**
 * Start the Lore gateway in recording mode.
 *
 * All upstream API traffic is transparently captured to an NDJSON fixture
 * file.  Each recorded turn can later be replayed deterministically in
 * integration tests without hitting the real Anthropic API.
 *
 * Usage:
 *   bun run packages/gateway/script/record-session.ts [output-file]
 *
 * Default output:
 *   packages/gateway/test/fixtures/recorded-<timestamp>.ndjson
 *
 * Environment variables (set before running):
 *   ANTHROPIC_API_KEY   — required; forwarded to upstream Anthropic
 *   LORE_DB_PATH        — override Lore's SQLite DB path (optional)
 *   LORE_LISTEN_PORT    — gateway listen port (default 6969)
 *   LORE_LISTEN_HOST    — gateway listen host (default 127.0.0.1)
 *   LORE_UPSTREAM_ANTHROPIC — upstream URL (default https://api.anthropic.com)
 *   LORE_DEBUG          — set to "1" to enable request logging
 *
 * After recording, use the fixture for replay tests:
 *   bun test packages/gateway/test/replay.test.ts FIXTURE=<file>
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startRecording, getRecordedInterceptor } from "../src/recorder";
import { setUpstreamInterceptor } from "../src/pipeline";
import { startServer } from "../src/server";
import { loadConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Resolve paths relative to this file
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const fixturesDir = resolve(packageDir, "test", "fixtures");

// ---------------------------------------------------------------------------
// Determine output path
// ---------------------------------------------------------------------------

const customPath = process.argv[2];
const outputPath = customPath
  ? resolve(customPath)
  : resolve(fixturesDir, `recorded-${Date.now()}.ndjson`);

// Ensure the fixtures directory (or the parent of any custom path) exists
mkdirSync(dirname(outputPath), { recursive: true });

// ---------------------------------------------------------------------------
// Start recording
// ---------------------------------------------------------------------------

startRecording(outputPath);

const interceptor = getRecordedInterceptor();
if (!interceptor) {
  console.error("[record] ERROR: failed to create recording interceptor");
  process.exit(1);
}
setUpstreamInterceptor(interceptor);

// ---------------------------------------------------------------------------
// Start the gateway server
// ---------------------------------------------------------------------------

const config = loadConfig();
const server = startServer(config);

// ---------------------------------------------------------------------------
// Print usage instructions
// ---------------------------------------------------------------------------

const relOutput = outputPath.startsWith(packageDir)
  ? outputPath.slice(packageDir.length + 1)
  : outputPath;

console.error(`[record] Recording to: ${relOutput}`);
console.error(
  `[record] Gateway running at http://${config.host}:${server.port}`,
);
console.error("[record] ");
console.error("[record] Point your client at this URL:");
console.error(
  `[record]   export ANTHROPIC_BASE_URL=http://${config.host}:${server.port}`,
);
console.error(
  `[record]   # or: "provider": {"anthropic": {"options": {"baseURL": "http://${config.host}:${server.port}/v1"}}}`,
);
console.error("[record] ");
console.error("[record] Press Ctrl+C to stop recording.");

// ---------------------------------------------------------------------------
// SIGINT handler — print stats and exit
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  // stopRecording() clears the module-level path; seqCounter stays at its
  // final value, which equals the number of turns captured.
  // We import stopRecording lazily to read seqCounter after all turns.
  import("../src/recorder").then(({ stopRecording }) => {
    stopRecording();
  });

  server.stop();

  // Re-read the fixture file to count lines (most reliable turn count)
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const lines = readFileSync(outputPath, "utf8")
      .split("\n")
      .filter((l: string) => l.trim().length > 0);
    console.error(
      `\n[record] Stopped. ${lines.length} turn(s) recorded to: ${relOutput}`,
    );
  } catch {
    console.error(`\n[record] Stopped. Fixture written to: ${relOutput}`);
  }

  process.exit(0);
});
