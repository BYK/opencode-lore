/**
 * CLI entry point — argument parsing and command dispatch.
 *
 * Uses Node.js built-in `parseArgs` from `node:util`.
 *
 * Commands:
 *   (none) / run   → start gateway + launch agent
 *   start          → start gateway server only
 *   data           → inspect and manage stored data
 *   recall         → search project memory from the terminal
 *   upgrade        → self-update
 *   help           → print usage
 */
import { parseArgs } from "node:util";
import { printHelp, printVersion } from "./help";
import { commandStart, type StartOptions } from "./start";
import {
  abortPendingVersionCheck,
  getUpdateNotification,
  maybeCheckForUpdateInBackground,
  shouldSuppressNotification,
} from "./lib/version-check";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Options shared by all commands. */
const OPTIONS = {
  port: { type: "string" as const, short: "p" },
  host: { type: "string" as const, short: "H", multiple: true },
  debug: { type: "boolean" as const, short: "d" },
  version: { type: "boolean" as const, short: "v" },
  help: { type: "boolean" as const, short: "h" },
  // Hidden diagnostic: prints the vendored-fastembed registration set by
  // the binary build wrapper (or "none" in npm mode). Used by CI to verify
  // the embed-asset pipeline actually wired up. Not in help text.
  "print-vendor-info": { type: "boolean" as const },
  // Hidden diagnostic: actually exercises the local embedding provider
  // (extracts vendor → loads fastembed → embeds a sample string) and
  // prints success or the failure reason. Used by CI to catch model-load
  // regressions that --print-vendor-info alone wouldn't surface.
  "check-embeddings": { type: "boolean" as const },
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
  host?: string[];
  debug?: boolean;
}): StartOptions {
  // Flatten: each --host value may itself be comma-separated
  const hosts = values.host
    ?.flatMap((h) => h.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    port: values.port ? parsePort(values.port) : undefined,
    hosts: hosts?.length ? hosts : undefined,
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

  // --print-vendor-info (hidden; used by CI to verify the binary's
  // vendor wrapper ran before any other code and registered the model
  // path on globalThis). Lazy-import so the npm-mode bundle doesn't pay
  // the cost.
  if (values["print-vendor-info"]) {
    const { embeddingVendor } = await import("@loreai/core");
    const reg = embeddingVendor.vendorRegistration();
    console.log(reg ? JSON.stringify(reg) : "none");
    return;
  }

  // --check-embeddings (hidden). End-to-end smoke for the embedding
  // pipeline: materialises the bundled side-load lib + model files,
  // loads fastembed, runs one embedding through the local provider,
  // prints `ok dim=N` or a clear failure message. Used by CI to catch
  // regressions in the model load path that --print-vendor-info
  // wouldn't surface (e.g. ONNX file mismatches, tokenizer file naming
  // issues, dlopen install_name drift on macOS/Windows).
  if (values["check-embeddings"]) {
    const { embedding } = await import("@loreai/core");
    try {
      const [vec] = await embedding.embed(["hello world"], "query");
      if (!vec || vec.length === 0) {
        console.error("✗ embed returned empty vector");
        process.exit(1);
      }
      console.log(`ok dim=${vec.length}`);
    } catch (err) {
      console.error(
        `✗ embed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
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
    values as { port?: string; host?: string[]; debug?: boolean },
  );

  // Start background update check (non-blocking).
  // Suppressed for commands where the banner would be confusing or redundant.
  const suppressNotification = shouldSuppressNotification(positionals);
  if (!suppressNotification) {
    maybeCheckForUpdateInBackground();
  }

  try {
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

      case "data": {
        const { commandData } = await import("./data");
        await commandData(rest, values as Record<string, unknown>);
        break;
      }

      case "recall": {
        const { commandRecall } = await import("./recall-cmd");
        await commandRecall(rest, values as Record<string, unknown>);
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
  } finally {
    // Abort any pending version check to allow clean exit
    abortPendingVersionCheck();
  }

  // Show update notification after command completes
  if (!suppressNotification) {
    const notification = getUpdateNotification();
    if (notification) {
      process.stderr.write(notification);
    }
  }
}
