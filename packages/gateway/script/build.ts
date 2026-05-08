/**
 * Build @loreai/gateway.
 *
 * Two build modes:
 *
 *   1. `bun run script/build.ts` (default)
 *      Produces dist/index.js — publishable ESM bundle for npm.
 *      @loreai/core is external (workspace dep, installed alongside).
 *
 *   2. `bun run script/build.ts --binary`
 *      Produces a standalone Bun binary for GitHub Releases.
 *      Everything is bundled (core, npm deps). Only bun:* stays external.
 *
 *      Uses a two-step build to produce external sourcemaps for Sentry:
 *      1. Bundle TS → single minified JS + external .map (esbuild)
 *      2. Inject debug IDs + swap placeholder UUID → real content-hash UUID
 *      3. Compile JS → native binary per platform (bun build --compile)
 *         (sourcemap is backed up/restored around Bun compile)
 *      4. Upload .map to Sentry for server-side stack trace resolution
 *
 *      Targets are controlled via --target (default: current platform).
 *      Example: bun run script/build.ts --binary --target linux-x64
 *
 *      The --release flag enables gzip compression of the output.
 */
import * as esbuild from "esbuild";
import {
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { processBinary } from "binpunch";
import { PLACEHOLDER_DEBUG_ID, injectDebugId } from "./debug-id";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const distDir = join(packageDir, "dist");

const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    binary: { type: "boolean", default: false },
    target: { type: "string" },
    release: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

// ---------------------------------------------------------------------------
// Library build (npm publish)
// ---------------------------------------------------------------------------

async function buildLibrary() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const external = ["node:*", "@loreai/core"];

  await esbuild.build({
    entryPoints: [join(packageDir, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "node22",
    platform: "node",
    conditions: ["node"],
    external,
    outfile: join(distDir, "index.js"),
    sourcemap: true,
    logLevel: "info",
    legalComments: "inline",
  });

  console.log("✓ @loreai/gateway library build complete");
}

// ---------------------------------------------------------------------------
// Binary build (standalone Bun executable)
// ---------------------------------------------------------------------------

/** Bun compile targets we support. */
const VALID_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;

type CompileTarget = (typeof VALID_TARGETS)[number];

function currentTarget(): CompileTarget {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return `${os}-${arch}` as CompileTarget;
}

async function buildBinary() {
  const target = (flags.target ?? currentTarget()) as CompileTarget;

  if (!VALID_TARGETS.includes(target)) {
    console.error(`Invalid target: ${target}`);
    console.error(`Valid targets: ${VALID_TARGETS.join(", ")}`);
    process.exit(1);
  }

  const distBinDir = join(packageDir, "dist-bin");
  mkdirSync(distBinDir, { recursive: true });

  // Step 1: esbuild bundle — single ESM file with everything inlined
  const bundlePath = join(distBinDir, "bin.js");
  const mapPath = join(distBinDir, "bin.js.map");

  await esbuild.build({
    entryPoints: [join(packageDir, "src/cli/bin.ts")],
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "node",
    conditions: ["bun"],
    // Bun built-ins + native binary packages (fastembed/onnxruntime contain
    // platform-specific .node files that esbuild can't bundle)
    external: ["bun:*", "fastembed", "onnxruntime-*", "@anush008/*"],
    outfile: bundlePath,
    // "linked" produces an external .map file with a //# sourceMappingURL=
    // comment in the JS. This map is uploaded to Sentry (never shipped to users).
    sourcemap: "linked",
    minify: true,
    logLevel: "info",
    legalComments: "none",
    define: {
      LORE_CLI_VERSION: JSON.stringify(pkg.version),
      __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
    },
  });

  console.log(`✓ esbuild bundle: ${bundlePath}`);

  // Step 2: Inject debug IDs into the JS and sourcemap
  // skipSnippet: true — the IIFE snippet breaks ESM (placed before import
  // declarations). The debug ID is instead registered in instrument.ts via
  // the build-time __SENTRY_DEBUG_ID__ constant.
  let debugId: string | undefined;

  try {
    const result = await injectDebugId(bundlePath, mapPath, {
      skipSnippet: true,
    });
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
      const content = readFileSync(bundlePath, "utf-8");
      writeFileSync(bundlePath, content.replaceAll(PLACEHOLDER_DEBUG_ID, debugId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Debug ID placeholder replacement failed: ${msg}`);
    }
  }

  // Step 3: bun build --compile — produce native binary
  // Rename the esbuild map out of the way before Bun.build — when using
  // sourcemap: "linked", Bun writes its own map to bin.js.map. The esbuild
  // map (which maps back to original TS) is what we upload to Sentry.
  // Bun's embedded map handles runtime Error.stack → esbuild-output mapping
  // automatically, so the two compose: Bun runtime → esbuild positions →
  // original TS (via Sentry's uploaded map).
  const esbuildMapBackup = `${mapPath}.esbuild`;
  renameSync(mapPath, esbuildMapBackup);

  const ext = target.startsWith("windows") ? ".exe" : "";
  const binaryName = `lore-${target}${ext}`;
  const binaryPath = join(distBinDir, binaryName);

  const compileCmd = [
    "bun", "build", "--compile",
    "--target", `bun-${target}`,
    // "linked" embeds a sourcemap in the binary. At runtime, Bun's engine
    // auto-resolves Error.stack positions through this embedded map back to
    // the esbuild output's coordinate space.
    "--sourcemap=linked",
    "--external", "fastembed",
    "--external", "onnxruntime-*",
    "--external", "@anush008/*",
    "--outfile", binaryPath,
    bundlePath,
  ].join(" ");

  try {
    execSync(compileCmd, { stdio: "inherit", cwd: packageDir });
  } catch {
    // Restore the esbuild map even on failure
    renameSync(esbuildMapBackup, mapPath);
    console.error("Bun compile failed");
    process.exit(1);
  }

  // Restore the esbuild sourcemap (Bun.build wrote its own map)
  renameSync(esbuildMapBackup, mapPath);

  console.log(`✓ Bun compile: ${binaryPath}`);

  // Step 4: hole-punch unused ICU data entries so they compress to nearly nothing
  const hpStats = processBinary(binaryPath);
  if (hpStats && hpStats.removedEntries > 0) {
    console.log(
      `✓ hole-punched ${hpStats.removedEntries}/${hpStats.totalEntries} ICU entries`,
    );
  }

  // Step 5: gzip (release builds only)
  if (flags.release) {
    const raw = readFileSync(binaryPath);
    const compressed = gzipSync(raw, { level: 6 });
    const gzPath = `${binaryPath}.gz`;
    writeFileSync(gzPath, compressed);

    const ratio = ((compressed.length / raw.length) * 100).toFixed(1);
    console.log(
      `✓ gzip: ${gzPath} (${(compressed.length / 1024 / 1024).toFixed(1)}MB, ${ratio}% of original)`,
    );
  }

  // Step 6: Upload sourcemap to Sentry
  // The esbuild map (bin.js → original TS) is the one we upload. Bun's
  // embedded map handles the binary → esbuild-output resolution at runtime.
  let uploaded = false;

  if (process.env.SENTRY_AUTH_TOKEN) {
    console.log(`  Uploading sourcemap to Sentry (release: ${pkg.version})...`);
    try {
      execSync(
        [
          "npx", "sentry", "sourcemap", "upload", "dist-bin/",
          "--release", pkg.version,
          "--org", "byk",
          "--project", "loreai-gateway",
          "--url-prefix", "~/dist-bin/",
        ].join(" "),
        { cwd: packageDir, stdio: "inherit" },
      );
      uploaded = true;
      console.log("✓ Sourcemap uploaded to Sentry");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Sourcemap upload failed: ${msg}`);
    }
  } else {
    console.log("  No SENTRY_AUTH_TOKEN — skipping sourcemap upload");
  }

  // Clean up intermediate files (only the binary is the artifact)
  try {
    unlinkSync(bundlePath);
    if (uploaded) {
      unlinkSync(mapPath);
      console.log("✓ Sourcemap deleted (uploaded to Sentry)");
    }
  } catch {
    // Ignore
  }

  console.log(`\n✓ Binary build complete: ${binaryName} (v${pkg.version})`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (flags.binary) {
  await buildBinary();
} else {
  await buildLibrary();
}
