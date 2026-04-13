import { describe, test, expect, beforeEach } from "bun:test";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/integrity/project";

describe("knowledge integrity checking", () => {
  beforeEach(() => {
    // Clean knowledge for this project
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  describe("check", () => {
    test("detects oversized entries", () => {
      ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Oversized Entry",
        content: "x".repeat(1500), // Exceeds 1200 char limit
        scope: "project",
      });

      const issues = ltm.check(PROJECT);
      const oversized = issues.filter((i) => i.type === "oversized");
      expect(oversized.length).toBe(1);
      expect(oversized[0].description).toContain("1500");
    });

    test("detects empty entries", () => {
      // Create directly via DB to bypass normal validation
      const pid = ensureProject(PROJECT);
      const now = Date.now();
      db()
        .query(
          `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 1.0, ?, ?)`,
        )
        .run("empty-test-id", pid, "decision", "Empty Entry", "   ", now, now);

      const issues = ltm.check(PROJECT);
      const empty = issues.filter((i) => i.type === "empty");
      expect(empty.length).toBe(1);
    });

    test("detects potential duplicates by title", () => {
      // Use explicit IDs to bypass title-based dedup guard in ltm.create()
      const pid = ensureProject(PROJECT);
      const now = Date.now();

      db()
        .query(
          `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 1.0, ?, ?)`,
        )
        .run("dup-a", pid, "decision", "Database Migration Strategy", "Use forward-only migrations", now, now);

      db()
        .query(
          `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 1.0, ?, ?)`,
        )
        .run("dup-b", pid, "decision", "Database Migration Strategy Revised", "Updated migration approach", now, now);

      const issues = ltm.check(PROJECT);
      const duplicates = issues.filter((i) => i.type === "duplicate");
      expect(duplicates.length).toBeGreaterThanOrEqual(1);
    });

    test("returns empty for clean knowledge base", () => {
      ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Clean Entry",
        content: "Well-formed content under the limit",
        scope: "project",
      });

      const issues = ltm.check(PROJECT);
      expect(issues).toEqual([]);
    });
  });
});
