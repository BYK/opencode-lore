/**
 * Lore Gateway — package entry point.
 *
 * Library exports for programmatic use, plus `_cli()` for the CLI binary.
 *
 * Library usage:
 *   import { startServer, loadConfig } from "@loreai/gateway";
 *
 * CLI usage (via bin wrapper):
 *   lore start
 *   lore run claude
 */
import "../instrument";

// ---------------------------------------------------------------------------
// Library API
// ---------------------------------------------------------------------------

export { loadConfig } from "./config";
export type { GatewayConfig } from "./config";
export { startServer } from "./server";
export { handleRequest, resetPipelineState } from "./pipeline";

// ---------------------------------------------------------------------------
// CLI entry — called by dist/bin.cjs or `bun run src/index.ts`
// ---------------------------------------------------------------------------

export { _cli } from "./cli/main";

// ---------------------------------------------------------------------------
// Direct execution — `bun run src/index.ts` still works as before
// ---------------------------------------------------------------------------

if (typeof Bun !== "undefined" && Bun.main === import.meta.path) {
  // Direct execution (e.g. `bun run src/index.ts` from the OpenCode plugin)
  // defaults to server-only mode (`start`), not `run` — there's no TTY and
  // no reason to auto-detect agents when launched as an embedded server.
  // esbuild CJS output drops import.meta to `{}` so the condition is
  // always false in the npm bundle — the await is dead-code-eliminated.
  import("./cli/start").then(({ commandStart }) => commandStart({ quiet: true }));
}
