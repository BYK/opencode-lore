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
 *      Targets are controlled via --target (default: current platform).
 *      Example: bun run script/build.ts --binary --target linux-x64
 *
 *      The --release flag enables gzip compression of the output.
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { processBinary } from "binpunch";

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
  rmSync(distBinDir, { recursive: true, force: true });
  mkdirSync(distBinDir, { recursive: true });

  // Step 1: esbuild bundle — single ESM file with everything inlined
  const bundlePath = join(distBinDir, "bin.js");

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
    minify: true,
    logLevel: "info",
    legalComments: "none",
    define: {
      LORE_CLI_VERSION: JSON.stringify(pkg.version),
    },
  });

  console.log(`✓ esbuild bundle: ${bundlePath}`);

  // Step 2: bun build --compile — produce native binary
  // We shell out because Bun.build({ compile }) tries to resolve externals
  // at runtime, while the CLI --compile handles them correctly.
  const ext = target.startsWith("windows") ? ".exe" : "";
  const binaryName = `lore-${target}${ext}`;
  const binaryPath = join(distBinDir, binaryName);

  const { execSync } = await import("node:child_process");
  const compileCmd = [
    "bun", "build", "--compile",
    "--target", `bun-${target}`,
    "--external", "fastembed",
    "--external", "onnxruntime-*",
    "--external", "@anush008/*",
    "--outfile", binaryPath,
    bundlePath,
  ].join(" ");

  try {
    execSync(compileCmd, { stdio: "inherit", cwd: packageDir });
  } catch {
    console.error("Bun compile failed");
    process.exit(1);
  }

  console.log(`✓ Bun compile: ${binaryPath}`);

  // Step 3: hole-punch unused ICU data entries so they compress to nearly nothing
  const hpStats = processBinary(binaryPath);
  if (hpStats && hpStats.removedEntries > 0) {
    console.log(
      `✓ hole-punched ${hpStats.removedEntries}/${hpStats.totalEntries} ICU entries`,
    );
  }

  // Step 4: gzip (release builds only)
  if (flags.release) {
    const raw = readFileSync(binaryPath);
    const compressed = gzipSync(raw, { level: 6 });
    const gzPath = `${binaryPath}.gz`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(gzPath, compressed);

    const ratio = ((compressed.length / raw.length) * 100).toFixed(1);
    console.log(
      `✓ gzip: ${gzPath} (${(compressed.length / 1024 / 1024).toFixed(1)}MB, ${ratio}% of original)`,
    );
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
