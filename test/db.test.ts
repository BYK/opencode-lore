import { describe, test, expect } from "bun:test";
import { db, ensureProject, projectId, loadForceMinLayer, saveForceMinLayer } from "../src/db";


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
  });

  test("schema version is set", () => {
    const row = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(9);
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
});
