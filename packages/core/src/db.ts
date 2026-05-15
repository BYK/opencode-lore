import { Database } from "#db/driver";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import { getGitRemote } from "./git";
import { dataDir } from "./data-dir";

/**
 * Extract the repository name from a normalized git remote URL.
 *
 * Examples:
 *   "github.com/BYK/LoreAI" → "LoreAI"
 *   "github.com/org/repo"    → "repo"
 *   "github.com"             → null (no path components)
 *   null                     → null
 */
export function repoNameFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const lastSlash = remote.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const name = remote.slice(lastSlash + 1);
  return name.length > 0 ? name : null;
}

const SCHEMA_VERSION = 16;

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
  `
  -- Version 12: Context health diagnostic columns on distillations.
  --
  -- r_compression: k/√N where k = distilled token count, N = source token
  -- count. Values < 1.0 signal likely lossy compression. NULL for rows
  -- created before this migration or for meta-distillations (gen > 0)
  -- where the metric is not computed.
  --
  -- c_norm: normalized variance of relative-existence weights over source
  -- message timestamps. Range [0, 1]; 0 = uniform distribution, 1 = attention
  -- dominated by distant past. NULL for pre-migration rows or meta-distillations.
  --
  -- Both columns are nullable REALs — cheap to add, no backfill needed.
  ALTER TABLE distillations ADD COLUMN r_compression REAL;
  ALTER TABLE distillations ADD COLUMN c_norm REAL;
  `,
  `
  -- Version 13: Installation metadata table for telemetry and diagnostics.
  --
  -- Separate from kv_meta (plugin state) — this holds installation-scoped
  -- values: instance_id, release_channel, etc. Has updated_at for tracking
  -- when values last changed.
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Version 14: Git-based project identification.
  --
  -- Projects can now be identified by their git remote URL in addition to
  -- filesystem path. This enables worktree, clone, and fork awareness:
  -- the same repository accessed from different paths shares one project.
  --
  -- git_remote: Normalized canonical remote URL (e.g. "github.com/user/repo").
  -- NULL for non-git directories or repos with no remotes.
  --
  -- project_path_aliases: Maps additional filesystem paths to existing
  -- projects. When ensureProject() finds a match by git_remote, the
  -- alternate path is registered here for O(1) subsequent lookups.
  ALTER TABLE projects ADD COLUMN git_remote TEXT;
  CREATE INDEX IF NOT EXISTS idx_projects_git_remote ON projects(git_remote);

  CREATE TABLE IF NOT EXISTS project_path_aliases (
    path TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  );
  `,

  `
  -- Version 15: Cache warming survival histograms.
  --
  -- Persists global (per-project, per-time-slot) inter-turn gap histograms
  -- across gateway restarts. These histograms feed the survival analysis
  -- model that decides whether to send speculative cache-warming pings.
  -- Without persistence, the model has no data until enough turns rebuild
  -- the histogram from scratch (cold start problem).
  --
  -- counts: JSON array of bin counts (21 elements: 20 bins + 1 overflow).
  -- total: Sum of counts (denormalized for fast reads).
  CREATE TABLE IF NOT EXISTS warmup_histograms (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    time_slot TEXT NOT NULL,
    counts TEXT NOT NULL DEFAULT '[]',
    total INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, time_slot)
  );
  `,
  `
  -- Version 16: Embedding BLOB column for temporal message vector search.
  -- Same pattern as knowledge (v8) and distillation (v9) embeddings.
  -- Only undistilled messages are embedded; the column is NULLed when
  -- a message is marked as distilled (its semantic content is captured
  -- by the distillation embedding at that point).
  -- No backfill — new messages get embedded lazily at write time.
  ALTER TABLE temporal_messages ADD COLUMN embedding BLOB;
  `,
  `
  -- Version 17: Track whether distillation used batch API pricing.
  -- NULL for pre-migration rows (treated as 'direct' for conservative estimates).
  -- 'batch' = 50% discount on input+output, 'direct' = full price.
  ALTER TABLE distillations ADD COLUMN call_type TEXT;
  `,
  `
  -- Version 18: Persist live session cost data so historical estimates
  -- include cache warming, 1h TTL savings, and batch API savings — metrics
  -- that were previously lost on gateway restart.
  -- All cost columns are in USD. Token columns are raw counts.
  ALTER TABLE session_state ADD COLUMN conversation_cost REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN worker_cost REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN conversation_turns INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN warmup_savings REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN warmup_hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ttl_savings REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ttl_hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN batch_savings REAL NOT NULL DEFAULT 0;
  `,
  `
  -- Version 19: Import history for conversation import idempotency.
  -- Tracks which external agent sessions have been imported to prevent
  -- re-importing unchanged sources and to record user-declined imports.
  CREATE TABLE IF NOT EXISTS import_history (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    entries_created INTEGER NOT NULL DEFAULT 0,
    entries_updated INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    UNIQUE(project_id, agent_name, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_import_history_project ON import_history(project_id);
  `,
  `
  -- Version 20: Purge worker boilerplate from temporal messages.
  -- Legacy gateway/plugin worker calls (distillation observer, curator,
  -- consolidation, reflector, eval) stored their full system prompts
  -- (containing entire conversation transcripts, up to 1.6MB each) as
  -- temporal messages. These pollute FTS search results by matching
  -- virtually any domain keyword. Safe to delete: their actual output
  -- (distillations, knowledge entries) is stored in dedicated tables.
  DELETE FROM temporal_messages WHERE content LIKE '%You are a memory observer.%'
    OR content LIKE '%You are a long-term memory curator.%'
    OR content LIKE '%You are a long-term memory curator performing a consolidation pass.%'
    OR content LIKE '%You are a memory reflector.%'
    OR content LIKE '%You are evaluating distillation quality.%';
  `,
  `
  -- Version 21: Persist avoided compaction data from live sessions.
  -- Historical estimates previously re-simulated avoided compactions from
  -- temporal message token estimates (chars/3), missing system prompt and
  -- tool definition overhead. Persisting the live session's real shadow
  -- context tracking (from actual API-reported total input tokens) gives
  -- accurate post-restart historical estimates.
  ALTER TABLE session_state ADD COLUMN avoided_compactions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN avoided_compaction_cost REAL NOT NULL DEFAULT 0;
  `,
  `
  -- Version 22: Track when conversation import was last offered/run.
  -- NULL means import has never been offered for this project.
  -- Used by auto-import to avoid re-prompting, and by explicit
  -- \`lore import\` for incremental imports (only newer conversations).
  ALTER TABLE projects ADD COLUMN last_import_at INTEGER;

  -- Backfill: migrate legacy __declined__ sentinel rows so existing
  -- users who previously declined are not re-prompted after upgrading.
  UPDATE projects SET last_import_at = (
    SELECT ih.imported_at FROM import_history ih
    WHERE ih.project_id = projects.id
      AND ih.source_id = '__declined__'
    LIMIT 1
  )
  WHERE EXISTS (
    SELECT 1 FROM import_history ih
    WHERE ih.project_id = projects.id
      AND ih.source_id = '__declined__'
  );
  `,
  `
  -- Version 23: Persist volatile session tracking state across restarts.
  -- Previously these were in-memory only, causing duplicate processing,
  -- false compaction detection, and expensive prompt cache busts on restart.
  ALTER TABLE session_state ADD COLUMN last_curated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN turns_since_curation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ltm_cache_text TEXT;
  ALTER TABLE session_state ADD COLUMN ltm_cache_tokens INTEGER;
  ALTER TABLE session_state ADD COLUMN ltm_pin_text TEXT;
  ALTER TABLE session_state ADD COLUMN ltm_pin_tokens INTEGER;
  ALTER TABLE session_state ADD COLUMN consecutive_text_only_turns INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Version 24: Persist remaining volatile session state across restarts.
  -- Session identity (Tier 1/2/3 session correlation)
  ALTER TABLE session_state ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_state ADD COLUMN header_session_id TEXT;
  ALTER TABLE session_state ADD COLUMN header_name TEXT;
  -- Cache warming state
  ALTER TABLE session_state ADD COLUMN resolved_conversation_ttl TEXT NOT NULL DEFAULT '5m';
  ALTER TABLE session_state ADD COLUMN warmup_state TEXT;
  -- Gradient calibration state (survives restarts to avoid uncalibrated busts)
  ALTER TABLE session_state ADD COLUMN dynamic_context_cap REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN bust_rate_ema REAL NOT NULL DEFAULT -1;
  ALTER TABLE session_state ADD COLUMN inter_bust_interval_ema REAL NOT NULL DEFAULT -1;
  ALTER TABLE session_state ADD COLUMN last_layer INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_known_input INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_turn_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_bust_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Version 25: Adaptive dedup threshold — store accept/reject feedback
  -- on embedding-based duplicate pairs for per-project threshold calibration.
  -- Titles stored instead of FK IDs because entries are deleted during dedup;
  -- the similarity float is the actual calibration input.
  CREATE TABLE IF NOT EXISTS dedup_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    entry_a_title TEXT NOT NULL,
    entry_b_title TEXT NOT NULL,
    similarity REAL NOT NULL,
    accepted INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dedup_feedback_project
    ON dedup_feedback(project_id);
  `,
];

