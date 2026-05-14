import { describe, test, expect } from "bun:test";
import { ensureProject } from "../../src/db";
import {
  isImported,
  recordImport,
  listImports,
  computeHash,
} from "../../src/import/history";

const PROJECT_PATH = "/test/import-history-project";

describe("import history", () => {
  // ensureProject is needed because import_history references projects(id)
  test("setup: create test project", () => {
    ensureProject(PROJECT_PATH);
  });

  describe("isImported", () => {
    test("returns null for unknown source", () => {
      const result = isImported(PROJECT_PATH, "test-agent", "unknown-source", "hash1");
      expect(result).toBeNull();
    });

    test("returns record when hash matches", () => {
      recordImport(PROJECT_PATH, "test-agent", "source-1", "hash-abc", {
        created: 3,
        updated: 1,
      });

      const result = isImported(PROJECT_PATH, "test-agent", "source-1", "hash-abc");
      expect(result).not.toBeNull();
      expect(result!.agent_name).toBe("test-agent");
      expect(result!.source_id).toBe("source-1");
      expect(result!.entries_created).toBe(3);
      expect(result!.entries_updated).toBe(1);
    });

    test("returns null when hash differs (source changed)", () => {
      // source-1 was recorded with hash-abc above
      const result = isImported(PROJECT_PATH, "test-agent", "source-1", "hash-xyz");
      expect(result).toBeNull();
    });
  });

  describe("recordImport", () => {
    test("upserts on re-import (different hash)", () => {
      recordImport(PROJECT_PATH, "agent-x", "src-1", "v1", { created: 2, updated: 0 });
      const r1 = isImported(PROJECT_PATH, "agent-x", "src-1", "v1");
      expect(r1).not.toBeNull();

      // Re-import with different hash (source grew)
      recordImport(PROJECT_PATH, "agent-x", "src-1", "v2", { created: 1, updated: 1 });
      const r2 = isImported(PROJECT_PATH, "agent-x", "src-1", "v2");
      expect(r2).not.toBeNull();
      expect(r2!.entries_created).toBe(1);

      // Old hash no longer matches
      expect(isImported(PROJECT_PATH, "agent-x", "src-1", "v1")).toBeNull();
    });
  });

  describe("listImports", () => {
    test("lists import records excluding declined entries", () => {
      const LIST_PROJECT = "/test/list-project";
      ensureProject(LIST_PROJECT);

      recordImport(LIST_PROJECT, "agent-a", "src-a", "h1", { created: 5, updated: 0 });
      recordImport(LIST_PROJECT, "agent-b", "src-b", "h2", { created: 2, updated: 1 });

      const imports = listImports(LIST_PROJECT);
      expect(imports.length).toBe(2);
    });
  });

  describe("computeHash", () => {
    test("produces consistent hashes", () => {
      const h1 = computeHash({ size: 100, messageCount: 10, lastTimestamp: 1234 });
      const h2 = computeHash({ size: 100, messageCount: 10, lastTimestamp: 1234 });
      expect(h1).toBe(h2);
    });

    test("produces different hashes for different inputs", () => {
      const h1 = computeHash({ size: 100, messageCount: 10, lastTimestamp: 1234 });
      const h2 = computeHash({ size: 100, messageCount: 11, lastTimestamp: 1234 });
      expect(h1).not.toBe(h2);
    });

    test("handles missing fields", () => {
      const h = computeHash({});
      expect(h).toBe("0:0:0");
    });
  });
});
