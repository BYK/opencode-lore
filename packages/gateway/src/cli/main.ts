/**
 * CLI entry point — argument parsing and command dispatch.
 *
 * Uses Node.js built-in `parseArgs` from `node:util`.
 *
 * Commands:
 *   (none) / run   → start gateway + launch agent
 *   start          → start gateway server only
 *   upgrade        → self-update
 *   help           → print usage
 */
import { parseArgs } from "node:util";
import { printHelp, printVersion } from "./help";
import { commandStart, type StartOptions } from "./start";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Options shared by all commands. */
const OPTIONS = {
  port: { type: "string" as const, short: "p" },
  host: { type: "string" as const, short: "H" },
  debug: { type: "boolean" as const, short: "d" },
  version: { type: "boolean" as const, short: "v" },
  help: { type: "boolean" as const, short: "h" },
} as const;

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) {
    console.error(`Error: Invalid port "${value}". Must be 0–65535.`);
    process.exit(1);
  }
  return n;
}

function buildStartOptions(values: {
  port?: string;
  host?: string;
  debug?: boolean;
}): StartOptions {
  return {
    port: values.port ? parsePort(values.port) : undefined,
    host: values.host ?? undefined,
    debug: values.debug ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function _cli(): Promise<void> {
  // Parse known options, allow positional args for command + pass-through
  let values: ReturnType<typeof parseArgs>["values"];
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    printHelp();
    process.exit(1);
  }

  // --version / -v
  if (values.version) {
    printVersion();
    return;
  }

  // --help / -h (no command)
  if (values.help && positionals.length === 0) {
    printHelp();
    return;
  }

  // Determine command (first positional, or "run" as default)
  const command = positionals[0] ?? "run";
  const rest = positionals.slice(1);

  const startOpts = buildStartOptions(
    values as { port?: string; host?: string; debug?: boolean },
  );

  switch (command) {
    case "start":
      await commandStart(startOpts);
      break;

    case "run": {
      // Lazy-import to avoid pulling in child_process + agent detection
      // when only `lore start` or `lore help` is needed.
      const { commandRun } = await import("./run");
      await commandRun(startOpts, rest);
      break;
    }

    case "upgrade": {
      const { commandUpgrade } = await import("./upgrade");
      await commandUpgrade(rest);
      break;
    }

    case "help":
      printHelp();
      break;

    default:
      // Unknown first arg — treat it as `lore run <unknown> ...`
      // This allows `lore claude` as shorthand for `lore run claude`.
      {
        const { commandRun } = await import("./run");
        await commandRun(startOpts, [command, ...rest]);
      }
      break;
  }
}
