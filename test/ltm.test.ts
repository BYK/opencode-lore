import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db, close, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/ltm/project";

beforeAll(() => {
  // Clean up any leftover test data from previous runs
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  db().query("DELETE FROM knowledge WHERE project_id IS NULL").run();
});
afterAll(() => close());

describe("ltm", () => {
  test("create and retrieve knowledge entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "Using OAuth2 with PKCE flow for all authentication",
      session: "sess-1",
      scope: "project",
    });
    expect(id).toBeTruthy();

    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Auth strategy");
    expect(entry!.category).toBe("decision");
    expect(entry!.confidence).toBe(1.0);
  });

  test("create global knowledge entry", () => {
    const id = ltm.create({
      category: "preference",
      title: "Code style",
      content: "User prefers no backwards-compat shims, fix callers directly",
      scope: "global",
      crossProject: true,
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.project_id).toBeNull();
    expect(entry!.cross_project).toBe(1);
  });

  test("update knowledge entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "architecture",
      title: "Middleware pattern",
      content: "Using express middleware for all routes",
      scope: "project",
    });
    ltm.update(id, {
      content: "Using Hono middleware for all routes",
      confidence: 0.9,
    });

    const entry = ltm.get(id);
    expect(entry!.content).toContain("Hono");
    expect(entry!.confidence).toBe(0.9);
  });

  test("remove knowledge entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Temporary workaround",
      content: "This is temporary",
      scope: "project",
    });
    ltm.remove(id);
    expect(ltm.get(id)).toBeNull();
  });

  test("forProject includes project, global, and cross-project entries", () => {
    const entries = ltm.forProject(PROJECT, true);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const categories = entries.map((e) => e.category);
    expect(categories).toContain("decision");
    expect(categories).toContain("preference"); // global cross-project entry
  });

  test("full-text search works", () => {
    const results = ltm.search({ query: "OAuth", projectPath: PROJECT });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("OAuth2");
  });

  test("low confidence entries are filtered out", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Low confidence item",
      content: "This should be hidden",
      scope: "project",
    });
    ltm.update(id, { confidence: 0.1 });

    const entries = ltm.forProject(PROJECT);
    const found = entries.find((e) => e.id === id);
    expect(found).toBeUndefined();
  });
});