/** Return the resolved path of the SQLite database file. */
export function dbPath(): string {
  const envPath = process.env.LORE_DB_PATH;
  if (envPath) return envPath;
  return join(dataDir(), "lore.db");
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
    // Guard: refuse to open the production DB during test runs.
    // The test preload (setup.ts) sets LORE_DB_PATH to a temp directory.
    // If we reach here with NODE_ENV=test, the preload didn't fire
    // (e.g. bun test invoked from outside the repo). Throw instead of
    // silently writing test fixtures into the user's live database.
    if (process.env.NODE_ENV === "test") {
      throw new Error(
        "LORE_DB_PATH is not set but NODE_ENV=test. " +
          "Run tests via `bun test` from the repo root, or set " +
          "LORE_DB_PATH to a temp path to avoid polluting the production DB.",
      );
    }
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
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_path_aliases (
      path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // Recover missing columns from partial migration runs.
  // Version 17 added call_type to distillations but the ALTER could have been
  // skipped if the version was bumped without the column being created.
  const cols = database
    .query("PRAGMA table_info(distillations)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "call_type")) {
    database.exec("ALTER TABLE distillations ADD COLUMN call_type TEXT;");
  }
}

/**
 * Merge all data from `sourceId` project into `targetId` project.
 *
 * Moves knowledge, temporal messages, distillations, LAT sections, and
 * path aliases from source to target. Registers the source project's path
 * as an alias of the target. Deletes the source project row.
 *
 * Used internally during lazy git-remote backfill when two path-only
 * projects are discovered to share the same git remote.
 */
export function mergeProjectInternal(
  sourceId: string,
  targetId: string,
): void {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.query("UPDATE knowledge SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    d.query(
      "UPDATE temporal_messages SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    d.query(
      "UPDATE distillations SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    d.query("UPDATE lat_sections SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    d.query(
      "UPDATE OR IGNORE project_path_aliases SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    // Register source's path as alias of target
    const sourceRow = d
      .query("SELECT path FROM projects WHERE id = ?")
      .get(sourceId) as { path: string } | null;
    if (sourceRow) {
      d.query(
        "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
      ).run(sourceRow.path, targetId);
    }
    d.query("DELETE FROM projects WHERE id = ?").run(sourceId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function close() {
  if (instance) {
    instance.close();
    instance = undefined;
  }
}

// Project management

/**
 * Look up or create a project by filesystem path, with git-remote awareness.
 *
 * Resolution order:
 *  1. Exact path match in `projects` table (fast path, O(1) index scan)
 *  2. Path alias match in `project_path_aliases` (worktree/clone re-visits)
 *  3. Git remote match — runs `git remote -v` (once per unique path, cached),
 *     finds an existing project with the same normalized remote URL
 *  4. Create a new project row
 *
 * When a git-remote match is found (step 3), the new path is registered as
 * an alias so subsequent calls skip the subprocess. If the matched project's
 * git_remote was not yet populated (pre-v14 rows), it is backfilled lazily.
 */
export function ensureProject(path: string, name?: string, suppliedGitRemote?: string | null): string {
  // Guard: reject synthetic test paths when targeting the production DB.
  // Test paths like "/test/ltm/project" are absolute paths that don't exist
  // on any real filesystem — they're only valid in test suites running against
  // a temp DB (LORE_DB_PATH set by test preload). If we see such a path
  // without LORE_DB_PATH being set, a test is likely hitting the production DB.
  // Note: LORE_DB_PATH unset is used as a proxy for "production DB". This
  // wouldn't catch the unlikely case of someone explicitly setting LORE_DB_PATH
  // to the default production path, but that's not a realistic scenario.
  if (!process.env.LORE_DB_PATH && /^\/test\//.test(path)) {
    throw new Error(
      `Refusing to create project with test path "${path}" in the production DB. ` +
        `Set LORE_DB_PATH to a temp path, or run tests via \`bun test\` from the repo root.`,
    );
  }

  // 1. Exact path match (fast path)
  const existing = db()
    .query("SELECT id, git_remote FROM projects WHERE path = ?")
    .get(path) as { id: string; git_remote: string | null } | null;
  if (existing) {
    // Lazy backfill: populate git_remote on pre-v14 rows
    if (!existing.git_remote) {
      const resolvedRemote = suppliedGitRemote ?? getGitRemote(path);
      if (resolvedRemote) {
        // Check for conflict: another project already has this git_remote.
        // If so, merge the conflicting project into this one (one-time).
        const conflict = db()
          .query(
            "SELECT id FROM projects WHERE git_remote = ? AND id != ? LIMIT 1",
          )
          .get(resolvedRemote, existing.id) as { id: string } | null;
        if (conflict) {
          mergeProjectInternal(conflict.id, existing.id);
        }
        db()
          .query("UPDATE projects SET git_remote = ? WHERE id = ?")
          .run(resolvedRemote, existing.id);
      }
    }
    return existing.id;
  }

  // 2. Check path aliases (worktree/clone re-visits)
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  if (alias) return alias.project_id;

  // 3. Git remote identification
  const gitRemote = suppliedGitRemote ?? getGitRemote(path);
  if (gitRemote) {
    const byRemote = db()
      .query("SELECT id FROM projects WHERE git_remote = ? LIMIT 1")
      .get(gitRemote) as { id: string } | null;
    if (byRemote) {
      // Register this path as an alias for O(1) future lookups
      db()
        .query(
          "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
        )
        .run(path, byRemote.id);
      return byRemote.id;
    }
  }

  // 4. Create new project
  const id = crypto.randomUUID();
  db()
    .query(
      "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      id,
      path,
      name ?? repoNameFromRemote(gitRemote) ?? path.split("/").pop() ?? "unknown",
      gitRemote,
      Date.now(),
    );
  return id;
}

export function projectId(path: string): string | undefined {
  const row = db()
    .query("SELECT id FROM projects WHERE path = ?")
    .get(path) as { id: string } | null;
  if (row) return row.id;

  // Check path aliases (worktree/clone paths registered by ensureProject)
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  return alias?.project_id;
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
// Conversation import tracking
// ---------------------------------------------------------------------------

/**
 * Get the timestamp of the last conversation import offer/run for a project.
 * Returns null if import has never been offered for this project.
 */
export function getLastImportAt(projectPath: string): number | null {
  const id = ensureProject(projectPath);
  const row = db()
    .query("SELECT last_import_at FROM projects WHERE id = ?")
    .get(id) as { last_import_at: number | null } | null;
  return row?.last_import_at ?? null;
}

/**
 * Record that conversation import was offered/run for a project.
 * Prevents auto-import from re-prompting, and enables incremental imports.
 */
export function setLastImportAt(projectPath: string, timestamp: number): void {
  const id = ensureProject(projectPath);
  db()
    .query("UPDATE projects SET last_import_at = ? WHERE id = ?")
    .run(timestamp, id);
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

/** Persisted cost snapshot for a session. */
export type SessionCostSnapshot = {
  conversationCost: number;
  workerCost: number;
  conversationTurns: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  warmupSavings: number;
  warmupHits: number;
  ttlSavings: number;
  ttlHits: number;
  batchSavings: number;
  avoidedCompactions: number;
  avoidedCompactionCost: number;
};

/**
 * Persist a session's cost snapshot. Uses INSERT OR REPLACE so it works
 * whether or not a row already exists (forceMinLayer may have created one).
 */
export function saveSessionCosts(sessionID: string, costs: SessionCostSnapshot): void {
  db()
    .query(
      `INSERT INTO session_state (session_id, force_min_layer, updated_at,
         conversation_cost, worker_cost, conversation_turns,
         cache_read_tokens, cache_write_tokens,
         warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
         avoided_compactions, avoided_compaction_cost)
       VALUES (?, COALESCE((SELECT force_min_layer FROM session_state WHERE session_id = ?), 0), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_cost = excluded.conversation_cost,
         worker_cost = excluded.worker_cost,
         conversation_turns = excluded.conversation_turns,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         warmup_savings = excluded.warmup_savings,
         warmup_hits = excluded.warmup_hits,
         ttl_savings = excluded.ttl_savings,
         ttl_hits = excluded.ttl_hits,
         batch_savings = excluded.batch_savings,
         avoided_compactions = excluded.avoided_compactions,
         avoided_compaction_cost = excluded.avoided_compaction_cost,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionID, sessionID, Date.now(),
      costs.conversationCost, costs.workerCost, costs.conversationTurns,
      costs.cacheReadTokens, costs.cacheWriteTokens,
      costs.warmupSavings, costs.warmupHits, costs.ttlSavings, costs.ttlHits, costs.batchSavings,
      costs.avoidedCompactions, costs.avoidedCompactionCost,
    );
}

/**
 * Load persisted cost snapshot for a session. Returns null if not stored
 * or if all cost columns are zero (pre-migration row from forceMinLayer only).
 */
export function loadSessionCosts(sessionID: string): SessionCostSnapshot | null {
  const row = db()
    .query(
      `SELECT conversation_cost, worker_cost, conversation_turns,
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost
       FROM session_state WHERE session_id = ?`,
    )
    .get(sessionID) as {
      conversation_cost: number;
      worker_cost: number;
      conversation_turns: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      warmup_savings: number;
      warmup_hits: number;
      ttl_savings: number;
      ttl_hits: number;
      batch_savings: number;
      avoided_compactions: number;
      avoided_compaction_cost: number;
    } | null;
  if (!row) return null;
  return {
    conversationCost: row.conversation_cost,
    workerCost: row.worker_cost,
    conversationTurns: row.conversation_turns,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    warmupSavings: row.warmup_savings,
    warmupHits: row.warmup_hits,
    ttlSavings: row.ttl_savings,
    ttlHits: row.ttl_hits,
    batchSavings: row.batch_savings,
    avoidedCompactions: row.avoided_compactions,
    avoidedCompactionCost: row.avoided_compaction_cost,
  };
}

/**
 * Load cost snapshots for all sessions that have non-zero cost data.
 * Returns a map of sessionID → SessionCostSnapshot.
 */
export function loadAllSessionCosts(): Map<string, SessionCostSnapshot> {
  const rows = db()
    .query(
      `SELECT session_id, conversation_cost, worker_cost, conversation_turns,
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost
       FROM session_state
       WHERE conversation_turns > 0 OR warmup_savings > 0 OR ttl_savings > 0 OR batch_savings > 0`,
    )
    .all() as Array<{
      session_id: string;
      conversation_cost: number;
      worker_cost: number;
      conversation_turns: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      warmup_savings: number;
      warmup_hits: number;
      ttl_savings: number;
      ttl_hits: number;
      batch_savings: number;
      avoided_compactions: number;
      avoided_compaction_cost: number;
    }>;
  const result = new Map<string, SessionCostSnapshot>();
  for (const row of rows) {
    result.set(row.session_id, {
      conversationCost: row.conversation_cost,
      workerCost: row.worker_cost,
      conversationTurns: row.conversation_turns,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      warmupSavings: row.warmup_savings,
      warmupHits: row.warmup_hits,
      ttlSavings: row.ttl_savings,
      ttlHits: row.ttl_hits,
      batchSavings: row.batch_savings,
      avoidedCompactions: row.avoided_compactions,
      avoidedCompactionCost: row.avoided_compaction_cost,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session tracking state (session_state table, v23 columns)
// ---------------------------------------------------------------------------

/** Fields that can be persisted for session tracking state. */
export type SessionTrackingState = {
  lastCuratedAt?: number;
  messageCount?: number;
  turnsSinceCuration?: number;
  consecutiveTextOnlyTurns?: number;
  ltmCacheText?: string | null;
  ltmCacheTokens?: number | null;
  ltmPinText?: string | null;
  ltmPinTokens?: number | null;
  // v24: session identity
  fingerprint?: string;
  headerSessionId?: string | null;
  headerName?: string | null;
  // v24: cache warming
  resolvedConversationTTL?: string;
  warmupState?: string | null; // JSON blob
  // v24: gradient calibration
  dynamicContextCap?: number;
  bustRateEMA?: number;
  interBustIntervalEMA?: number;
  lastLayer?: number;
  lastKnownInput?: number;
  lastTurnAt?: number;
  lastBustAt?: number;
};

/**
 * Persist session tracking state. Ensures the row exists, then updates
 * only the fields that are explicitly provided (not undefined).
 */
export function saveSessionTracking(sessionID: string, state: SessionTrackingState): void {
  const now = Date.now();

  // Ensure row exists (no-op if it already does)
  db()
    .query(
      "INSERT OR IGNORE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, 0, ?)",
    )
    .run(sessionID, now);

  // Build SET clauses for only the provided fields
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | number | null)[] = [now];

  if (state.lastCuratedAt !== undefined) {
    sets.push("last_curated_at = ?");
    vals.push(state.lastCuratedAt);
  }
  if (state.messageCount !== undefined) {
    sets.push("message_count = ?");
    vals.push(state.messageCount);
  }
  if (state.turnsSinceCuration !== undefined) {
    sets.push("turns_since_curation = ?");
    vals.push(state.turnsSinceCuration);
  }
  if (state.consecutiveTextOnlyTurns !== undefined) {
    sets.push("consecutive_text_only_turns = ?");
    vals.push(state.consecutiveTextOnlyTurns);
  }
  if (state.ltmCacheText !== undefined) {
    sets.push("ltm_cache_text = ?");
    vals.push(state.ltmCacheText);
  }
  if (state.ltmCacheTokens !== undefined) {
    sets.push("ltm_cache_tokens = ?");
    vals.push(state.ltmCacheTokens);
  }
  if (state.ltmPinText !== undefined) {
    sets.push("ltm_pin_text = ?");
    vals.push(state.ltmPinText);
  }
  if (state.ltmPinTokens !== undefined) {
    sets.push("ltm_pin_tokens = ?");
    vals.push(state.ltmPinTokens);
  }
  // v24: session identity
  if (state.fingerprint !== undefined) {
    sets.push("fingerprint = ?");
    vals.push(state.fingerprint);
  }
  if (state.headerSessionId !== undefined) {
    sets.push("header_session_id = ?");
    vals.push(state.headerSessionId);
  }
  if (state.headerName !== undefined) {
    sets.push("header_name = ?");
    vals.push(state.headerName);
  }
  // v24: cache warming
  if (state.resolvedConversationTTL !== undefined) {
    sets.push("resolved_conversation_ttl = ?");
    vals.push(state.resolvedConversationTTL);
  }
  if (state.warmupState !== undefined) {
    sets.push("warmup_state = ?");
    vals.push(state.warmupState);
  }
  // v24: gradient calibration
  if (state.dynamicContextCap !== undefined) {
    sets.push("dynamic_context_cap = ?");
    vals.push(state.dynamicContextCap);
  }
  if (state.bustRateEMA !== undefined) {
    sets.push("bust_rate_ema = ?");
    vals.push(state.bustRateEMA);
  }
  if (state.interBustIntervalEMA !== undefined) {
    sets.push("inter_bust_interval_ema = ?");
    vals.push(state.interBustIntervalEMA);
  }
  if (state.lastLayer !== undefined) {
    sets.push("last_layer = ?");
    vals.push(state.lastLayer);
  }
  if (state.lastKnownInput !== undefined) {
    sets.push("last_known_input = ?");
    vals.push(state.lastKnownInput);
  }
  if (state.lastTurnAt !== undefined) {
    sets.push("last_turn_at = ?");
    vals.push(state.lastTurnAt);
  }
  if (state.lastBustAt !== undefined) {
    sets.push("last_bust_at = ?");
    vals.push(state.lastBustAt);
  }

  // Update only the specified columns
  db()
    .query(
      "UPDATE session_state SET " + sets.join(", ") + " WHERE session_id = ?",
    )
    .run(...vals, sessionID);
}

/** Loaded session tracking state. */
export type LoadedSessionTracking = {
  lastCuratedAt: number;
  messageCount: number;
  turnsSinceCuration: number;
  consecutiveTextOnlyTurns: number;
  ltmCacheText: string | null;
  ltmCacheTokens: number | null;
  ltmPinText: string | null;
  ltmPinTokens: number | null;
  // v24: session identity
  fingerprint: string;
  headerSessionId: string | null;
  headerName: string | null;
  // v24: cache warming
  resolvedConversationTTL: string;
  warmupState: string | null;
  // v24: gradient calibration
  dynamicContextCap: number;
  bustRateEMA: number;
  interBustIntervalEMA: number;
  lastLayer: number;
  lastKnownInput: number;
  lastTurnAt: number;
  lastBustAt: number;
};

/**
 * Load persisted session tracking state. Returns null if no row exists.
 */
export function loadSessionTracking(sessionID: string): LoadedSessionTracking | null {
  const row = db()
    .query(
      `SELECT last_curated_at, message_count, turns_since_curation,
              consecutive_text_only_turns,
              ltm_cache_text, ltm_cache_tokens, ltm_pin_text, ltm_pin_tokens,
              fingerprint, header_session_id, header_name,
              resolved_conversation_ttl, warmup_state,
              dynamic_context_cap, bust_rate_ema, inter_bust_interval_ema,
              last_layer, last_known_input, last_turn_at, last_bust_at
       FROM session_state WHERE session_id = ?`,
    )
    .get(sessionID) as {
      last_curated_at: number;
      message_count: number;
      turns_since_curation: number;
      consecutive_text_only_turns: number;
      ltm_cache_text: string | null;
      ltm_cache_tokens: number | null;
      ltm_pin_text: string | null;
      ltm_pin_tokens: number | null;
      fingerprint: string;
      header_session_id: string | null;
      header_name: string | null;
      resolved_conversation_ttl: string;
      warmup_state: string | null;
      dynamic_context_cap: number;
      bust_rate_ema: number;
      inter_bust_interval_ema: number;
      last_layer: number;
      last_known_input: number;
      last_turn_at: number;
      last_bust_at: number;
    } | null;
  if (!row) return null;
  return {
    lastCuratedAt: row.last_curated_at,
    messageCount: row.message_count,
    turnsSinceCuration: row.turns_since_curation,
    consecutiveTextOnlyTurns: row.consecutive_text_only_turns,
    ltmCacheText: row.ltm_cache_text,
    ltmCacheTokens: row.ltm_cache_tokens,
    ltmPinText: row.ltm_pin_text,
    ltmPinTokens: row.ltm_pin_tokens,
    fingerprint: row.fingerprint,
    headerSessionId: row.header_session_id,
    headerName: row.header_name,
    resolvedConversationTTL: row.resolved_conversation_ttl,
    warmupState: row.warmup_state,
    dynamicContextCap: row.dynamic_context_cap,
    bustRateEMA: row.bust_rate_ema,
    interBustIntervalEMA: row.inter_bust_interval_ema,
    lastLayer: row.last_layer,
    lastKnownInput: row.last_known_input,
    lastTurnAt: row.last_turn_at,
    lastBustAt: row.last_bust_at,
  };
}

/**
 * Load all persisted header → session ID mappings from the session_state table.
 *
 * Used on gateway startup (in initIfNeeded) to pre-populate the in-memory
 * headerSessionIndex so Tier 1 session identification works immediately
 * after a process restart — without this, the first post-restart request
 * with a known session header would generate a new session ID and orphan
 * the old session's persisted state.
 */
export function loadHeaderSessionIndex(): Array<{
  sessionId: string;
  headerSessionId: string;
  headerName: string;
}> {
  const rows = db()
    .query(
      `SELECT session_id, header_session_id, header_name
       FROM session_state
       WHERE header_session_id IS NOT NULL AND header_name IS NOT NULL`,
    )
    .all() as Array<{
      session_id: string;
      header_session_id: string;
      header_name: string;
    }>;
  return rows.map((row) => ({
    sessionId: row.session_id,
    headerSessionId: row.header_session_id,
    headerName: row.header_name,
  }));
}

// ---------------------------------------------------------------------------
// Key-value store (kv_meta table)
// ---------------------------------------------------------------------------

/** Get a kv_meta value by key. Returns null if not found. */
export function getKV(key: string): string | null {
  const row = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Set a kv_meta value (upsert). */
export function setKV(key: string, value: string): void {
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(key, value, value);
}

// ---------------------------------------------------------------------------
// Installation metadata (metadata table)
// ---------------------------------------------------------------------------

/** Get a metadata value by key. Returns null if not found. */
export function getMeta(key: string): string | null {
  const row = db()
    .query("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Set a metadata value (upsert). */
export function setMeta(key: string, value: string): void {
  db()
    .query(
      "INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?",
    )
    .run(key, value, Date.now(), value, Date.now());
}

/**
 * Get or create the installation instance ID.
 *
 * Generated once (UUID v4) on first call, then persisted in the metadata
 * table across process restarts and upgrades.
 */
export function getInstanceId(): string {
  const existing = getMeta("instance_id");
  if (existing) return existing;
  const id = crypto.randomUUID();
  setMeta("instance_id", id);
  return id;
}
