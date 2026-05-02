import { Database } from "#db/driver";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

const SCHEMA_VERSION = 11;

const MIGRATIONS: string[] = [
  `
  -- Version 1: Initial schema

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS temporal_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    distilled INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    metadata TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS temporal_fts USING fts5(
    content,
    content=temporal_messages,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS temporal_fts_insert AFTER INSERT ON temporal_messages BEGIN
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS temporal_fts_delete AFTER DELETE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS temporal_fts_update AFTER UPDATE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_temporal_session ON temporal_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_temporal_project ON temporal_messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_temporal_distilled ON temporal_messages(distilled);
  CREATE INDEX IF NOT EXISTS idx_temporal_created ON temporal_messages(created_at);

  CREATE TABLE IF NOT EXISTS distillations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT NOT NULL,
    narrative TEXT NOT NULL,
    facts TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    generation INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_distillation_session ON distillations(session_id);
  CREATE INDEX IF NOT EXISTS idx_distillation_project ON distillations(project_id);
  CREATE INDEX IF NOT EXISTS idx_distillation_generation ON distillations(generation);
  CREATE INDEX IF NOT EXISTS idx_distillation_created ON distillations(created_at);

  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_session TEXT,
    cross_project INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title,
    content,
    category,
    content=knowledge,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;

  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
  CREATE INDEX IF NOT EXISTS idx_knowledge_cross ON knowledge(cross_project);

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  INSERT INTO schema_version (version) VALUES (1);
  `,
  `
  -- Version 2: Replace narrative+facts with observations text
  ALTER TABLE distillations ADD COLUMN observations TEXT NOT NULL DEFAULT '';
  `,
  `
  -- Version 3: One-time vacuum to reclaim accumulated free pages, and enable
  -- incremental auto-vacuum so future deletes return pages to the OS.
  -- VACUUM must run outside a transaction and cannot be in a multi-statement
  -- exec, so it is handled specially in the migrate() function.
  `,
  `
  -- Version 4: Persistent session state for error recovery.
  -- Stores forceMinLayer so it survives OpenCode restarts. Without this,
  -- a "prompt too long" error recovery (escalate to layer 2) is lost if
  -- the process restarts before the next turn.
  CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    force_min_layer INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Version 5: Multi-resolution composable distillations.
  -- Instead of deleting gen-0 distillations during meta-distillation,
  -- mark them as archived. Archived entries are excluded from the in-context
  -- prefix but remain searchable via the recall tool, providing a detailed
  -- "zoom-in" layer beneath the compressed gen-1 summary.
  -- Inspired by Cartridges (Eyuboglu et al., 2025) composability: independently
  -- compressed representations can be concatenated and queried without retraining.
  -- Reference: https://arxiv.org/abs/2501.17390
  ALTER TABLE distillations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_distillation_archived ON distillations(archived);
  `,
  `
  -- Version 6: Compound indexes for common multi-column query patterns.
  -- Almost every query filters on (project_id, session_id) but only single-column
  -- indexes existed, forcing SQLite to pick one and scan for the rest.

  -- temporal_messages: covers bySession, search-LIKE fallback, count, undistilledCount
  CREATE INDEX IF NOT EXISTS idx_temporal_project_session ON temporal_messages(project_id, session_id);
  -- temporal_messages: covers undistilled() and undistilledCount() with distilled filter
  CREATE INDEX IF NOT EXISTS idx_temporal_project_session_distilled ON temporal_messages(project_id, session_id, distilled);
  -- temporal_messages: covers pruning TTL pass and size-cap pass (distilled=1 ordered by created_at)
  CREATE INDEX IF NOT EXISTS idx_temporal_project_distilled_created ON temporal_messages(project_id, distilled, created_at);

  -- distillations: covers loadForSession, latestObservations, searchDistillations, resetOrphans
  CREATE INDEX IF NOT EXISTS idx_distillation_project_session ON distillations(project_id, session_id);
  -- distillations: covers gen0Count, loadGen0, gradient prefix loading (archived filter)
  CREATE INDEX IF NOT EXISTS idx_distillation_project_session_gen_archived ON distillations(project_id, session_id, generation, archived);

  -- Drop redundant single-column indexes that are now left-prefixes of compound indexes.
  -- idx_temporal_project is a prefix of idx_temporal_project_session.
  -- idx_distillation_project is a prefix of idx_distillation_project_session.
  -- idx_temporal_distilled is a prefix of no compound index but is low-selectivity (0/1)
  -- and all queries that use it also filter on project_id — covered by the new compounds.
  DROP INDEX IF EXISTS idx_temporal_project;
  DROP INDEX IF EXISTS idx_temporal_distilled;
  DROP INDEX IF EXISTS idx_distillation_project;
  `,
  `
  -- Version 7: FTS5 for distillations — enables ranked search instead of LIKE.
  CREATE VIRTUAL TABLE IF NOT EXISTS distillation_fts USING fts5(
    observations,
    content=distillations,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );

  -- Backfill existing data (skip empty observations from schema v1→v2 migration)
  INSERT INTO distillation_fts(rowid, observations)
  SELECT rowid, observations FROM distillations WHERE observations != '';

  -- Sync triggers
  CREATE TRIGGER IF NOT EXISTS distillation_fts_insert AFTER INSERT ON distillations BEGIN
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;

  CREATE TRIGGER IF NOT EXISTS distillation_fts_delete AFTER DELETE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
  END;

  CREATE TRIGGER IF NOT EXISTS distillation_fts_update AFTER UPDATE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;
  `,
  `
  -- Version 8: Embedding BLOB column for vector search (Voyage AI).
  -- No backfill — entries get embedded lazily on next create/update
  -- or via explicit backfill when embeddings are first enabled.
  ALTER TABLE knowledge ADD COLUMN embedding BLOB;

  -- Key-value metadata table for plugin state (e.g. embedding config fingerprint).
  CREATE TABLE IF NOT EXISTS kv_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Version 9: Embedding BLOB column for distillation vector search.
  -- Same pattern as knowledge embeddings (version 8). Enables semantic
  -- search over distilled session summaries via cosine similarity.
  -- No backfill — entries get embedded lazily on next distillation
  -- or via explicit backfill when embeddings are first enabled.
  ALTER TABLE distillations ADD COLUMN embedding BLOB;
  `,
  `
  -- Version 10: lat.md section cache + knowledge cross-references.

  -- lat.md section cache for recall integration.
  -- Parsed from lat.md/ directory markdown files, FTS5-indexed for search.
  CREATE TABLE IF NOT EXISTS lat_sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    file TEXT NOT NULL,
    heading TEXT NOT NULL,
    depth INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    first_paragraph TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS lat_sections_fts USING fts5(
    heading,
    content,
    content=lat_sections,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS lat_fts_insert AFTER INSERT ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS lat_fts_delete AFTER DELETE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS lat_fts_update AFTER UPDATE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_lat_sections_project ON lat_sections(project_id);
  CREATE INDEX IF NOT EXISTS idx_lat_sections_file ON lat_sections(project_id, file);

  -- Knowledge cross-references via [[entry-id]] wiki links.
  -- ON DELETE CASCADE: when either entry is deleted, the ref row is auto-removed.
  CREATE TABLE IF NOT EXISTS knowledge_refs (
    from_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    PRIMARY KEY (from_id, to_id)
  );
  `,
  `
  -- Version 11: F3b -- unambiguous chunk terminator in temporal_messages.content.
  --
  -- Pre-F3b, partsToText joined chunks with a newline. Tool-output payloads
  -- can contain newlines too, so the boundary between a tool envelope and a
  -- following plain-text or [reasoning] chunk was structurally ambiguous.
  -- This caused two known limitations in the F3 distill-input truncator:
  -- trailing text could be swallowed into a tool payload, and embedded
  -- literal envelope strings inside a payload (e.g. when reading AGENTS.md)
  -- could fabricate fake boundaries.
  --
  -- F3b switches the chunk separator to newline plus ASCII Unit Separator
  -- (char 31). The Unit Separator is non-word so FTS5's unicode61 tokenizer
  -- ignores it (zero BM25 impact). New rows are written via the post-F3b
  -- partsToText. Existing rows are rewritten in place by the UPDATE below,
  -- which uses pure SQL replace() to inject the Unit Separator after every
  -- legacy chunk-prefix sequence -- the same boundary patterns the legacy
  -- F3 reader was already trying to recover.
  --
  -- Trade-off (acceptable): any embedded legacy chunk-prefix sequence
  -- inside a tool payload becomes a structural boundary post-migration.
  -- This matches what the legacy F3 reader did at read-time anyway, baked
  -- into the row permanently. The migration runs once per machine.
  --
  -- Idempotent: a row that already contains the Unit Separator before a
  -- chunk prefix no longer matches the search literal (the separator
  -- interposes), so re-running the UPDATE is a no-op for migrated rows.
  -- (Important: migrate() in db.ts runs each migration via database.exec()
  -- with no explicit BEGIN/COMMIT around the whole loop. SQLite makes this
  -- single UPDATE statement atomic per-statement, so partial progress on
  -- crash is safe to retry thanks to the idempotency above.)
  --
  -- char(10) = newline, char(31) = Unit Separator. SQLite has no native
  -- regex, but two nested replace() calls on the literal prefixes are
  -- sufficient because both legacy chunk prefixes match at line-start.
  --
  -- Each row UPDATE fires the temporal_fts_update trigger once; because
  -- the Unit Separator is a non-word character, the re-indexed content
  -- tokenizes identically -- net no-op for FTS scoring.
  UPDATE temporal_messages
  SET content = replace(
    replace(
      content,
      char(10) || '[tool:',
      char(10) || char(31) || '[tool:'
    ),
    char(10) || '[reasoning] ',
    char(10) || char(31) || '[reasoning] '
  )
  WHERE content LIKE '%' || char(10) || '[tool:%'
     OR content LIKE '%' || char(10) || '[reasoning] %';
  `,
];

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || join(process.env.HOME || "~", ".local", "share");
  return join(base, "opencode-lore");
}

