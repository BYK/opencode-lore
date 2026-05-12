import { describe, test, expect } from "bun:test";
import { ensureProject } from "../../src/db";
import * as ltm from "../../src/ltm";
import { parseOps, applyOps, type CuratorOp } from "../../src/curator";

const PROJECT_PATH = "/test/curator-ops-project";

describe("parseOps", () => {
  test("parses valid JSON array", () => {
    const ops = parseOps(
      JSON.stringify([
        { op: "create", category: "gotcha", title: "Test", content: "Body", scope: "project" },
      ]),
    );
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe("create");
  });

  test("strips markdown fences", () => {
    const ops = parseOps(
      '```json\n[{"op": "create", "category": "pattern", "title": "T", "content": "C", "scope": "global"}]\n```',
    );
    expect(ops.length).toBe(1);
  });

  test("returns empty for non-array JSON", () => {
    expect(parseOps('{"op": "create"}')).toEqual([]);
  });

  test("returns empty for invalid JSON", () => {
    expect(parseOps("not json at all")).toEqual([]);
  });

  test("filters out items without op field", () => {
    const ops = parseOps(
      JSON.stringify([
        { op: "create", category: "gotcha", title: "T", content: "C", scope: "project" },
        { notAnOp: true },
        { op: "delete", id: "abc", reason: "outdated" },
      ]),
    );
    expect(ops.length).toBe(2);
  });
});

describe("applyOps", () => {
  test("setup: create test project", () => {
    ensureProject(PROJECT_PATH);
  });

  test("creates knowledge entries", () => {
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "decision",
        title: "Use WAL mode",
        content: "SQLite should use WAL mode for concurrent access.",
        scope: "project",
        crossProject: true,
      },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.created).toBe(1);

    const entries = ltm.forProject(PROJECT_PATH, false);
    expect(entries.some((e) => e.title === "Use WAL mode")).toBe(true);
  });

  test("updates existing entries", () => {
    // First create
    const id = ltm.create({
      projectPath: PROJECT_PATH,
      category: "pattern",
      title: "Retry pattern",
      content: "Old content",
      scope: "project",
    });

    const ops: CuratorOp[] = [
      { op: "update", id, content: "New improved content" },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.updated).toBe(1);

    const entry = ltm.get(id);
    expect(entry!.content).toBe("New improved content");
  });

  test("deletes entries", () => {
    const id = ltm.create({
      projectPath: PROJECT_PATH,
      category: "gotcha",
      title: "Obsolete entry",
      content: "No longer relevant",
      scope: "project",
    });

    const ops: CuratorOp[] = [
      { op: "delete", id, reason: "No longer relevant" },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.deleted).toBe(1);
    expect(ltm.get(id)).toBeNull();
  });

  test("truncates oversized content", () => {
    const longContent = "x".repeat(2000);
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "architecture",
        title: "Long entry",
        content: longContent,
        scope: "project",
      },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.created).toBe(1);

    const entries = ltm.forProject(PROJECT_PATH, false);
    const found = entries.find((e) => e.title === "Long entry");
    expect(found).toBeDefined();
    expect(found!.content.length).toBeLessThan(longContent.length);
    expect(found!.content).toContain("[truncated");
  });

  test("skipCreate prevents create ops", () => {
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "pattern",
        title: "Should not exist",
        content: "This should be skipped",
        scope: "project",
      },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH, skipCreate: true });
    expect(result.created).toBe(0);

    const entries = ltm.forProject(PROJECT_PATH, false);
    expect(entries.some((e) => e.title === "Should not exist")).toBe(false);
  });

  test("ignores update for nonexistent entry", () => {
    const ops: CuratorOp[] = [
      { op: "update", id: "nonexistent-id", content: "Whatever" },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.updated).toBe(0);
  });

  test("ignores delete for nonexistent entry", () => {
    const ops: CuratorOp[] = [
      { op: "delete", id: "nonexistent-id", reason: "Doesn't exist anyway" },
    ];

    const result = applyOps(ops, { projectPath: PROJECT_PATH });
    expect(result.deleted).toBe(0);
  });
});
