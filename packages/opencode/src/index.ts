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

/** Absolute path to the gateway entry point (src/index.ts in the workspace). */
const GATEWAY_ENTRY = new URL("../../gateway/src/index.ts", import.meta.url).pathname;

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay OpenCode startup noticeably.
 */
async function probeGateway(baseURL: string, timeoutMs = 1500): Promise<boolean> {
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
 * Spawn the gateway as a background child process and wait for it to be ready.
 * Returns true if the gateway started and is healthy, false otherwise.
 */
async function spawnGateway(gatewayBase: string): Promise<boolean> {
  try {
    const child = Bun.spawn(["bun", "run", GATEWAY_ENTRY], {
      stdout: "ignore",
      stderr: "pipe",
      // Detach from the plugin process group so it keeps running
      // even if the parent signal handler fires.
    });

    // Pipe gateway stderr to our own stderr so it's visible.
    if (child.stderr) {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(decoder.decode(value));
        }
      };
      pump().catch(() => {});
    }

    // Poll until healthy or timeout (5s max, 100ms intervals).
    for (let i = 0; i < 50; i += 1) {
      await Bun.sleep(100);
      if (await probeGateway(gatewayBase, 500)) return true;
    }

    log.info("gateway did not become healthy within 5s");
    child.kill();
    return false;
  } catch (e) {
    log.info("failed to spawn gateway:", e instanceof Error ? e.message : String(e));
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
          log.info(`starting gateway at ${gatewayBase}…`);
          if (await spawnGateway(gatewayBase)) {
            log.info(`gateway started at ${gatewayBase}`);
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
        "Check that Bun is installed and the gateway entry point exists.";
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
