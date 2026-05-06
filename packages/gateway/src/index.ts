/**
 * Lore Gateway — entry point.
 *
 * Starts the HTTP proxy server that applies Lore's context management
 * pipeline to any AI coding client speaking the Anthropic or OpenAI
 * protocol.
 *
 * Usage:
 *   bun run packages/gateway/src/index.ts
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:6969 claude
 */
import { loadConfig } from "./config";
import { startServer } from "./server";
import { resetPipelineState } from "./pipeline";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const config = loadConfig();
const server = startServer(config);

const addr = `http://${config.host}:${server.port}`;
console.error(`[lore] Gateway listening on ${addr}`);
console.error(`[lore] Model routing: claude-* → Anthropic, nvidia/* → Nvidia NIM, gpt-* → OpenAI, …`);
console.error(`[lore] Plugin auto-detects gateway — just start OpenCode normally`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.error("[lore] Shutting down…");
  server.stop();
  // Gracefully shut down the batch queue (flushes pending items synchronously)
  await resetPipelineState();
  process.exit(0);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
