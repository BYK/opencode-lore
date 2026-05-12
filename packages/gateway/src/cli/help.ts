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
  logs                Show lore activity log
  import              Import knowledge from prior AI agent conversations
  data <subcommand>   Manage stored data (list, show, clear, delete)
  recall <query>      Search project memory from the command line
  upgrade [version]   Update lore to the latest (or specified) version
                      Flags: --check, --force, --offline, --channel <ch>
  help                Show this help text

Options:
  -p, --port <port>   Gateway port (default: 6969, env: LORE_LISTEN_PORT)
  -H, --host <host>   Gateway host(s), repeatable or comma-separated
                      (default: 127.0.0.1, env: LORE_LISTEN_HOST)
  -d, --debug         Enable debug logging (env: LORE_DEBUG=1)
  -v, --version       Print version and exit
  -h, --help          Show this help text

Log options (lore logs):
  -f, --follow        Follow log output in real-time
  -n, --lines <n>     Number of lines to show (default: 50)
  --path              Print log file path and exit

Data subcommands:
  data list <type>              List entries (projects, knowledge, sessions, distillations)
  data show <type> <id>         Show full detail for an entry
  data clear [options]          Clear data for a project or wipe the database
  data delete <type> <id>       Delete a single entry
  data merge <id1> <id2>        Merge two projects (moves data from id2 into id1)
  data recover                  Recover orphaned data from deleted projects

  Data flags: --project <path>, --limit <n>, --json, --yes/-y
  Clear flags: --knowledge, --temporal, --distillations, --all

Import options:
  --yes / -y                    Skip confirmation prompt
  --agent <name>                Import from specific agent only
                                (claude-code, codex, opencode, cline, continue, pi, aider)
  --project <path>              Target project (default: cwd)
  --dry-run                     Show what would be imported, no LLM calls

Recall options:
  --project <path>              Target project (default: cwd)
  --scope <scope>               all (default), session, project, knowledge
  --session <id>                Session ID (for scope=session)
  --limit <n>                   Max results (default: 10)
  --json                        Output JSON instead of markdown

Examples:
  lore                          # Auto-detect agent and launch with gateway
  lore run claude               # Launch Claude Code through the gateway
  lore run opencode             # Launch OpenCode through the gateway
  lore start                    # Start gateway only (set ANTHROPIC_BASE_URL yourself)
  lore start -p 8080            # Start gateway on a custom port
  lore start -H 127.0.0.1 -H 100.69.65.125  # Bind to multiple interfaces
  lore start -H 127.0.0.1,100.69.65.125     # Same, comma-separated
  lore upgrade                  # Upgrade to latest version
  lore upgrade --check          # Check for updates without installing
  lore upgrade --force          # Force re-download even if up to date
  lore upgrade nightly          # Switch to nightly channel and update
  lore upgrade stable           # Switch back to stable channel
  lore upgrade 0.14.0           # Install a specific version
  lore upgrade --offline        # Upgrade from cached patches (no network)
  lore data list projects       # List all tracked projects
  lore data list knowledge      # List knowledge entries for current project
  lore data clear --project .   # Clear all data for the current project
  lore data clear --all         # Wipe the entire database
  lore import                   # Import knowledge from prior AI conversations
  lore import --dry-run         # Show what would be imported
  lore import --agent claude-code  # Import from Claude Code only
  lore logs                     # Show recent log entries
  lore logs -f                  # Follow log output in real-time
  lore logs -n 100              # Show last 100 lines
  lore logs --path              # Print log file path
  lore recall "error handling"  # Search project memory from CLI

Environment variables:
  LORE_LISTEN_PORT              Gateway port (overridden by --port)
  LORE_LISTEN_HOST              Gateway host(s), comma-separated (overridden by --host)
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
