/**
 * Build @loreai/core into publishable ESM bundles.
 *
 * Two targets:
 * - dist/node/index.js — uses node:sqlite (for Pi extension, ACP server, etc.)
 * - dist/bun/index.js  — uses bun:sqlite  (for OpenCode plugin)
 *
 * esbuild resolves the `#db/driver` subpath import map per target via
 * `conditions: ["node"]` or `conditions: ["bun"]`.
 *
 * TypeScript declarations (.d.ts) are emitted separately by `tsc` below.
 * esbuild alone can't produce declarations.
 *
 * Runs under either Bun (during `bun run build`) or Node; the build itself is
 * runtime-agnostic (esbuild is a plain npm package).
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here); // packages/core
const distDir = join(packageDir, "dist");

// Clean previous output so stale files don't leak into the published tarball.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Dependencies that should stay external — either because they're runtime
// built-ins (node:*, bun:*), workspace/peer deps (@loreai/*, @opencode-ai/*),
// or because they're runtime-only concerns that npm will install alongside.
//
// We intentionally DO bundle `remark`, `mdast-*`, `uuidv7`, `zod`, and other
// pure-JS dependencies so consumers get a single-file bundle and can't break
// us by upgrading transitive deps. This matches what most published libraries
// do and keeps the install footprint small.
// Runtime built-ins. `platform: "node"` auto-externalizes `fs`, `path`, etc.
// We list `node:*` and `bun:*` explicitly so any `node:` or `bun:` prefixed
// import is preserved as-is in the output (important for bun:sqlite).
const external = ["node:*", "bun:*"];

/** @type {esbuild.BuildOptions} */
const commonOptions: esbuild.BuildOptions = {
  entryPoints: [join(packageDir, "src/index.ts")],
  bundle: true,
  format: "esm",
  target: "esnext",
  external,
  sourcemap: true,
  logLevel: "info",
  legalComments: "inline",
};

async function buildTarget(target: "node" | "bun") {
  const outdir = join(distDir, target);
  mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    ...commonOptions,
    // conditions: selects which branch of the `imports` map to follow for
    // subpath imports like `#db/driver`. "node" → driver.node.ts, "bun" → driver.bun.ts.
    conditions: [target],
    // platform: "node" for both — Bun implements Node's built-in modules too,
    // so keeping `fs`, `path`, etc. as external bare specifiers works in both
    // runtimes. Using `platform: "neutral"` for the bun target would require
    // us to list every built-in explicitly in `external`.
    platform: "node",
    outfile: join(outdir, "index.js"),
  });
  console.log(`✓ built dist/${target}/index.js`);
}

console.log("Building @loreai/core (node + bun targets)...");
await Promise.all([buildTarget("node"), buildTarget("bun")]);

// Emit .d.ts declarations via tsc using tsconfig.build.json, which scopes
// the program to src/ only (the dev-time tsconfig.json also includes test/
// and script/ which we don't want to ship declarations for).
console.log("Emitting type declarations...");
execSync("tsc -p tsconfig.build.json", {
  cwd: packageDir,
  stdio: "inherit",
});

// Copy the full types tree under each target dir so re-exports from index.d.ts
// (like `export * as distillation from "./distillation"`) resolve correctly
// when TypeScript follows the per-target exports map.
const typesDir = join(distDir, "types");
if (existsSync(join(typesDir, "index.d.ts"))) {
  for (const target of ["node", "bun"] as const) {
    cpSync(typesDir, join(distDir, target), { recursive: true });
  }
  console.log("✓ declarations copied to dist/{node,bun}/");
}

console.log("build complete");
