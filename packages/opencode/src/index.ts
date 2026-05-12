import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { log } from "@loreai/core";

/** Providers the plugin will redirect through the gateway. */
const GATEWAY_PROVIDERS: string[] = [
  "anthropic",
  "openai",
  "nvidia",
  "xai",
  "mistral",
  "google",
];

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay OpenCode startup noticeably.
 */
export async function probeGateway(baseURL: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 * Uses Bun.serve() under the hood — non-blocking, lives for the duration of the
 * host process. No subprocess management needed.
 */
export async function startInProcess(gatewayBase: string): Promise<boolean> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { loadConfig, startServer } = await import(/* webpackIgnore: true */ gw);
    const config = loadConfig();

    // Parse the expected port from gatewayBase so the server binds there.
    const url = new URL(gatewayBase);
    if (url.port) config.port = Number(url.port);

    startServer(config);
    // startServer is synchronous (Bun.serve) — if it didn't throw, the
    // server is listening. Verify with a quick health check.
    return await probeGateway(gatewayBase, 1000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Port-in-use means something is already on that port but our probe
    // didn't detect it (race). Treat as success — the proxy is available.
    // Match both Node's EADDRINUSE and Bun's "Is port N in use?" format.
    if (/EADDRINUSE/i.test(msg) || /port\b.*\bin use/i.test(msg)) {
      return await probeGateway(gatewayBase, 1000);
    }
    log.info("failed to start gateway in-process:", msg);
    return false;
  }
}


// Process-wide initialization state — shared across all sessions.
// The plugin function is called once per OpenCode session/project, but
// gateway detection only needs to run once per process.
let processInitDone = false;
let processGatewayActive = false;
let processGatewayBase = "";

/** Memoized gateway init promise — ensures concurrent plugin calls don't race. */
let gatewayInitPromise: Promise<boolean> | null = null;

export const LorePlugin: Plugin = async (ctx) => {
  // Resolve the gateway base URL — explicit env var or default.
  const gatewayBase =
    (process.env.LORE_GATEWAY_URL ?? "http://127.0.0.1:6969").replace(/\/$/, "");

  // Determine if the gateway is active — only probe once per process.
  let gatewayActive = processGatewayActive;
  if (!processInitDone) {
    const inTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.LORE_GATEWAY_MODE === "test" ||
      process.argv.some((a) => a.includes(".test."));

    if (process.env.LORE_GATEWAY_MODE !== "0" && !inTestEnv) {
      // Memoize so concurrent LorePlugin calls don't race on probe→spawn.
      if (!gatewayInitPromise) {
        gatewayInitPromise = (async () => {
          if (await probeGateway(gatewayBase)) {
            log.info(`gateway detected at ${gatewayBase}`);
            return true;
          }
          log.info(`starting gateway in-process at ${gatewayBase}…`);
          if (await startInProcess(gatewayBase)) {
            log.info(`gateway started in-process at ${gatewayBase}`);
            return true;
          }
          return false;
        })();
      }
      gatewayActive = await gatewayInitPromise;
    }
    processGatewayActive = gatewayActive;
    processGatewayBase = gatewayBase;
  }

  if (!gatewayActive && process.env.LORE_GATEWAY_MODE !== "0") {
    const inTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.LORE_GATEWAY_MODE === "test" ||
      process.argv.some((a) => a.includes(".test."));
    if (!inTestEnv) {
      const msg = "Lore gateway failed to start — memory features are unavailable. " +
        "Ensure @loreai/gateway is installed or start the gateway manually.";
      process.stderr.write(`[lore] ERROR: ${msg}\n`);
      log.error(msg);
    }
  }

  try {
  const hooks: Hooks = {
    // Disable built-in compaction (gateway handles it), register hidden
    // worker agents, and redirect all provider baseURLs through the gateway.
    config: async (input) => {
      const cfg = input as Record<string, unknown>;
      cfg.compaction = { auto: false, prune: false };
      cfg.agent = {
        ...(cfg.agent as Record<string, unknown> | undefined),
        "lore-distill": {
          hidden: true,
          description: "Lore memory distillation worker",
        },
        "lore-curator": {
          hidden: true,
          description: "Lore knowledge curator worker",
        },
        "lore-query-expand": {
          hidden: true,
          description: "Lore query expansion worker",
        },
      };

      if (gatewayActive) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = cfg.provider as Record<string, any> ?? {};
        cfg.provider = p;
        for (const providerID of GATEWAY_PROVIDERS) {
          p[providerID] ??= {};
          p[providerID].options ??= {};
          p[providerID].options!.baseURL = `${gatewayBase}/v1`;
        }
      }
    },

    tool: {},
  };

  // Startup banner — visible in stderr so silent failures are obvious.
  if (!processInitDone) {
    const projectPath = ctx.worktree || ctx.directory;
    process.stderr.write(`[lore] active: ${projectPath}\n`);

    if (gatewayActive) {
      process.stderr.write(`[lore] gateway mode — routing through ${gatewayBase}\n`);
    }

    processInitDone = true;
  }

  return hooks;
  } catch (e) {
    // Log the full error before re-throwing so OpenCode's plugin loader
    // (which catches and swallows the error) doesn't hide the root cause.
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(`[lore] init failed: ${detail}\n`);
    throw e;
  }
};

export default LorePlugin;
