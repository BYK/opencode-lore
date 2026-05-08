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
  console.error(
    `[lore] Point your AI agent at ${addr} and start coding`,
  );

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
