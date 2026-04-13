import { describe, test, expect, beforeEach } from "bun:test";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/refs/project";

describe("knowledge cross-references", () => {
  beforeEach(() => {
    // Clean knowledge and refs for this project
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge_refs").run();
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  describe("extractRefs", () => {
    test("extracts UUID refs from content", () => {
      const content =
        "Uses the gradient system [[019c904b-791e-772a-ab2b-93ac892a960c]] for context management.";
      const refs = ltm.extractRefs(content);
      expect(refs).toEqual(["019c904b-791e-772a-ab2b-93ac892a960c"]);
    });

    test("extracts title refs from content", () => {
      const content = "See [[DB Schema Migrations]] for details.";
      const refs = ltm.extractRefs(content);
      expect(refs).toEqual(["DB Schema Migrations"]);
    });

    test("extracts multiple refs", () => {
      const content =
        "Links to [[entry-a]] and [[019c904b-791e-772a-ab2b-93ac892a960c]] here.";
      const refs = ltm.extractRefs(content);
      expect(refs.length).toBe(2);
    });

    test("returns empty for content without refs", () => {
      const refs = ltm.extractRefs("No wiki links here.");
      expect(refs).toEqual([]);
    });
  });

  describe("resolveRef", () => {
    test("resolves UUID ref to entry ID", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Test Entry",
        content: "Some content",
        scope: "project",
      });

      const resolved = ltm.resolveRef(id);
      expect(resolved).toBe(id);
    });

    test("returns null for non-existent UUID", () => {
      const resolved = ltm.resolveRef(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(resolved).toBeNull();
    });

    test("resolves title ref via FTS search", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Database Migration Strategy",
        content: "Use forward-only migrations with compensating scripts",
        scope: "project",
      });

      const resolved = ltm.resolveRef("Database Migration Strategy");
      expect(resolved).toBe(id);
    });
  });

  describe("syncRefs", () => {
    test("populates knowledge_refs for UUID refs", () => {
      const targetId = ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Target Entry",
        content: "This is the target",
        scope: "project",
      });

      const sourceId = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Source Entry",
        content: `References [[${targetId}]] for details.`,
        scope: "project",
      });

      const synced = ltm.syncRefs(sourceId);
      expect(synced).toBe(1);

      // Check join table
      const refs = db()
        .query(
          "SELECT * FROM knowledge_refs WHERE from_id = ? AND to_id = ?",
        )
        .all(sourceId, targetId);
      expect(refs.length).toBe(1);
    });

    test("clears old refs on re-sync", () => {
      const target1 = ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Target One",
        content: "First target",
        scope: "project",
      });

      const source = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Source",
        content: `Links to [[${target1}]]`,
        scope: "project",
      });

      ltm.syncRefs(source);

      // Update content to remove the ref
      ltm.update(source, { content: "No more links" });
      const synced = ltm.syncRefs(source);
      expect(synced).toBe(0);

      const refs = db()
        .query("SELECT * FROM knowledge_refs WHERE from_id = ?")
        .all(source);
      expect(refs.length).toBe(0);
    });
  });

  describe("cascadeRefReplace", () => {
    test("rewrites refs in content when ID changes", () => {
      const oldId = "019c904b-0000-0000-0000-000000000001";
      const newId = "019c904b-0000-0000-0000-000000000002";

      // Create an entry referencing oldId
      const sourceId = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Referencing Entry",
        content: `Uses [[${oldId}]] for something.`,
        scope: "project",
      });

      const changed = ltm.cascadeRefReplace(oldId, newId);
      expect(changed).toBeGreaterThanOrEqual(1);

      // Verify content was updated
      const entry = ltm.get(sourceId);
      expect(entry!.content).toContain(`[[${newId}]]`);
      expect(entry!.content).not.toContain(`[[${oldId}]]`);
    });
  });

  describe("cleanDeadRefs", () => {
    test("removes refs to deleted entries from content", () => {
      const targetId = ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Will Be Deleted",
        content: "Temporary entry",
        scope: "project",
      });

      const sourceId = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "References Dead Entry",
        content: `Links to [[${targetId}]] for info.`,
        scope: "project",
      });

      ltm.syncRefs(sourceId);

      // Verify ref exists
      const refsBefore = db()
        .query("SELECT * FROM knowledge_refs WHERE from_id = ?")
        .all(sourceId);
      expect(refsBefore.length).toBe(1);

      // Delete the target WITHOUT foreign key cascade — simulate a direct
      // DB deletion that bypasses FK checks (e.g. from bulk SQL operations).
      // We temporarily disable FKs to leave the orphan ref row intact.
      db().exec("PRAGMA foreign_keys = OFF");
      db().query("DELETE FROM knowledge WHERE id = ?").run(targetId);
      db().exec("PRAGMA foreign_keys = ON");

      // Verify the orphan ref still exists
      const orphanRefs = db()
        .query("SELECT * FROM knowledge_refs WHERE from_id = ?")
        .all(sourceId);
      expect(orphanRefs.length).toBe(1);

      // Clean dead refs
      const cleaned = ltm.cleanDeadRefs();
      expect(cleaned).toBe(1);

      // Verify content was cleaned
      const entry = ltm.get(sourceId);
      expect(entry!.content).not.toContain(`[[${targetId}]]`);
      expect(entry!.content).toContain("Links to  for info.");

      // Verify join table was cleaned
      const refsAfter = db()
        .query("SELECT * FROM knowledge_refs WHERE from_id = ?")
        .all(sourceId);
      expect(refsAfter.length).toBe(0);
    });

    test("returns 0 when no dead refs exist", () => {
      const cleaned = ltm.cleanDeadRefs();
      expect(cleaned).toBe(0);
    });
  });
});
