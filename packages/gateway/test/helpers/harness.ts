/**
 * Test harness for the Lore gateway replay integration tests.
 *
 * Creates an isolated gateway instance on a random port with its own
 * temporary DB, wires in a replay interceptor from a fixture array, and
 * provides helper methods for sending requests and asserting DB state.
 *
 * Usage:
 *   const harness = await createHarness({ fixtures });
 *   const resp = await harness.chat(body);
 *   harness.teardown();
 */
import { unlinkSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { FixtureEntry } from "../../src/recorder";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  fixtures: FixtureEntry[];
  /** Override any config values */
  configOverrides?: Partial<{ port: number; debug: boolean }>;
}

export interface Harness {
  /** Base URL of the gateway (http://127.0.0.1:<port>) */
  baseURL: string;
  /** Path to the isolated temp DB */
  dbPath: string;
  /** Send a POST /v1/messages request, return the raw Response */
  chat(requestBody: unknown, apiKey?: string): Promise<Response>;
  /** Query the temporal DB directly via a read-only SQLite connection */
  queryDB<T = Record<string, unknown>>(
    sql: string,
    params?: SQLQueryBindings[],
  ): T[];
  /** Stop the gateway and clean up */
  teardown(): void;
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  // --- 1. Isolated temp DB path ---
  const dbPath = `/tmp/lore-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

  // Set env vars BEFORE any gateway/core imports so db.ts picks up the right path
  process.env.LORE_DB_PATH = dbPath;

  // --- 2. Random port in [20000, 50000) ---
  const port =
    (opts.configOverrides?.port ??
      20000 + Math.floor(Math.random() * 30000));

  process.env.LORE_LISTEN_PORT = String(port);

  // Suppress debug noise in tests unless explicitly enabled
  if (!process.env.LORE_DEBUG) {
    process.env.LORE_DEBUG = "false";
  }

  // --- 3. Dynamic imports so env vars take effect before module-level code runs ---
  const { getReplayInterceptor } = await import("../../src/recorder");
  const { setUpstreamInterceptor, resetPipelineState } = await import(
    "../../src/pipeline"
  );
  const { startServer } = await import("../../src/server");
  const { loadConfig } = await import("../../src/config");
  // Import close() so we can reset the DB singleton between harnesses.
  // This allows each harness to open a fresh DB at its own LORE_DB_PATH.
  const { close: closeDB } = await import("@loreai/core");

  // Reset any leftover singleton state from a previous harness in this process.
  // Must close the DB BEFORE resetting pipeline state (which may use the DB).
  closeDB();
  resetPipelineState();

  // --- 4. Wire in replay interceptor ---
  setUpstreamInterceptor(getReplayInterceptor(opts.fixtures));

  // --- 5. Start gateway ---
  const config = loadConfig();
  const server = startServer(config);

  const baseURL = `http://127.0.0.1:${server.port}`;

  // --- 6. Read-only DB handle for assertions (separate connection, no shared state) ---
  function queryDB<T = Record<string, unknown>>(
    sql: string,
    params?: SQLQueryBindings[],
  ): T[] {
    // Open a fresh read-only connection every query — avoids locking races
    // and ensures we always see the latest committed state.
    try {
      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        const stmt = db.query<T, SQLQueryBindings[]>(sql);
        return stmt.all(...(params ?? []));
      } finally {
        db.close();
      }
    } catch {
      // DB may not exist yet (before first request completes) — return empty
      return [];
    }
  }

  // --- 7. chat() helper ---
  async function chat(
    requestBody: unknown,
    apiKey = "test-key",
  ): Promise<Response> {
    return fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });
  }

  // --- 8. teardown() ---
  function teardown(): void {
    server.stop();
    // Close the core DB singleton first so the next harness can open a fresh
    // DB at its own LORE_DB_PATH.
    closeDB();
    resetPipelineState();
    setUpstreamInterceptor(undefined);

    // Delete DB files (main + WAL + SHM)
    for (const suffix of ["", "-shm", "-wal"]) {
      const file = `${dbPath}${suffix}`;
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best-effort
      }
    }
  }

  return { baseURL, dbPath, chat, queryDB, teardown };
}
