/**
 * CLI `lore recall` command — search project memory from the terminal.
 *
 * Thin wrapper around `runRecall()` from `@loreai/core`. Runs without the
 * gateway — directly queries the SQLite database. No LLM client is available,
 * so query expansion is disabled.
 *
 * When `LORE_REMOTE_URL` is set, delegates to the remote gateway REST API,
 * which has an LLM client and can run query expansion for better results.
 *
 * Usage:
 *   lore recall "query string" [--project <path>] [--scope <scope>] [--limit <n>] [--json]
 */
import { resolve } from "path";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
} from "./remote";

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

  const projectPath = resolve((values.project as string) ?? process.cwd());
  const scope = (values.scope as string) ?? "all";
  const sessionID = values.session as string | undefined;
  const limit = values.limit ? Number(values.limit) : 10;
  const asJson = !!values.json;

  if (scope === "session" && !sessionID) {
    console.error("Error: --session <id> is required when --scope session is used.");
    process.exit(1);
  }

  // Remote mode: delegate to gateway REST API (gets query expansion for free)
  const remote = getRemoteUrl();
  if (remote) {
    try {
      const pq = projectQueryParams(projectPath);
      let apiPath = `/api/v1/recall?q=${encodeURIComponent(query)}&${pq}&scope=${scope}&limit=${limit}`;
      if (sessionID) apiPath += `&session=${encodeURIComponent(sessionID)}`;

      const data = await remoteGet<{ query: string; scope: string; projectPath: string; result: string }>(
        remote, apiPath,
      );

      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(data.result);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // Local mode: query DB directly (no LLM, no query expansion)
  const { runRecall, config } = await import("@loreai/core");

  const searchConfig = {
    ...config().search,
    recallLimit: limit,
    queryExpansion: false, // No LLM available in CLI mode
  };

  try {
    const result = await runRecall({
      query,
      scope: scope as "all" | "session" | "project" | "knowledge",
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
