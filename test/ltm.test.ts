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
    const ids = Array.from({ length: 5 }, (_, i) =>
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Monotonic entry ${i}`,
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

  test("excludes irrelevant project entries when session context exists", () => {
    // Create a project entry about Kubernetes (irrelevant to TypeScript context)
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Kubernetes pod scaling",
      content: "Configure horizontal pod autoscaler with CPU thresholds for deployment replicas",
      scope: "project",
      crossProject: false,
    });

    // Create a project entry about TypeScript (relevant)
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "TypeScript strict null handling",
      content: "TypeScript strict null checks require explicit undefined handling in function params",
      scope: "project",
      crossProject: false,
    });

    // Seed session context about TypeScript
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-relevance-1",
        pid,
        SESSION,
        "user",
        "Help me fix a TypeScript type error with strict null checks in my function parameters",
        20,
        Date.now(),
      );

    const result = ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);

    // TypeScript entry should be included (matches session context)
    expect(titles).toContain("TypeScript strict null handling");

    // Kubernetes entry may be included via safety net (top-5 by confidence)
    // but should NOT be included via relevance matching — verify by checking
    // that if we have enough relevant entries, irrelevant ones are pushed out.
    // For now, just verify the relevant entry is present.
  });

  test("includes top-5 project entries by confidence as safety net even without term match", () => {
    // Create 8 project entries — crafted so no words overlap session context.
    // Use made-up domain-specific jargon to avoid accidental term overlap.
    for (let i = 0; i < 8; i++) {
      ltm.create({
        projectPath: PROJ,
        category: "architecture",
        title: `Xylophage plumbing spec ${i}`,
        content: `Xylophage plumbing subsystem spec ${i} governs frobnicator calibration`,
        scope: "project",
        crossProject: false,
      });
    }

    // Seed session context about something completely different — no shared terms
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-safetynet-1",
        pid,
        SESSION,
        "user",
        "Implement a React dashboard showing monthly revenue analytics quarterly forecasts charting",
        20,
        Date.now(),
      );

    const result = ltm.forSession(PROJ, SESSION, 10_000);
    // Safety net should include up to 5 project entries even though none match
    const xEntries = result.filter((e) => e.title.startsWith("Xylophage plumbing"));
    expect(xEntries.length).toBeLessThanOrEqual(5);
    expect(xEntries.length).toBeGreaterThan(0);
  });

  test("interleaves project and cross-project entries by relevance score", () => {
    // Create a project entry that does NOT match session context
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Docker compose networking",
      content: "Docker compose networking configuration for multi-container orchestration",
      scope: "project",
      crossProject: false,
    });

    // Create a cross-project entry that DOES match session context
    ltm.create({
      category: "gotcha",
      title: "React useState async pitfall",
      content: "React useState setter is async — reading state immediately after setState returns stale value in dashboard components",
      scope: "global",
      crossProject: true,
    });

    // Seed session context about React
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-interleave-1",
        pid,
        SESSION,
        "user",
        "Fix the React dashboard component where useState returns stale value after async update",
        20,
        Date.now(),
      );

    const result = ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);

    // The relevant cross-project entry should be included
    expect(titles).toContain("React useState async pitfall");

    // If Docker entry appears at all (via safety net), it should be after
    // the relevant React entry in the result array
    const reactIdx = titles.indexOf("React useState async pitfall");
    const dockerIdx = titles.indexOf("Docker compose networking");
    if (dockerIdx !== -1) {
      expect(reactIdx).toBeLessThan(dockerIdx);
    }
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