let instance: Database | undefined;

export function db(): Database {
  if (instance) return instance;
  const envPath = process.env.LORE_DB_PATH;
  let path: string;
  if (envPath) {
    mkdirSync(dirname(envPath), { recursive: true });
    path = envPath;
  } else {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    path = join(dir, "lore.db");
  }
  // Both `bun:sqlite` and `node:sqlite` create the file by default if it doesn't
  // exist, so no special option is needed. (bun:sqlite's `{ create: true }`
  // exists only to opt INTO creation when you want readonly=false — which is
  // already the default for our case.)
  //
  // IMPORTANT: Do NOT assign to `instance` until migrate() succeeds. If
  // migrate() throws (SQLITE_BUSY, partial prior run, disk error), the
  // module-level singleton must remain undefined so the next db() call
  // retries initialization instead of returning an un-migrated handle.
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  // Retry for up to 5s when another connection holds the write lock (e.g.
  // backgroundDistill's BEGIN IMMEDIATE overlapping with a recall query).
  // Default is 0ms which throws SQLITE_BUSY immediately.
  database.exec("PRAGMA busy_timeout = 5000");
  // Return freed pages to the OS incrementally on each transaction commit
  // instead of accumulating a free-page list that bloats the file.
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  migrate(database);
  instance = database;
  return instance;
}

