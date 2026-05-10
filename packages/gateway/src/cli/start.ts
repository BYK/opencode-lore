/**
 * `lore start` — start the gateway server only.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { loadConfig, type GatewayConfig } from "../config";
import { startServer } from "../server";
import { resetPipelineState } from "../pipeline";

export interface StartOptions {
  port?: number;
  hosts?: string[];
  debug?: boolean;
  /** Suppress verbose banner (env vars, export hints). Used in embedded mode. */
  quiet?: boolean;
}

/**
 * Start the gateway server, returning the actual port and a shutdown function.
 *
 * Merges CLI options on top of env-var config (CLI takes precedence).
 */
export function startGateway(opts: StartOptions = {}): {
  config: GatewayConfig;
  port: number;
  shutdown: () => Promise<void>;
} {
  const config = loadConfig();

  // CLI overrides
  if (opts.port !== undefined) config.port = opts.port;
  if (opts.hosts?.length) config.hosts = opts.hosts;
  if (opts.debug !== undefined) config.debug = opts.debug;

  const server = startServer(config);
  const actualPort = server.port;

  const shutdown = async () => {
    console.error("[lore] Shutting down…");
    server.stop();
    await resetPipelineState();
  };

  return { config, port: actualPort, shutdown };
}

/**
 * Run the `lore start` command — start gateway server and block until
 * SIGINT/SIGTERM.
 */
export async function commandStart(opts: StartOptions): Promise<never> {
  let result: ReturnType<typeof startGateway>;
  try {
    result = startGateway(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/port\b.*\bin use/i.test(msg) || /EADDRINUSE/i.test(msg)) {
      if (!opts.quiet) {
        console.error(`[lore] ${msg}`);
      }
      process.exit(1);
    }
    throw e;
  }
  const { config, port, shutdown } = result;

  const addrs = config.hosts.map((h) => `http://${h}:${port}`);
  console.error(`[lore] Gateway listening on ${addrs.join(", ")}`);

  if (!opts.quiet) {
    const localAddr = addrs[0];
    console.error(
      `[lore] Model routing: claude-* → Anthropic, nvidia/* → Nvidia NIM, gpt-* → OpenAI, …`,
    );
    console.error("");
    console.error("[lore] Point your AI agent at the gateway:");
    console.error(`  export ANTHROPIC_BASE_URL=${localAddr}`);
    console.error(`  export OPENAI_BASE_URL=${localAddr}/v1`);
    console.error("");
    console.error("[lore] Configuration (environment variables):");
    console.error(`  LORE_LISTEN_PORT        Port to listen on (current: ${port})`);
    console.error(`  LORE_LISTEN_HOST        Hosts to bind to, comma-separated (current: ${config.hosts.join(",")})`);
    console.error(`  LORE_UPSTREAM_ANTHROPIC Anthropic API URL (current: ${config.upstreamAnthropic})`);
    console.error(`  LORE_UPSTREAM_OPENAI    OpenAI API URL (current: ${config.upstreamOpenAI})`);
    console.error(`  LORE_IDLE_TIMEOUT       Idle timeout in seconds (current: ${config.idleTimeoutSeconds})`);
    console.error(`  LORE_DEBUG              Enable debug logging (current: ${config.debug})`);
    console.error(`  LORE_BATCH_DISABLED     Disable batch background work (current: ${process.env.LORE_BATCH_DISABLED === "1"})`);
  }
  // Block until signal
  const onSignal = async () => {
    await shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => onSignal());
  process.on("SIGTERM", () => onSignal());

  // Keep the process alive (Bun.serve already does this, but be explicit)
  return new Promise(() => {});
}
