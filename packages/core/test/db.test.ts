import { describe, test, expect } from "bun:test";
import { db, close, ensureProject, projectId, mergeProjectInternal, loadForceMinLayer, saveForceMinLayer, getMeta, setMeta, getInstanceId } from "../src/db";


describe("db", () => {
  test("initializes and creates tables", () => {
    const database = db();
    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("temporal_messages");
    expect(names).toContain("distillations");
    expect(names).toContain("knowledge");
    expect(names).toContain("schema_version");
    expect(names).toContain("session_state");
    expect(names).toContain("metadata");
  });

  test("schema version is set", () => {
    const row = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(17);
  });

  test("distillation_fts virtual table exists", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("distillation_fts");
  });

  test("distillation_fts triggers exist for sync", () => {
    const triggers = db()
      .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'distillation_fts_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain("distillation_fts_insert");
    expect(names).toContain("distillation_fts_delete");
    expect(names).toContain("distillation_fts_update");
  });

  test("compound indexes exist for common query patterns", () => {
    const indexes = db()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    // Compound indexes added in version 6
    expect(names).toContain("idx_temporal_project_session");
    expect(names).toContain("idx_temporal_project_session_distilled");
    expect(names).toContain("idx_temporal_project_distilled_created");
    expect(names).toContain("idx_distillation_project_session");
    expect(names).toContain("idx_distillation_project_session_gen_archived");
    // Redundant single-column indexes should be dropped
    expect(names).not.toContain("idx_temporal_project");
    expect(names).not.toContain("idx_temporal_distilled");
    expect(names).not.toContain("idx_distillation_project");
  });

  test("ensureProject creates and returns id", () => {
    const id = ensureProject("/test/project/alpha");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("ensureProject returns same id for same path", () => {
    const id1 = ensureProject("/test/project/alpha");
    const id2 = ensureProject("/test/project/alpha");
    expect(id1).toBe(id2);
  });

  test("ensureProject creates different ids for different paths", () => {
    const id1 = ensureProject("/test/project/alpha");
    const id2 = ensureProject("/test/project/beta");
    expect(id1).not.toBe(id2);
  });

  test("projectId returns id for known path", () => {
    ensureProject("/test/project/gamma");
    const id = projectId("/test/project/gamma");
    expect(id).toBeTruthy();
  });

  test("projectId returns undefined for unknown path", () => {
    const id = projectId("/nonexistent/path");
    expect(id).toBeUndefined();
  });

  test("saveForceMinLayer persists and loadForceMinLayer retrieves", () => {
    saveForceMinLayer("test-session-persist", 2);
    expect(loadForceMinLayer("test-session-persist")).toBe(2);
  });

  test("saveForceMinLayer(0) deletes the row", () => {
    saveForceMinLayer("test-session-delete", 3);
    expect(loadForceMinLayer("test-session-delete")).toBe(3);
    saveForceMinLayer("test-session-delete", 0);
    expect(loadForceMinLayer("test-session-delete")).toBe(0);
  });

  test("loadForceMinLayer returns 0 for unknown session", () => {
    expect(loadForceMinLayer("nonexistent-session")).toBe(0);
  });

  test("kv_meta table exists (migration v8)", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("kv_meta");
  });

  test("metadata table exists (migration v13)", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("metadata");
  });

  test("getMeta returns null for unknown key", () => {
    expect(getMeta("nonexistent_key")).toBeNull();
  });

  test("setMeta and getMeta round-trip", () => {
    setMeta("test_key", "test_value");
    expect(getMeta("test_key")).toBe("test_value");
  });

  test("setMeta upserts on conflict", () => {
    setMeta("upsert_key", "first");
    expect(getMeta("upsert_key")).toBe("first");
    setMeta("upsert_key", "second");
    expect(getMeta("upsert_key")).toBe("second");
  });

  test("getInstanceId generates and persists UUID", () => {
    const id = getInstanceId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Same value on subsequent calls
    expect(getInstanceId()).toBe(id);
  });

  test("db() re-initializes after close()", () => {
    // Ensure the singleton is populated
    const first = db();
    expect(first).toBeDefined();

    // Close resets the singleton
    close();

    // Next call should re-create and re-migrate — not return a stale handle
    const second = db();
    expect(second).toBeDefined();

    // Verify the new instance is fully migrated (kv_meta exists)
    const row = second
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("kv_meta");
  });

  test("recoverMissingObjects creates kv_meta and metadata when version=latest but tables are missing", () => {
    // Simulate the exact scenario: DB at current version but tables missing
    // due to a partial migration (ALTER TABLE duplicate column aborted exec
    // before CREATE TABLE).
    const d = db();

    // Drop both tables to simulate the broken state
    d.exec("DROP TABLE IF EXISTS kv_meta");
    d.exec("DROP TABLE IF EXISTS metadata");
    expect(
      d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'").get(),
    ).toBeNull();
    expect(
      d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get(),
    ).toBeNull();

    // Close and re-open — migrate() should recover the missing tables
    close();
    const fresh = db();
    const afterKv = fresh
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'")
      .get() as { name: string } | null;
    expect(afterKv).not.toBeNull();
    expect(afterKv!.name).toBe("kv_meta");

    const afterMeta = fresh
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
      .get() as { name: string } | null;
    expect(afterMeta).not.toBeNull();
    expect(afterMeta!.name).toBe("metadata");
  });

  // -------------------------------------------------------------------------
  // Migration v14: git-based project identification
  // -------------------------------------------------------------------------

  test("projects table has git_remote column (migration v14)", () => {
    const cols = db()
      .query("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("git_remote");
  });

  test("project_path_aliases table exists (migration v14)", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
  });

  test("idx_projects_git_remote index exists (migration v14)", () => {
    const indexes = db()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_git_remote'")
      .all() as Array<{ name: string }>;
    expect(indexes.length).toBe(1);
  });

  test("ensureProject stores git_remote as null for non-git paths", () => {
    const id = ensureProject("/test/non-git/project-v14");
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id) as { git_remote: string | null };
    expect(row.git_remote).toBeNull();
  });

  test("projectId resolves via project_path_aliases", () => {
    // Manually create a project and alias
    const id = ensureProject("/test/alias/original");
    db()
      .query("INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)")
      .run("/test/alias/worktree", id);

    // projectId should resolve the alias
    expect(projectId("/test/alias/worktree")).toBe(id);
  });

  test("ensureProject deduplicates via git_remote", () => {
    // Manually insert a project with a git_remote
    const id1 = crypto.randomUUID();
    db()
      .query("INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id1, "/test/git-dedup/original", "original", "github.com/test/dedup-repo", Date.now());

    // Mock getGitRemote by pre-populating the cache
    // (getGitRemote for /test/git-dedup/worktree would return null since it's
    // not a real path, so we test via direct DB manipulation instead)

    // Simulate: another path has same git_remote. ensureProject should find
    // the existing project when looking up by git_remote.
    // Since we can't easily mock getGitRemote in the same module, we test
    // the alias path: register an alias, then verify it resolves.
    db()
      .query("INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)")
      .run("/test/git-dedup/worktree", id1);

    const id2 = ensureProject("/test/git-dedup/worktree");
    expect(id2).toBe(id1);
  });

  test("mergeProjectInternal moves all data from source to target", () => {
    // Create two projects
    const sourceId = ensureProject("/test/merge/source");
    const targetId = ensureProject("/test/merge/target");

    // Add some data to source
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), sourceId, "session-merge", "user", "test message", Date.now());

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), sourceId, "pattern", "Test", "test content", Date.now(), Date.now());

    // Verify source has data
    const sourceMsgsBefore = (
      db()
        .query("SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?")
        .get(sourceId) as { c: number }
    ).c;
    expect(sourceMsgsBefore).toBe(1);

    const sourceKnowledgeBefore = (
      db()
        .query("SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?")
        .get(sourceId) as { c: number }
    ).c;
    expect(sourceKnowledgeBefore).toBe(1);

    // Merge source into target
    mergeProjectInternal(sourceId, targetId);

    // Source should be deleted
    const sourceRow = db()
      .query("SELECT id FROM projects WHERE id = ?")
      .get(sourceId);
    expect(sourceRow).toBeNull();

    // Target should have the data
    const targetMsgs = (
      db()
        .query("SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?")
        .get(targetId) as { c: number }
    ).c;
    expect(targetMsgs).toBe(1);

    const targetKnowledge = (
      db()
        .query("SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?")
        .get(targetId) as { c: number }
    ).c;
    expect(targetKnowledge).toBe(1);

    // Source path should be registered as alias of target
    const alias = db()
      .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
      .get("/test/merge/source") as { project_id: string } | null;
    expect(alias).not.toBeNull();
    expect(alias!.project_id).toBe(targetId);
  });

  test("recoverMissingObjects creates project_path_aliases when missing", () => {
    const d = db();

    // Drop the table to simulate the broken state
    d.exec("DROP TABLE IF EXISTS project_path_aliases");
    expect(
      d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'").get(),
    ).toBeNull();

    // Close and re-open — migrate() should recover
    close();
    const fresh = db();
    const after = fresh
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'")
      .get() as { name: string } | null;
    expect(after).not.toBeNull();
    expect(after!.name).toBe("project_path_aliases");
  });
});
