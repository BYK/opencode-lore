/**
 * Build @loreai/gateway into a publishable ESM bundle for Node.
 *
 * External — resolved at consumer install time, NOT bundled:
 *
 * - `@loreai/core` — published separately as a workspace dependency.
 * - `node:*` — Node built-in modules.
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const distDir = join(packageDir, "dist");

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

console.log("✓ @loreai/gateway build complete");
