/**
 * Binary entry point — called when running the standalone Bun binary
 * or directly via `bun run src/cli/bin.ts`.
 */
import { _cli } from "./main";

_cli().catch((e) => {
  if (e) console.error(e);
  process.exit(1);
});
