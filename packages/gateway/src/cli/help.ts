/**
 * CLI help text — printed by `lore help` and `lore --help`.
 */
import { VERSION } from "./version";

const USAGE = `
lore v${VERSION} — context management proxy for AI coding agents

Usage:
  lore [command] [options]

Commands:
  run [command...]    Start gateway and launch an AI agent (default)
  start               Start the gateway server only
  upgrade [version]   Update lore to the latest (or specified) version
                      Flags: --check, --force, --offline, --channel <ch>
  help                Show this help text

Options:
  -p, --port <port>   Gateway port (default: 6969, env: LORE_LISTEN_PORT)
  -H, --host <host>   Gateway host (default: 127.0.0.1, env: LORE_LISTEN_HOST)
  -d, --debug         Enable debug logging (env: LORE_DEBUG=1)
  -v, --version       Print version and exit
  -h, --help          Show this help text

Examples:
  lore                          # Auto-detect agent and launch with gateway
  lore run claude               # Launch Claude Code through the gateway
  lore run opencode             # Launch OpenCode through the gateway
  lore start                    # Start gateway only (set ANTHROPIC_BASE_URL yourself)
  lore start -p 8080            # Start gateway on a custom port
  lore upgrade                  # Upgrade to latest version
  lore upgrade --check          # Check for updates without installing
  lore upgrade --force          # Force re-download even if up to date
  lore upgrade nightly          # Switch to nightly channel and update
  lore upgrade stable           # Switch back to stable channel
  lore upgrade 0.14.0           # Install a specific version
  lore upgrade --offline        # Upgrade from cached patches (no network)

Environment variables:
  LORE_LISTEN_PORT              Gateway port (overridden by --port)
  LORE_LISTEN_HOST              Gateway host (overridden by --host)
  LORE_UPSTREAM_ANTHROPIC       Upstream Anthropic API URL
  LORE_UPSTREAM_OPENAI          Upstream OpenAI API URL
  LORE_DEBUG                    Enable debug logging (1 or true)
  LORE_NO_UPDATE_CHECK          Disable background update checks (set to 1)
`.trimStart();

export function printHelp(): void {
  console.log(USAGE);
}

export function printVersion(): void {
  console.log(VERSION);
}
