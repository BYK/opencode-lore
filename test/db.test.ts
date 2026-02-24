import { describe, test, expect, afterAll } from "bun:test";
import { db, close, ensureProject, projectId } from "../src/db";

afterAll(() => close());

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
  });

  test("schema version is set", () => {
    const row = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(3);
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
});
