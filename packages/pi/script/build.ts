/**
 * Build @loreai/pi into a publishable ESM bundle for Node.
 *
 * Pi runs on Node exclusively (unlike OpenCode which is Bun), so we only
 * build one target with `node:sqlite` imports preserved via `conditions: ["node"]`.
 *
 * External — all of these are resolved at consumer install time, NOT bundled:
 *
 * - `@loreai/core` — published separately; users picking up a new core
 *   version (security/bug fix) automatically benefit without a pi republish.
 * - `@mariozechner/*` — Pi bundles these internally and injects them via
 *   jiti's virtualModules when loading extensions. Bundling our own copies
 *   would break: jiti resolves imports to the virtual modules, but if we
 *   inline a copy in our bundle, code that depends on module identity
 *   (extension type checks, event bus registrations) sees two different
 *   instances and silently fails to register.
 * - `@sinclair/typebox` — Pi bundles this via the same virtualModules
 *   mechanism. Pi's docs explicitly require pi-package authors to mark
 *   it as a peerDependency. We inlined it previously, which is why our
 *   v0.10.1 extension silently didn't register in real Pi installs.
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const distDir = join(packageDir, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const external = [
  "node:*",
  "@loreai/core",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
];

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

console.log("Emitting type declarations...");
execSync("tsc -p tsconfig.build.json", {
  cwd: packageDir,
  stdio: "inherit",
});

// Copy the full types tree (peer module .d.ts files) into dist/ so the
// top-level re-exports in index.d.ts resolve for downstream consumers.
const typesDir = join(distDir, "types");
if (existsSync(join(typesDir, "index.d.ts"))) {
  // Keep a flat dist/*.d.ts layout rather than dist/{node,bun}/ since Pi
  // only targets Node.
  for (const name of ["index.d.ts", "index.d.ts.map"]) {
    const src = join(typesDir, name);
    if (existsSync(src)) cpSync(src, join(distDir, name));
  }
  // Copy peer module declarations (adapter.d.ts, llm-adapter.d.ts, reflect.d.ts).
  cpSync(typesDir, distDir, { recursive: true });
}

console.log("✓ @loreai/pi build complete");
