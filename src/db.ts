import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";

const SCHEMA_VERSION = 3;

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
];

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || join(process.env.HOME || "~", ".local", "share");
  return join(base, "opencode-lore");
}

let instance: Database | undefined;

export function db(): Database {
  if (instance) return instance;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lore.db");
  instance = new Database(path, { create: true });
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  // Return freed pages to the OS incrementally on each transaction commit
  // instead of accumulating a free-page list that bloats the file.
  instance.exec("PRAGMA auto_vacuum = INCREMENTAL");
  migrate(instance);
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
  if (current >= MIGRATIONS.length) return;
  for (let i = current; i < MIGRATIONS.length; i++) {
    if (i === VACUUM_MIGRATION_INDEX) {
      // VACUUM cannot run inside a transaction. Run it directly.
      // auto_vacuum mode must be set *before* VACUUM — SQLite bakes it into
      // the file header during the rebuild. After this, every subsequent
      // startup's "PRAGMA auto_vacuum = INCREMENTAL" is a no-op (already set).
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
      database.exec("VACUUM");
    } else {
      database.exec(MIGRATIONS[i]);
    }
  }
  // Update version to latest. Migration 0 inserts version=1 via its own INSERT,
  // but subsequent migrations don't update it, so always normalize to MIGRATIONS.length.
  database.exec(`UPDATE schema_version SET version = ${MIGRATIONS.length}`);
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
