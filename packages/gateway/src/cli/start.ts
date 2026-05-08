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
  host?: string;
  debug?: boolean;
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
  if (opts.host !== undefined) config.host = opts.host;
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
  const { config, port, shutdown } = startGateway(opts);

  const addr = `http://${config.host}:${port}`;
  console.error(`[lore] Gateway listening on ${addr}`);
  console.error(
    `[lore] Model routing: claude-* → Anthropic, nvidia/* → Nvidia NIM, gpt-* → OpenAI, …`,
  );
  console.error("");
  console.error("[lore] Point your AI agent at the gateway:");
  console.error(`  export ANTHROPIC_BASE_URL=${addr}`);
  console.error(`  export OPENAI_BASE_URL=${addr}/v1`);
  console.error("");
  console.error("[lore] Configuration (environment variables):");
  console.error(`  LORE_LISTEN_PORT        Port to listen on (current: ${port})`);
  console.error(`  LORE_LISTEN_HOST        Host to bind to (current: ${config.host})`);
  console.error(`  LORE_UPSTREAM_ANTHROPIC Anthropic API URL (current: ${config.upstreamAnthropic})`);
  console.error(`  LORE_UPSTREAM_OPENAI    OpenAI API URL (current: ${config.upstreamOpenAI})`);
  console.error(`  LORE_IDLE_TIMEOUT       Idle timeout in seconds (current: ${config.idleTimeoutSeconds})`);
  console.error(`  LORE_DEBUG              Enable debug logging (current: ${config.debug})`);
  console.error(`  LORE_BATCH_DISABLED     Disable batch background work (current: ${process.env.LORE_BATCH_DISABLED === "1"})`);

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