// Index of the migration that performs a one-time VACUUM.
// VACUUM cannot run inside a transaction, so migrate() handles it specially.
const VACUUM_MIGRATION_INDEX = 2; // 0-based index of version-3 migration

function migrate(database: Database) {
  const row = database
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name: string } | null;
  const current = row
    ? ((
        database.query("SELECT version FROM schema_version").get() as {
          version: number;
        }
      )?.version ?? 0)
    : 0;
  if (current >= MIGRATIONS.length) {
    // Schema is at the expected version but a prior partial run may have left
    // holes (e.g. ALTER TABLE succeeded but CREATE TABLE in the same migration
    // string was skipped). Run idempotent recovery for known fragile objects.
    recoverMissingObjects(database);
    return;
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    if (i === VACUUM_MIGRATION_INDEX) {
      // VACUUM cannot run inside a transaction. Run it directly.
      // auto_vacuum mode must be set *before* VACUUM — SQLite bakes it into
      // the file header during the rebuild. After this, every subsequent
      // startup's "PRAGMA auto_vacuum = INCREMENTAL" is a no-op (already set).
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
      database.exec("VACUUM");
    } else {
      try {
        database.exec(MIGRATIONS[i]);
      } catch (e: unknown) {
        // Multi-statement migrations can partially fail when an early
        // statement (e.g. ALTER TABLE ADD COLUMN) hits a duplicate-column
        // error from a prior partial run. Swallow duplicate-column errors
        // so the rest of the migration loop and the version bump proceed.
        // Any genuinely new error is re-thrown.
        if (
          e instanceof Error &&
          /duplicate column name/i.test(e.message)
        ) {
          // The ALTER TABLE already applied — run remaining statements in
          // this migration by stripping the offending ALTER and re-exec'ing.
          // (Important: migrate() in db.ts runs each migration via database.exec()
          // which stops at the first error in a multi-statement string.)
          const stripped = stripAppliedAlters(MIGRATIONS[i], database);
          if (stripped.trim()) database.exec(stripped);
        } else {
          throw e;
        }
      }
    }
  }
  // Update version to latest. Migration 0 inserts version=1 via its own INSERT,
  // but subsequent migrations don't update it, so always normalize to MIGRATIONS.length.
  database.exec(`UPDATE schema_version SET version = ${MIGRATIONS.length}`);

  // Also run recovery for existing DBs that are already at the latest version
  // but have holes from past partial runs.
  recoverMissingObjects(database);
}

