/**
 * Build @loreai/pi into a publishable ESM bundle for Node.
 *
 * Pi runs on Node exclusively (unlike OpenCode which is Bun), so we only
 * build one target with `node:sqlite` imports preserved via `conditions: ["node"]`.
 *
 * External — all of these are resolved at consumer install time, NOT bundled:
 *
 * - `@loreai/gateway` — started in-process via dynamic import; published
 *   separately so users benefit from gateway updates without a pi republish.
 * - `@mariozechner/*` — Pi bundles these internally and injects them via
 *   jiti's virtualModules when loading extensions. Bundling our own copies
 *   would break: jiti resolves imports to the virtual modules, but if we
 *   inline a copy in our bundle, code that depends on module identity
 *   (extension type checks, event bus registrations) sees two different
 *   instances and silently fails to register.
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
  "@loreai/gateway",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
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

// Copy type declarations into dist/ so the top-level index.d.ts resolves
// for downstream consumers.
const typesDir = join(distDir, "types");
if (existsSync(join(typesDir, "index.d.ts"))) {
  for (const name of ["index.d.ts", "index.d.ts.map"]) {
    const src = join(typesDir, name);
    if (existsSync(src)) cpSync(src, join(distDir, name));
  }
}

console.log("✓ @loreai/pi build complete");
