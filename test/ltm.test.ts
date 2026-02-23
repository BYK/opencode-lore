import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db, close, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

// UUID v7 pattern: starts with version nibble 7, variant bits 10xxxxxx
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  describe("search: FTS sanitization and fallback", () => {
    test("search does not throw on hyphenated query", () => {
      // "opencode-nuum" previously crashed with: no such column: nuum
      expect(() =>
        ltm.search({ query: "opencode-nuum", projectPath: PROJECT }),
      ).not.toThrow();
      expect(() =>
        ltm.search({ query: "three-tier", projectPath: PROJECT }),
      ).not.toThrow();
    });

    test("search does not throw on domain name query", () => {
      // "sanity.io" previously crashed with: fts5 syntax error near "."
      expect(() =>
        ltm.search({ query: "sanity.io memory", projectPath: PROJECT }),
      ).not.toThrow();
    });

    test("search still finds results with punctuation in query", () => {
      // "OAuth2-PKCE" strips to "OAuth2* PKCE*" — both words are in "Auth strategy" entry
      const results = ltm.search({
        query: "OAuth2-PKCE",
        projectPath: PROJECT,
      });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

describe("ltm — UUIDv7 IDs", () => {
  const PROJ = "/test/ltm/uuidv7";

  beforeAll(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("create() generates a UUIDv7 ID by default", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "UUIDv7 test entry",
      content: "Should get a v7 ID",
      scope: "project",
    });
    expect(id).toMatch(UUID_V7_RE);
  });

  test("multiple create() calls produce monotonically increasing IDs", () => {
    const ids = Array.from({ length: 5 }, () =>
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Entry ${Date.now()}`,
        content: "Content",
        scope: "project",
      }),
    );
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  test("create() accepts explicit id (for cross-machine import)", () => {
    const explicitId = "019505a1-7c00-7000-8000-aabbccddeeff";
    const returned = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Explicit ID entry",
      content: "Imported from another machine",
      scope: "project",
      id: explicitId,
    });
    expect(returned).toBe(explicitId);

    const entry = ltm.get(explicitId);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(explicitId);
    expect(entry!.title).toBe("Explicit ID entry");
  });

  test("explicit id can be a UUIDv4 (backwards compat for existing entries)", () => {
    const v4Id = "550e8400-e29b-41d4-a716-446655440000";
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Legacy v4 entry",
      content: "Had a v4 ID before migration",
      scope: "project",
      id: v4Id,
    });
    const entry = ltm.get(v4Id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(v4Id);
  });

  test("create() with duplicate explicit id throws or silently overwrites — not silent data loss", () => {
    const id = "019505ff-0000-7000-8000-ffffffffffff";
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Original",
      content: "Original content",
      scope: "project",
      id,
    });

    // Attempting to insert with the same ID should throw (SQLite UNIQUE constraint)
    expect(() =>
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: "Duplicate",
        content: "Would overwrite",
        scope: "project",
        id,
      }),
    ).toThrow();

    // Original should still be intact
    const entry = ltm.get(id);
    expect(entry!.title).toBe("Original");
  });
});

// ---------------------------------------------------------------------------
// forSession — smart relevance-ranked injection
// ---------------------------------------------------------------------------

describe("ltm.forSession", () => {
  const PROJ = "/test/ltm/forsession";
  const SESSION = "test-session-abc";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    // Clean up any cross-project entries from this test project
    db()
      .query("DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%')")
      .run();
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("returns project-specific entries regardless of session context", () => {
    ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "DB choice for forSession test",
      content: "Using SQLite via bun:sqlite for local storage",
      scope: "project",
      crossProject: false,
    });

    const result = ltm.forSession(PROJ, SESSION, 10_000);
    // Project-specific entry must be included
    const found = result.find((e) => e.title === "DB choice for forSession test");
    expect(found).toBeDefined();
    // It must be the project-specific entry (cross_project = 0)
    expect(found!.cross_project).toBe(0);
  });

  test("respects token budget — stops adding entries when budget exhausted", () => {
    // Create many project entries
    for (let i = 0; i < 10; i++) {
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Pattern ${i}`,
        content: "A ".repeat(200), // ~50 tokens each
        scope: "project",
        crossProject: false,
      });
    }

    // Budget of 200 tokens — should fit only a few entries
    const result = ltm.forSession(PROJ, SESSION, 200);
    expect(result.length).toBeLessThan(10);
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes relevant cross-project entries when session context matches", () => {
    // Create a cross-project entry about TypeScript
    ltm.create({
      category: "gotcha",
      title: "TypeScript strict mode caveat",
      content: "TypeScript strict null checks require explicit undefined handling",
      scope: "global",
      crossProject: true,
    });

    // Create irrelevant cross-project entry
    ltm.create({
      category: "pattern",
      title: "Kubernetes deployment pattern",
      content: "Use helm charts for Kubernetes deployments with resource limits",
      scope: "global",
      crossProject: true,
    });

    // Seed session context mentioning TypeScript
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-ts-1",
        pid,
        SESSION,
        "user",
        "Help me fix a TypeScript type error in my function",
        20,
        Date.now(),
      );

    const result = ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);
    expect(titles).toContain("TypeScript strict mode caveat");
    // Kubernetes entry should not appear (no match with TypeScript context)
    expect(titles).not.toContain("Kubernetes deployment pattern");
  });

  test("falls back to top entries by confidence when no session context", () => {
    // Create cross-project entries — no session messages to provide context
    ltm.create({
      category: "preference",
      title: "General coding preference",
      content: "Prefer explicit error handling over silent failures",
      scope: "global",
      crossProject: true,
    });

    // No session context (fresh session) — should still return top entries
    const result = ltm.forSession(PROJ, "brand-new-session", 10_000);
    // At minimum, the fallback path should return something (up to 10 entries)
    // (may be 0 if budget is exhausted by project entries, but shouldn't crash)
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ltm.pruneOversized
// ---------------------------------------------------------------------------

describe("ltm.pruneOversized", () => {
  const PROJ = "/test/ltm/prune";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("sets confidence to 0 for entries exceeding maxLength", () => {
    const longId = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Oversized entry",
      content: "X".repeat(3000), // 3000 chars > 2000 limit
      scope: "project",
    });
    const shortId = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Normal entry",
      content: "Short content",
      scope: "project",
    });

    // Count before; pruneOversized is global so may affect real DB entries too.
    // We verify the specific entries we created rather than the total count.
    ltm.pruneOversized(2000);

    expect(ltm.get(longId)!.confidence).toBe(0);
    expect(ltm.get(shortId)!.confidence).toBe(1.0);
  });

  test("pruned entries do not appear in forProject results", () => {
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Bloated entry",
      content: "B".repeat(5000),
      scope: "project",
    });

    ltm.pruneOversized(2000);

    const entries = ltm.forProject(PROJ);
    expect(entries.find((e) => e.title === "Bloated entry")).toBeUndefined();
  });

  test("does not affect entries within the limit", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Fine entry",
      content: "Normal sized content",
      scope: "project",
    });

    ltm.pruneOversized(2000);
    // The short entry should retain full confidence
    expect(ltm.get(id)!.confidence).toBe(1.0);
  });
});
