import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db, close, ensureProject, projectId, mergeProjectInternal, loadForceMinLayer, saveForceMinLayer, getMeta, setMeta, getInstanceId, saveSessionCosts, loadSessionCosts, loadAllSessionCosts, getLastImportAt, setLastImportAt, saveSessionTracking, loadSessionTracking, loadHeaderSessionIndex, getKV, setKV } from "../src/db";


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
    expect(names).toContain("import_history");
  });

  test("schema version is set", () => {
    const row = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(25);
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

  test("ensureProject with supplied gitRemote groups different paths", () => {
    // Create a project with an explicit git remote (simulates a remote gateway
    // receiving the X-Lore-Git-Remote header from a client).
    const id1 = ensureProject(
      "/test/supplied-remote/path-a",
      undefined,
      "github.com/test/supplied-remote-repo",
    );

    // Verify the git_remote was stored
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id1) as { git_remote: string | null };
    expect(row.git_remote).toBe("github.com/test/supplied-remote-repo");

    // A different path with the same supplied git remote should resolve
    // to the same project (via step 3: git remote match) and register
    // the new path as an alias.
    const id2 = ensureProject(
      "/test/supplied-remote/path-b",
      undefined,
      "github.com/test/supplied-remote-repo",
    );
    expect(id2).toBe(id1);

    // Verify the alias was registered for O(1) future lookups
    const alias = db()
      .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
      .get("/test/supplied-remote/path-b") as { project_id: string } | null;
    expect(alias).not.toBeNull();
    expect(alias!.project_id).toBe(id1);
  });

  test("ensureProject with supplied gitRemote backfills existing project", () => {
    // Create a project without a git remote (simulates pre-v14 or local-only)
    const id1 = ensureProject("/test/backfill-remote/original");
    const rowBefore = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id1) as { git_remote: string | null };
    expect(rowBefore.git_remote).toBeNull();

    // Re-visit with a supplied git remote — should backfill the remote
    const id2 = ensureProject(
      "/test/backfill-remote/original",
      undefined,
      "github.com/test/backfill-repo",
    );
    expect(id2).toBe(id1);

    const rowAfter = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id1) as { git_remote: string | null };
    expect(rowAfter.git_remote).toBe("github.com/test/backfill-repo");
  });

  test("ensureProject with supplied gitRemote=null falls through to create", () => {
    // Passing null explicitly should behave like not passing it at all
    // (no git remote, no deduplication by remote).
    const id = ensureProject(
      "/test/null-remote/project",
      undefined,
      null,
    );
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id) as { git_remote: string | null };
    expect(row.git_remote).toBeNull();
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

  test("saveSessionCosts and loadSessionCosts round-trip", () => {
    const sid = `test-costs-${crypto.randomUUID()}`;
    const snapshot = {
      conversationCost: 1.23,
      workerCost: 0.45,
      conversationTurns: 10,
      cacheReadTokens: 50000,
      cacheWriteTokens: 5000,
      warmupSavings: 0.12,
      warmupHits: 3,
      ttlSavings: 0.34,
      ttlHits: 7,
      batchSavings: 0.56,
      avoidedCompactions: 2,
      avoidedCompactionCost: 0.78,
    };
    saveSessionCosts(sid, snapshot);
    const loaded = loadSessionCosts(sid);
    expect(loaded).toEqual(snapshot);
  });

  test("saveSessionCosts overwrites existing data", () => {
    const sid = `test-costs-overwrite-${crypto.randomUUID()}`;
    saveSessionCosts(sid, {
      conversationCost: 1.0, workerCost: 0, conversationTurns: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      warmupSavings: 0, warmupHits: 0, ttlSavings: 0, ttlHits: 0, batchSavings: 0,
      avoidedCompactions: 0, avoidedCompactionCost: 0,
    });
    saveSessionCosts(sid, {
      conversationCost: 2.0, workerCost: 0.5, conversationTurns: 15,
      cacheReadTokens: 100000, cacheWriteTokens: 10000,
      warmupSavings: 0.5, warmupHits: 5, ttlSavings: 0.8, ttlHits: 10, batchSavings: 1.2,
      avoidedCompactions: 3, avoidedCompactionCost: 1.5,
    });
    const loaded = loadSessionCosts(sid);
    expect(loaded!.conversationCost).toBe(2.0);
    expect(loaded!.conversationTurns).toBe(15);
    expect(loaded!.warmupSavings).toBe(0.5);
    expect(loaded!.avoidedCompactions).toBe(3);
    expect(loaded!.avoidedCompactionCost).toBe(1.5);
  });

  test("saveSessionCosts preserves existing forceMinLayer", () => {
    const sid = `test-costs-layer-${crypto.randomUUID()}`;
    saveForceMinLayer(sid, 2);
    saveSessionCosts(sid, {
      conversationCost: 1.0, workerCost: 0, conversationTurns: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      warmupSavings: 0, warmupHits: 0, ttlSavings: 0, ttlHits: 0, batchSavings: 0,
      avoidedCompactions: 0, avoidedCompactionCost: 0,
    });
    expect(loadForceMinLayer(sid)).toBe(2);
    expect(loadSessionCosts(sid)!.conversationTurns).toBe(5);
  });

  test("loadSessionCosts returns null for unknown session", () => {
    expect(loadSessionCosts("nonexistent-session")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Migration v22: last_import_at on projects
  // -------------------------------------------------------------------------

  test("projects table has last_import_at column (migration v22)", () => {
    const cols = db()
      .query("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("last_import_at");
  });

  test("getLastImportAt returns null for new project", () => {
    const result = getLastImportAt("/test/import-tracking/new");
    expect(result).toBeNull();
  });

  test("setLastImportAt and getLastImportAt round-trip", () => {
    const path = "/test/import-tracking/roundtrip";
    const ts = Date.now();
    setLastImportAt(path, ts);
    expect(getLastImportAt(path)).toBe(ts);
  });

  test("setLastImportAt updates existing value", () => {
    const path = "/test/import-tracking/update";
    setLastImportAt(path, 1000);
    expect(getLastImportAt(path)).toBe(1000);
    setLastImportAt(path, 2000);
    expect(getLastImportAt(path)).toBe(2000);
  });

  test("loadAllSessionCosts returns only sessions with cost data", () => {
    const sid1 = `test-costs-all-1-${crypto.randomUUID()}`;
    const sid2 = `test-costs-all-2-${crypto.randomUUID()}`;
    saveSessionCosts(sid1, {
      conversationCost: 1.0, workerCost: 0, conversationTurns: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      warmupSavings: 0.1, warmupHits: 1, ttlSavings: 0, ttlHits: 0, batchSavings: 0,
      avoidedCompactions: 1, avoidedCompactionCost: 0.3,
    });
    // sid2: all zeros — should not appear (only forceMinLayer row)
    saveForceMinLayer(sid2, 1);

    const all = loadAllSessionCosts();
    expect(all.has(sid1)).toBe(true);
    expect(all.has(sid2)).toBe(false);
    expect(all.get(sid1)!.warmupSavings).toBe(0.1);
  });

  // -------------------------------------------------------------------------
  // Migration v23: Session tracking state persistence
  // -------------------------------------------------------------------------

  test("session_state has v23 tracking columns", () => {
    const cols = db()
      .query("PRAGMA table_info(session_state)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("last_curated_at");
    expect(names).toContain("message_count");
    expect(names).toContain("turns_since_curation");
    expect(names).toContain("ltm_cache_text");
    expect(names).toContain("ltm_cache_tokens");
    expect(names).toContain("ltm_pin_text");
    expect(names).toContain("ltm_pin_tokens");
    expect(names).toContain("consecutive_text_only_turns");
  });

  test("saveSessionTracking and loadSessionTracking round-trip", () => {
    const sid = `test-tracking-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      lastCuratedAt: 1000,
      messageCount: 42,
      turnsSinceCuration: 5,
      ltmCacheText: "cached LTM text",
      ltmCacheTokens: 100,
      ltmPinText: "pinned LTM text",
      ltmPinTokens: 90,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastCuratedAt).toBe(1000);
    expect(loaded!.messageCount).toBe(42);
    expect(loaded!.turnsSinceCuration).toBe(5);
    expect(loaded!.ltmCacheText).toBe("cached LTM text");
    expect(loaded!.ltmCacheTokens).toBe(100);
    expect(loaded!.ltmPinText).toBe("pinned LTM text");
    expect(loaded!.ltmPinTokens).toBe(90);
  });

  test("saveSessionTracking partial update preserves other fields", () => {
    const sid = `test-tracking-partial-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      lastCuratedAt: 1000,
      messageCount: 10,
      turnsSinceCuration: 3,
    });
    // Update only messageCount
    saveSessionTracking(sid, { messageCount: 20 });
    const loaded = loadSessionTracking(sid);
    expect(loaded!.lastCuratedAt).toBe(1000);
    expect(loaded!.messageCount).toBe(20);
    expect(loaded!.turnsSinceCuration).toBe(3);
  });

  test("saveSessionTracking preserves existing forceMinLayer", () => {
    const sid = `test-tracking-layer-${crypto.randomUUID()}`;
    saveForceMinLayer(sid, 2);
    saveSessionTracking(sid, { messageCount: 15 });
    expect(loadForceMinLayer(sid)).toBe(2);
    expect(loadSessionTracking(sid)!.messageCount).toBe(15);
  });

  test("loadSessionTracking returns null for unknown session", () => {
    expect(loadSessionTracking("nonexistent-tracking")).toBeNull();
  });

  test("saveSessionTracking can set ltm fields to null", () => {
    const sid = `test-tracking-null-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      ltmCacheText: "some text",
      ltmCacheTokens: 50,
    });
    expect(loadSessionTracking(sid)!.ltmCacheText).toBe("some text");
    // Clear the cache
    saveSessionTracking(sid, {
      ltmCacheText: null,
      ltmCacheTokens: null,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded!.ltmCacheText).toBeNull();
    expect(loaded!.ltmCacheTokens).toBeNull();
  });

  // -------------------------------------------------------------------------
  // v24: session identity, cache warming, gradient state
  // -------------------------------------------------------------------------

  test("saveSessionTracking v24 session identity round-trip", () => {
    const sid = `test-v24-identity-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      fingerprint: "abc123hash",
      headerSessionId: "uuid-4567",
      headerName: "x-claude-code-session-id",
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded!.fingerprint).toBe("abc123hash");
    expect(loaded!.headerSessionId).toBe("uuid-4567");
    expect(loaded!.headerName).toBe("x-claude-code-session-id");
  });

  test("saveSessionTracking v24 cache warming round-trip", () => {
    const sid = `test-v24-warming-${crypto.randomUUID()}`;
    const warmup = { lastWarmupAt: 1000, warmupCount: 3, warmupHits: 1, disabled: false, forceKeepWarm: true };
    saveSessionTracking(sid, {
      resolvedConversationTTL: "1h",
      warmupState: JSON.stringify(warmup),
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded!.resolvedConversationTTL).toBe("1h");
    const parsed = JSON.parse(loaded!.warmupState!);
    expect(parsed.warmupCount).toBe(3);
    expect(parsed.forceKeepWarm).toBe(true);
  });

  test("saveSessionTracking v24 gradient state round-trip", () => {
    const sid = `test-v24-gradient-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      dynamicContextCap: 150000,
      bustRateEMA: 0.35,
      interBustIntervalEMA: 120000,
      lastLayer: 1,
      lastKnownInput: 80000,
      lastTurnAt: Date.now() - 5000,
      lastBustAt: Date.now() - 60000,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded!.dynamicContextCap).toBe(150000);
    expect(loaded!.bustRateEMA).toBeCloseTo(0.35);
    expect(loaded!.interBustIntervalEMA).toBe(120000);
    expect(loaded!.lastLayer).toBe(1);
    expect(loaded!.lastKnownInput).toBe(80000);
    expect(loaded!.lastTurnAt).toBeGreaterThan(0);
    expect(loaded!.lastBustAt).toBeGreaterThan(0);
  });

  test("saveSessionTracking v24 partial update preserves v23 + v24 fields", () => {
    const sid = `test-v24-partial-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      messageCount: 10,
      fingerprint: "hash1",
      dynamicContextCap: 100000,
    });
    // Update only gradient field
    saveSessionTracking(sid, { bustRateEMA: 0.5 });
    const loaded = loadSessionTracking(sid);
    expect(loaded!.messageCount).toBe(10);
    expect(loaded!.fingerprint).toBe("hash1");
    expect(loaded!.dynamicContextCap).toBe(100000);
    expect(loaded!.bustRateEMA).toBeCloseTo(0.5);
  });

  test("saveSessionTracking v24 defaults are correct for new rows", () => {
    const sid = `test-v24-defaults-${crypto.randomUUID()}`;
    saveSessionTracking(sid, { messageCount: 1 });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    // v24 defaults
    expect(loaded!.fingerprint).toBe("");
    expect(loaded!.headerSessionId).toBeNull();
    expect(loaded!.headerName).toBeNull();
    expect(loaded!.resolvedConversationTTL).toBe("5m");
    expect(loaded!.warmupState).toBeNull();
    expect(loaded!.dynamicContextCap).toBe(0);
    expect(loaded!.bustRateEMA).toBe(-1);
    expect(loaded!.interBustIntervalEMA).toBe(-1);
    expect(loaded!.lastLayer).toBe(0);
    expect(loaded!.lastKnownInput).toBe(0);
    expect(loaded!.lastTurnAt).toBe(0);
    expect(loaded!.lastBustAt).toBe(0);
  });

  // -------------------------------------------------------------------------
  // loadHeaderSessionIndex
  // -------------------------------------------------------------------------

  test("loadHeaderSessionIndex only returns sessions with non-null headers", () => {
    const sid1 = `test-hsi-1-${crypto.randomUUID()}`;
    const sid2 = `test-hsi-2-${crypto.randomUUID()}`;
    saveSessionTracking(sid1, {
      headerSessionId: "uuid-aaa",
      headerName: "x-claude-code-session-id",
    });
    saveSessionTracking(sid2, {
      headerSessionId: "uuid-bbb",
      headerName: "x-session-affinity",
    });
    // Session without headers should NOT appear
    const sid3 = `test-hsi-3-${crypto.randomUUID()}`;
    saveSessionTracking(sid3, { messageCount: 5 });

    const entries = loadHeaderSessionIndex();
    const found1 = entries.find((e) => e.sessionId === sid1);
    const found2 = entries.find((e) => e.sessionId === sid2);
    const found3 = entries.find((e) => e.sessionId === sid3);

    expect(found1).toBeDefined();
    expect(found1!.headerSessionId).toBe("uuid-aaa");
    expect(found1!.headerName).toBe("x-claude-code-session-id");
    expect(found2).toBeDefined();
    expect(found2!.headerSessionId).toBe("uuid-bbb");
    expect(found2!.headerName).toBe("x-session-affinity");
    expect(found3).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // KV helpers (kv_meta table)
  // -------------------------------------------------------------------------

  test("getKV returns null for unknown key", () => {
    expect(getKV("nonexistent_kv_key")).toBeNull();
  });

  test("setKV and getKV round-trip", () => {
    setKV("test_kv_key", "test_kv_value");
    expect(getKV("test_kv_key")).toBe("test_kv_value");
  });

  test("setKV upserts on conflict", () => {
    setKV("kv_upsert", "first");
    expect(getKV("kv_upsert")).toBe("first");
    setKV("kv_upsert", "second");
    expect(getKV("kv_upsert")).toBe("second");
  });

  describe("ensureProject test-path guard", () => {
    let savedLoreDbPath: string | undefined;

    beforeEach(() => {
      savedLoreDbPath = process.env.LORE_DB_PATH;
    });

    afterEach(() => {
      // Restore — tests run under setup.ts preload so LORE_DB_PATH is set
      if (savedLoreDbPath !== undefined) {
        process.env.LORE_DB_PATH = savedLoreDbPath;
      } else {
        delete process.env.LORE_DB_PATH;
      }
    });

    test("throws for /test/ paths when LORE_DB_PATH is unset", () => {
      delete process.env.LORE_DB_PATH;
      expect(() => ensureProject("/test/ltm/something")).toThrow(
        /Refusing to create project with test path/,
      );
    });

    test("allows /test/ paths when LORE_DB_PATH is set (temp DB)", () => {
      // LORE_DB_PATH is already set by test preload — just verify it works
      expect(() => ensureProject("/test/guard-check")).not.toThrow();
    });

    test("allows non-test paths when LORE_DB_PATH is unset", () => {
      delete process.env.LORE_DB_PATH;
      // The guard only rejects /test/ prefix — real-looking paths pass through.
      // The DB singleton is already initialized (pointing at the temp test DB),
      // so this call writes to the temp DB, not the production one.
      expect(() => ensureProject("/home/user/my-project")).not.toThrow();
    });

    test("does not match similar-but-different path prefixes", () => {
      delete process.env.LORE_DB_PATH;
      // /testing/... and /test (no trailing slash) should NOT be rejected
      expect(() => ensureProject("/testing/something")).not.toThrow();
      expect(() => ensureProject("/test")).not.toThrow();
    });
  });
});
