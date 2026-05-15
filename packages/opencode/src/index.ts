import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { log, getGitRemote } from "@loreai/core";

/** Providers the plugin will redirect through the gateway. */
const GATEWAY_PROVIDERS: string[] = [
  "anthropic",
  "openai",
  "nvidia",
  "xai",
  "mistral",
  "google",
];

/** Default ports to probe when looking for a running gateway (must match gateway defaults). */
const KNOWN_GATEWAY_PORTS = [3207, 5673];

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
 * Resolve the gateway URL by probing known ports and reading the port file.
 *
 * Order: LORE_GATEWAY_URL env var → port file → known default ports (3207, 5673).
 * Returns the URL of a running gateway, or null if none found.
 */
async function resolveGatewayUrl(): Promise<string | null> {
  // 0. Remote gateway — skip local discovery/startup entirely.
  if (process.env.LORE_REMOTE_URL) {
    const url = process.env.LORE_REMOTE_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    log.info(`remote gateway at ${url} not reachable, falling through to local discovery`);
  }

  // 1. Explicit env var — probe it to verify it's actually reachable.
  if (process.env.LORE_GATEWAY_URL) {
    const url = process.env.LORE_GATEWAY_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    // env var set but gateway unreachable — fall through to discovery
  }

  // 2. Build probe list: port file first (handles random port), then known defaults.
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    /* gateway package not available — skip port file */
  }
  for (const p of KNOWN_GATEWAY_PORTS) probePorts.add(p);

  // 3. Probe each port.
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }

  return null;
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 *
 * Uses startGateway() which handles the full port fallback chain
 * (3207 → 5673 → random) and port file management automatically.
 * Returns the URL of the started gateway, or null on failure.
 */
async function startInProcess(): Promise<string | null> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true });
    const url = `http://127.0.0.1:${handle.port}`;

    if (!handle.owned) {
      log.info(`reusing existing gateway at ${url}`);
    }

    return url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.info("failed to start gateway in-process:", msg);
    return null;
  }
}


// Process-wide initialization state — shared across all sessions.
// The plugin function is called once per OpenCode session/project, but
// lore init only needs to run once per process.
let processInitDone = false;
let processLoreActive = false;
let processLoreBase = "";

/** Memoized lore init promise — ensures concurrent plugin calls don't race. */
let loreInitPromise: Promise<string | null> | null = null;

export const LorePlugin: Plugin = async (ctx) => {
  // Initialize lore — only probe/start once per process.
  const loreDisabled =
    process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";
  let loreActive = processLoreActive;
  let gatewayBase = processLoreBase;
  if (!processInitDone) {
    const inTestEnv =
      process.env.NODE_ENV === "test" ||
      process.argv.some((a) => a.includes(".test."));

    if (!loreDisabled && !inTestEnv) {
      // Memoize so concurrent LorePlugin calls don't race on probe→spawn.
      if (!loreInitPromise) {
        loreInitPromise = (async () => {
          // Try to find a running gateway first (probes port file + known ports).
          const existingUrl = await resolveGatewayUrl();
          if (existingUrl) {
            log.info(`gateway detected at ${existingUrl}`);
            return existingUrl;
          }
          // No running gateway — start one in-process (handles fallback chain).
          log.info("starting gateway in-process…");
          const startedUrl = await startInProcess();
          if (startedUrl) {
            log.info(`gateway started in-process at ${startedUrl}`);
            return startedUrl;
          }
          return null;
        })();
      }
      const result = await loreInitPromise;
      if (result) {
        loreActive = true;
        gatewayBase = result;
      }
    }
    processLoreActive = loreActive;
    processLoreBase = gatewayBase;
  }

  if (!loreActive && !loreDisabled) {
    const inTestEnv =
      process.env.NODE_ENV === "test" ||
      process.argv.some((a) => a.includes(".test."));
    if (!inTestEnv) {
      const msg = "Lore failed to start — memory features are unavailable. " +
        "Ensure @loreai/gateway is installed.";
      process.stderr.write(`[lore] ERROR: ${msg}\n`);
      log.error(msg);
    }
  }

  // Cache the git remote URL once per process (computed lazily on first
  // chat.headers call). Avoids spawning `git remote -v` on every turn.
  let cachedGitRemote: string | undefined;

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

      if (loreActive) {
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

    // Inject the agent name so the gateway can distinguish meta requests
    // (title generation, summary agents, etc.) from real conversation turns.
    // Also inject the git remote URL so the remote gateway can group
    // worktrees/clones of the same repo without filesystem access.
    "chat.headers": async (input, output) => {
      output.headers["x-lore-agent"] = input.agent;
      if (cachedGitRemote === undefined) {
        const projectPath = ctx.worktree || ctx.directory;
        cachedGitRemote = getGitRemote(projectPath) ?? "";
      }
      if (cachedGitRemote) {
        output.headers["x-lore-git-remote"] = cachedGitRemote;
      }
    },
  };

  // Startup banner — visible in stderr so silent failures are obvious.
  if (!processInitDone) {
    const projectPath = ctx.worktree || ctx.directory;
    process.stderr.write(`[lore] active: ${projectPath}\n`);

    if (loreActive) {
      process.stderr.write(`[lore] routing through ${gatewayBase}\n`);
      process.stderr.write(`[lore] dashboard: ${gatewayBase}/ui\n`);
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
