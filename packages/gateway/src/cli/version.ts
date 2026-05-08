/**
 * CLI version — replaced at build time by esbuild `define`.
 *
 * During development (running via `bun run src/index.ts`), falls back
 * to reading package.json at runtime.
 */

// esbuild replaces this with a string literal at bundle time.
// In dev mode the identifier is left as-is and we fall back below.
declare const LORE_CLI_VERSION: string | undefined;

function readVersionFromPackageJson(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

export const VERSION: string =
  typeof LORE_CLI_VERSION !== "undefined" ? LORE_CLI_VERSION : readVersionFromPackageJson();
