/**
 * `lore start` — start the gateway server without auto-launching an agent.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { loadConfig, DEFAULT_PORTS, type GatewayConfig } from "../config";
import { startServer } from "../server";
import { resetPipelineState } from "../pipeline";
import { writePortFile, removePortFile } from "../portfile";
import { embedding } from "@loreai/core";
import { safeExit } from "./exit";

export interface StartOptions {
  port?: number;
  hosts?: string[];
  debug?: boolean;
  /** Suppress verbose banner (env vars, export hints). Used in embedded mode. */
  quiet?: boolean;
  /** Remote gateway URL. When set, `lore run` delegates to this gateway
   *  instead of starting a local one. Overrides LORE_REMOTE_URL env var. */
  remoteUrl?: string;
}

export interface GatewayHandle {
  config: GatewayConfig;
  port: number;
  /** Whether this process owns the server (started it). False when reusing an existing instance. */
  owned: boolean;
  /** Shut down the gateway. No-op when `owned` is false. */
  shutdown: () => Promise<void>;
}

/**
 * Probe a running gateway at the given URL via its `/health` endpoint.
 * Returns `true` if the response is 2xx, `false` on any error or timeout.
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the gateway server, returning the actual port and a shutdown function.
 *
 * Merges CLI options on top of env-var config (CLI takes precedence).
 *
 * When the port is not explicitly set (no `--port` / `LORE_LISTEN_PORT`),
 * the server tries a fallback chain: 3207 → 5673 → OS-assigned random port.
 * At each step, if the port is occupied by an existing lore gateway
 * (verified via `/health` probe), returns a handle with `owned: false`
 * so the caller can reuse the existing instance.
 */
export async function startGateway(opts: StartOptions = {}): Promise<GatewayHandle> {
  const config = loadConfig();

  // CLI overrides
  if (opts.port !== undefined) {
    config.port = opts.port;
    config.portExplicit = true;
  }
  if (opts.hosts?.length) config.hosts = opts.hosts;
  if (opts.debug !== undefined) config.debug = opts.debug;

  // Build the list of ports to try.
  // Explicit port: single attempt, fail hard on conflict.
  // Default: 3207 → 5673 → 0 (OS-assigned random).
  const portsToTry: number[] = config.portExplicit
    ? [config.port]
    : [...DEFAULT_PORTS, 0];

  for (const candidatePort of portsToTry) {
    config.port = candidatePort;
    try {
      const server = startServer(config);
      const actualPort = server.port;

      // Write port file so plugins can discover us (even on random port).
      writePortFile(actualPort);

      const shutdown = async () => {
        console.error("[lore] Shutting down…");
        server.stop();
        removePortFile(actualPort);
        await resetPipelineState();
        // Shut down the embedding worker thread gracefully. Done after
        // resetPipelineState (which clears sessions/timers) but before
        // safeExit — gives the worker time to exit cleanly via its
        // "shutdown" message handler rather than being killed by _exit().
        await embedding.resetProvider();
      };

      if (candidatePort === 0) {
        console.error(
          `[lore] Preferred ports (${DEFAULT_PORTS.join(", ")}) were unavailable; using port ${actualPort}`,
        );
      }

      return { config, port: actualPort, owned: true, shutdown };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(/port\b.*\bin use/i.test(msg) || /EADDRINUSE/i.test(msg))) {
        throw e; // Not a port conflict — don't retry
      }

      // Port is occupied — check if it's a lore gateway we can reuse.
      // (Skip probe for port 0 — it can't EADDRINUSE.)
      if (candidatePort !== 0) {
        const probeUrl = `http://${config.hosts[0]}:${candidatePort}`;
        const alive = await probeGateway(probeUrl);
        if (alive) {
          return {
            config,
            port: candidatePort,
            owned: false,
            shutdown: async () => {},
          };
        }
      }

      // Port is taken by something else — try next candidate if available.
      if (config.portExplicit) {
        throw new Error(
          `Port ${candidatePort} is already in use by another process (not a lore gateway). ` +
            `Use --port / LORE_LISTEN_PORT to pick a different port.`,
        );
      }

      // Log the fallback (not for port 0 since that always succeeds).
      const nextIdx = portsToTry.indexOf(candidatePort) + 1;
      if (nextIdx < portsToTry.length) {
        const nextPort = portsToTry[nextIdx];
        const nextLabel = nextPort === 0 ? "random port" : String(nextPort);
        console.error(
          `[lore] Port ${candidatePort} in use (not a lore gateway), trying ${nextLabel}…`,
        );
      }
    }
  }

  // Unreachable — port 0 always succeeds or throws a non-EADDRINUSE error.
  throw new Error("Failed to bind to any port.");
}

/**
 * Run the `lore start` command — start gateway server and block until
 * SIGINT/SIGTERM.
 */
export async function commandStart(opts: StartOptions): Promise<never> {
  const { config, port, owned, shutdown } = await startGateway(opts);

  const addrs = config.hosts.map((h) => `http://${h}:${port}`);

  if (!owned) {
    // Another lore gateway is already running — nothing to do.
    console.log(`[lore] Gateway already running on ${addrs.join(", ")}`);
    console.log(`[lore] Dashboard: ${addrs[0]}/ui`);
    if (!opts.quiet) {
      console.log("[lore] Use that instance, or stop it first to start a new one.");
    }
    safeExit(0);
  }

  console.log(`[lore] Gateway listening on ${addrs.join(", ")}`);
  console.log(`[lore] Dashboard: ${addrs[0]}/ui`);

  if (!opts.quiet) {
    const localAddr = addrs[0];
    console.log(
      `[lore] Model routing: claude-* → Anthropic, nvidia/* → Nvidia NIM, gpt-* → OpenAI, …`,
    );
    console.log("");
    console.log("[lore] Point your AI agent at the gateway:");
    console.log(`  export ANTHROPIC_BASE_URL=${localAddr}`);
    console.log(`  export OPENAI_BASE_URL=${localAddr}/v1`);
    console.log("");
    console.log("[lore] IMPORTANT: When using Claude Code, also set:");
    console.log("  export DISABLE_AUTO_COMPACT=1");
    console.log("");
    console.log("[lore] Configuration (environment variables):");
    console.log(`  LORE_LISTEN_PORT        Port to listen on (current: ${port})`);
    console.log(`  LORE_LISTEN_HOST        Hosts to bind to, comma-separated (current: ${config.hosts.join(",")})`);
    console.log(`  LORE_UPSTREAM_ANTHROPIC Anthropic API URL (current: ${config.upstreamAnthropic})`);
    console.log(`  LORE_UPSTREAM_OPENAI    OpenAI API URL (current: ${config.upstreamOpenAI})`);
    console.log(`  LORE_IDLE_TIMEOUT       Idle timeout in seconds (current: ${config.idleTimeoutSeconds})`);
    console.log(`  LORE_DEBUG              Enable debug logging (current: ${config.debug})`);
    console.log(`  LORE_BATCH_DISABLED     Disable batch background work (current: ${process.env.LORE_BATCH_DISABLED === "1"})`);
    console.log(`  LORE_REMOTE_URL         Remote gateway URL for \`lore run\` (delegates instead of starting local)`);
  }
  // Block until signal
  let shuttingDown = false;
  const onSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdown();
    safeExit(0);
  };

  process.on("SIGINT", () => onSignal());
  process.on("SIGTERM", () => onSignal());

  // Keep the process alive (Bun.serve already does this, but be explicit)
  return new Promise(() => {});
}
