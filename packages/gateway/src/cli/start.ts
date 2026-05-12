/**
 * `lore start` — start the gateway server only.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { loadConfig, type GatewayConfig } from "../config";
import { startServer } from "../server";
import { resetPipelineState } from "../pipeline";
import { embedding } from "@loreai/core";
import { safeExit } from "./exit";

export interface StartOptions {
  port?: number;
  hosts?: string[];
  debug?: boolean;
  /** Suppress verbose banner (env vars, export hints). Used in embedded mode. */
  quiet?: boolean;
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
 * If the port is already in use by another lore gateway (verified via
 * `/health` probe), returns a handle with `owned: false` so the caller
 * can reuse the existing instance instead of failing.
 */
export async function startGateway(opts: StartOptions = {}): Promise<GatewayHandle> {
  const config = loadConfig();

  // CLI overrides
  if (opts.port !== undefined) config.port = opts.port;
  if (opts.hosts?.length) config.hosts = opts.hosts;
  if (opts.debug !== undefined) config.debug = opts.debug;

  try {
    const server = startServer(config);
    const actualPort = server.port;

    const shutdown = async () => {
      console.error("[lore] Shutting down…");
      server.stop();
      await resetPipelineState();
      // Shut down the embedding worker thread gracefully. Done after
      // resetPipelineState (which clears sessions/timers) but before
      // safeExit — gives the worker time to exit cleanly via its
      // "shutdown" message handler rather than being killed by _exit().
      await embedding.resetProvider();
    };

    return { config, port: actualPort, owned: true, shutdown };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/port\b.*\bin use/i.test(msg) || /EADDRINUSE/i.test(msg)) {
      // Port is occupied — check if it's a lore gateway we can reuse
      const probeUrl = `http://${config.hosts[0]}:${config.port}`;
      const alive = await probeGateway(probeUrl);
      if (alive) {
        return {
          config,
          port: config.port,
          owned: false,
          shutdown: async () => {},
        };
      }
      // Port is taken by something else — not a lore gateway
      throw new Error(
        `Port ${config.port} is already in use by another process (not a lore gateway). ` +
          `Use --port / LORE_LISTEN_PORT to pick a different port.`,
      );
    }
    throw e;
  }
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
    if (!opts.quiet) {
      console.log("[lore] Use that instance, or stop it first to start a new one.");
    }
    safeExit(0);
  }

  console.log(`[lore] Gateway listening on ${addrs.join(", ")}`);

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
    console.log("[lore] Configuration (environment variables):");
    console.log(`  LORE_LISTEN_PORT        Port to listen on (current: ${port})`);
    console.log(`  LORE_LISTEN_HOST        Hosts to bind to, comma-separated (current: ${config.hosts.join(",")})`);
    console.log(`  LORE_UPSTREAM_ANTHROPIC Anthropic API URL (current: ${config.upstreamAnthropic})`);
    console.log(`  LORE_UPSTREAM_OPENAI    OpenAI API URL (current: ${config.upstreamOpenAI})`);
    console.log(`  LORE_IDLE_TIMEOUT       Idle timeout in seconds (current: ${config.idleTimeoutSeconds})`);
    console.log(`  LORE_DEBUG              Enable debug logging (current: ${config.debug})`);
    console.log(`  LORE_BATCH_DISABLED     Disable batch background work (current: ${process.env.LORE_BATCH_DISABLED === "1"})`);
    console.log("");
    console.log("[lore] When using Claude Code, also set:");
    console.log("  export DISABLE_AUTO_COMPACT=1");
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