/**
 * Strip ALTER TABLE ADD COLUMN statements for columns that already exist.
 * Returns the migration string with those statements removed.
 */
function stripAppliedAlters(migration: string, database: Database): string {
  return migration.replace(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b[^;]*;/gi,
    (match, table, column) => {
      const cols = database
        .query(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === column)) return ""; // already exists
      return match; // keep — this ALTER hasn't been applied
    },
  );
}

/**
 * Idempotent recovery for objects that may be missing due to multi-statement
 * migration partial failures (e.g. ALTER TABLE throws duplicate-column,
 * aborting the exec before a subsequent CREATE TABLE in the same string).
 */
function recoverMissingObjects(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function close() {
  if (instance) {
    instance.close();
    instance = undefined;
  }
}

// Project management
export function ensureProject(path: string, name?: string): string {
  const existing = db()
    .query("SELECT id FROM projects WHERE path = ?")
    .get(path) as { id: string } | null;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db()
    .query(
      "INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, path, name ?? path.split("/").pop() ?? "unknown", Date.now());
  return id;
}

export function projectId(path: string): string | undefined {
  const row = db()
    .query("SELECT id FROM projects WHERE path = ?")
    .get(path) as { id: string } | null;
  return row?.id;
}

/** Look up a project's display name by its internal ID. */
export function projectName(id: string): string | null {
  const row = db()
    .query("SELECT name FROM projects WHERE id = ?")
    .get(id) as { name: string } | null;
  return row?.name ?? null;
}

/**
 * Returns true if Lore has never been used before (no projects in the DB).
 * Must be called before ensureProject() to get an accurate result.
 */
export function isFirstRun(): boolean {
  const row = db()
    .query("SELECT COUNT(*) as count FROM projects")
    .get() as { count: number };
  return row.count === 0;
}

// ---------------------------------------------------------------------------
// Persistent session state (error recovery)
// ---------------------------------------------------------------------------

/**
 * Load persisted forceMinLayer for a session. Returns 0 if none stored.
 */
export function loadForceMinLayer(sessionID: string): number {
  const row = db()
    .query("SELECT force_min_layer FROM session_state WHERE session_id = ?")
    .get(sessionID) as { force_min_layer: number } | null;
  return row?.force_min_layer ?? 0;
}

/**
 * Persist forceMinLayer for a session. Deletes the row when layer is 0
 * (consumed) to avoid unbounded growth.
 */
export function saveForceMinLayer(sessionID: string, layer: number): void {
  if (layer === 0) {
    db()
      .query("DELETE FROM session_state WHERE session_id = ?")
      .run(sessionID);
  } else {
    db()
      .query(
        "INSERT OR REPLACE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, ?, ?)",
      )
      .run(sessionID, layer, Date.now());
  }
}
