/**
 * CLI `lore recall` command — search project memory from the terminal.
 *
 * Thin wrapper around `runRecall()` from `@loreai/core`. Runs without the
 * gateway — directly queries the SQLite database. No LLM client is available,
 * so query expansion is disabled.
 *
 * Usage:
 *   lore recall "query string" [--project <path>] [--scope <scope>] [--limit <n>] [--json]
 */
import { resolve } from "path";

export async function commandRecall(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const query = positionals[0];

  if (!query) {
    console.error(`Usage: lore recall <query> [options]

Options:
  --project <path>   Target project directory (default: current directory)
  --scope <scope>    Search scope: all (default), session, project, knowledge
  --session <id>     Session ID (required when scope=session)
  --limit <n>        Max results (default: 10)
  --json             Output raw JSON instead of formatted markdown`);
    process.exit(1);
  }

  const { runRecall, config } = await import("@loreai/core");

  const projectPath = resolve((values.project as string) ?? process.cwd());
  const scope = (values.scope as string as "all" | "session" | "project" | "knowledge") ?? "all";
  const sessionID = values.session as string | undefined;
  const limit = values.limit ? Number(values.limit) : 10;
  const asJson = !!values.json;

  if (scope === "session" && !sessionID) {
    console.error("Error: --session <id> is required when --scope session is used.");
    process.exit(1);
  }

  const searchConfig = {
    ...config().search,
    recallLimit: limit,
    queryExpansion: false, // No LLM available in CLI mode
  };

  try {
    const result = await runRecall({
      query,
      scope,
      projectPath,
      sessionID,
      searchConfig,
      // No LLM client — query expansion disabled
    });

    if (asJson) {
      console.log(JSON.stringify({ query, scope, projectPath, result }, null, 2));
    } else {
      console.log(result);
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
