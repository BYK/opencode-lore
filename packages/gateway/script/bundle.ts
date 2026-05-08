/**
 * Bundle @loreai/gateway into a self-contained CJS package for npm/npx.
 *
 * Produces:
 *   dist/index.cjs — single CJS bundle (gateway + core + all JS deps)
 *   dist/bin.cjs   — thin CLI wrapper with Node.js version check
 *
 * Everything is bundled except:
 *   - node:* built-ins (resolved at runtime)
 *   - fastembed + onnxruntime-* + @anush008/* (native binaries, npm installs them)
 *
 * The Bun → Node.js polyfill layer (script/node-polyfills.ts) is injected at
 * bundle time so the source code stays Bun-native.
 *
 * Debug IDs are injected into the JS + sourcemap after bundling for Sentry
 * source map resolution. When SENTRY_AUTH_TOKEN is set, sourcemaps are
 * uploaded to Sentry and then deleted (they shouldn't ship to users).
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLACEHOLDER_DEBUG_ID, injectDebugId } from "./debug-id";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const distDir = join(packageDir, "dist");

// Read version from package.json for build-time injection
const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

const jsPath = join(distDir, "index.cjs");
const mapPath = join(distDir, "index.cjs.map");

// ---------------------------------------------------------------------------
// Clean + create dist
// ---------------------------------------------------------------------------

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// ---------------------------------------------------------------------------
// esbuild: single CJS bundle with polyfills injected
// ---------------------------------------------------------------------------

// External: Node built-ins + native binary packages that npm installs
const external = [
  "node:*",
  "fastembed",
  "onnxruntime-*",
  "@anush008/*",
];

await esbuild.build({
  entryPoints: [join(packageDir, "src/index.ts")],
  bundle: true,
  format: "cjs",
  target: "node22",
  platform: "node",
  // Resolve #db/driver → driver.node.ts (node:sqlite)
  conditions: ["node"],
  external,
  outfile: jsPath,
  sourcemap: true,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  // Inject polyfills — provides Bun.serve(), Bun.zstd*, etc. under Node.js
  inject: [join(here, "node-polyfills.ts")],
  // Build-time constants
  define: {
    LORE_CLI_VERSION: JSON.stringify(pkg.version),
    __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
  },
});

// ---------------------------------------------------------------------------
// Debug ID injection + sourcemap upload
// ---------------------------------------------------------------------------

// Inject debug IDs into the JS and sourcemap.
// skipSnippet: true — the IIFE snippet breaks ESM/CJS mixed output. The
// debug ID is instead registered in instrument.ts via the build-time
// __SENTRY_DEBUG_ID__ constant.
let debugId: string | undefined;

try {
  const result = await injectDebugId(jsPath, mapPath, { skipSnippet: true });
  debugId = result.debugId;
  console.log(`✓ Debug ID injected: ${debugId}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`⚠ Debug ID injection failed: ${msg}`);
}

// Replace the placeholder UUID with the real debug ID in the JS bundle.
// Both are 36-char UUIDs so sourcemap character positions stay valid.
if (debugId) {
  try {
    const content = readFileSync(jsPath, "utf-8");
    writeFileSync(jsPath, content.replaceAll(PLACEHOLDER_DEBUG_ID, debugId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Debug ID placeholder replacement failed: ${msg}`);
  }
}

// Upload sourcemaps to Sentry if auth token is available.
// Gracefully skipped in local dev and fork PRs.
let uploaded = false;

if (process.env.SENTRY_AUTH_TOKEN) {
  console.log(`  Uploading sourcemaps to Sentry (release: ${pkg.version})...`);
  try {
    execSync(
      [
        "npx", "sentry", "sourcemap", "upload", "dist/",
        "--release", pkg.version,
        "--org", "byk",
        "--project", "loreai-gateway",
        "--url-prefix", "~/",
      ].join(" "),
      { cwd: packageDir, stdio: "inherit" },
    );
    uploaded = true;
    console.log("✓ Sourcemaps uploaded to Sentry");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Sourcemap upload failed: ${msg}`);
  }
} else {
  console.log("  No SENTRY_AUTH_TOKEN — skipping sourcemap upload");
}

// Delete .map files after successful upload — they shouldn't ship to users.
// Keep them on upload failure so a retry doesn't require a full rebuild.
if (uploaded) {
  try {
    unlinkSync(mapPath);
    console.log("✓ Sourcemap deleted (uploaded to Sentry)");
  } catch {
    // Ignore — file might already be gone
  }
}

// ---------------------------------------------------------------------------
// bin wrapper — dist/bin.cjs
// ---------------------------------------------------------------------------

const binScript = `#!/usr/bin/env node
// lore CLI — Node.js entry point
// Checks Node version, suppresses experimental warnings, runs CLI.
{
  const v = process.versions.node.split(".").map(Number);
  if (v[0] < 22 || (v[0] === 22 && v[1] < 15)) {
    console.error(
      "Error: lore requires Node.js 22.15 or later (found " +
        process.version +
        ").\\n\\n" +
        "Either upgrade Node.js, or install the standalone binary instead:\\n" +
        "  curl -fsSL https://lore.dev/install | bash\\n"
    );
    process.exit(1);
  }
}
{
  const _emit = process.emit;
  process.emit = function (name, ...args) {
    if (name === "warning") return false;
    return _emit.apply(this, [name, ...args]);
  };
}
require("./index.cjs")._cli().catch((e) => {
  if (e) console.error(e);
  process.exitCode = 1;
});
`;

writeFileSync(join(distDir, "bin.cjs"), binScript, { mode: 0o755 });

console.log(`\n✓ @loreai/gateway npm bundle complete (v${pkg.version})`);
console.log(`  dist/index.cjs — CJS bundle`);
console.log(`  dist/bin.cjs   — CLI wrapper`);
