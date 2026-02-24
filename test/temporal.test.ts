import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db, close, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import { ftsQuery } from "../src/temporal";
import type { Message, Part } from "@opencode-ai/sdk";

const PROJECT = "/test/temporal/project";

function makeMessage(
  id: string,
  role: "user" | "assistant",
  sessionID = "sess-1",
): Message {
  if (role === "user") {
    return {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    };
  }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function makeParts(messageID: string, text: string): Part[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID: "sess-1",
      messageID,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    },
  ];
}

beforeAll(() => {
  // Clean up any leftover test data from previous runs
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
});
afterAll(() => close());

describe("temporal", () => {
  test("store and retrieve messages", () => {
    const info = makeMessage("msg-1", "user");
    const parts = makeParts("msg-1", "How do I set up authentication?");
    temporal.store({ projectPath: PROJECT, info, parts });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(1);
    expect(all[0].content).toContain("authentication");
  });

  test("stores multiple messages", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-2", "assistant"),
      parts: makeParts(
        "msg-2",
        "Authentication uses OAuth2 with PKCE flow in src/auth/config.ts",
      ),
    });
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-3", "user"),
      parts: makeParts("msg-3", "What about the redirect middleware?"),
    });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(3);
  });

  test("updates existing message on re-store", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-1", "user"),
      parts: makeParts(
        "msg-1",
        "Updated: How do I set up OAuth authentication?",
      ),
    });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(3); // still 3, not 4
    expect(all[0].content).toContain("OAuth");
  });

  test("full-text search works", () => {
    const results = temporal.search({ projectPath: PROJECT, query: "OAuth" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("OAuth");
  });

  test("search respects session scope", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-other", "user", "sess-2"),
      parts: makeParts(
        "msg-other",
        "Totally different session about databases",
      ),
    });

    const scoped = temporal.search({
      projectPath: PROJECT,
      query: "databases",
      sessionID: "sess-1",
    });
    expect(scoped.length).toBe(0);

    const global = temporal.search({
      projectPath: PROJECT,
      query: "databases",
    });
    expect(global.length).toBeGreaterThan(0);
  });

  test("undistilled returns only non-distilled messages", () => {
    const pending = temporal.undistilled(PROJECT, "sess-1");
    expect(pending.length).toBe(3);

    temporal.markDistilled(["msg-1", "msg-2"]);

    const after = temporal.undistilled(PROJECT, "sess-1");
    expect(after.length).toBe(1);
    expect(after[0].id).toBe("msg-3");
  });

  test("count and undistilledCount", () => {
    expect(temporal.count(PROJECT, "sess-1")).toBe(3);
    expect(temporal.undistilledCount(PROJECT, "sess-1")).toBe(1);
  });

  test("skips empty content messages", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-empty", "user"),
      parts: [],
    });
    // Should not increase count since content is empty
    expect(temporal.count(PROJECT, "sess-1")).toBe(3);
  });

  describe("prune", () => {
    const PRUNE_PROJECT = "/test/temporal/prune";
    const DAY_MS = 24 * 60 * 60 * 1000;

    function insertMessage(
      id: string,
      sessionID: string,
      distilled: 0 | 1,
      createdAt: number,
      contentSize = 100,
    ) {
      const pid = ensureProject(PRUNE_PROJECT);
      const content = "x".repeat(contentSize);
      db()
        .query(
          `INSERT OR REPLACE INTO temporal_messages
           (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?, '{}')`,
        )
        .run(id, pid, sessionID, content, Math.ceil(contentSize / 4), distilled, createdAt);
    }

    // Clean the prune project before every test so accumulated rows from
    // prior test runs (live DB, no isolation) don't interfere with counts.
    beforeEach(() => {
      const pid = ensureProject(PRUNE_PROJECT);
      db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    });

    test("TTL pass deletes distilled messages older than retention window", () => {
      const now = Date.now();
      insertMessage("old-distilled", "sess-p1", 1, now - 130 * DAY_MS); // 130 days old — should be pruned
      insertMessage("new-distilled", "sess-p1", 1, now - 10 * DAY_MS);  // 10 days old — kept
      insertMessage("old-undistilled", "sess-p1", 0, now - 130 * DAY_MS); // old but undistilled — never deleted

      const result = temporal.prune({ projectPath: PRUNE_PROJECT, retentionDays: 120, maxStorageMB: 1024 });

      expect(result.ttlDeleted).toBe(1);
      expect(result.capDeleted).toBe(0);

      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      const ids = remaining.map((r) => r.id);
      expect(ids).not.toContain("old-distilled");
      expect(ids).toContain("new-distilled");
      expect(ids).toContain("old-undistilled");
    });

    test("size cap pass deletes oldest distilled messages when over limit", () => {
      const now = Date.now();
      // 3 distilled messages each ~400 KB — total ~1.2 MB, cap at 1 MB
      const size = 400 * 1024;
      insertMessage("cap-old", "sess-p2", 1, now - 5 * DAY_MS, size);
      insertMessage("cap-mid", "sess-p2", 1, now - 3 * DAY_MS, size);
      insertMessage("cap-new", "sess-p2", 1, now - 1 * DAY_MS, size);
      // Undistilled — must never be evicted even when over cap
      insertMessage("cap-undistilled", "sess-p2", 0, now - 5 * DAY_MS, size);

      const result = temporal.prune({ projectPath: PRUNE_PROJECT, retentionDays: 120, maxStorageMB: 1 });

      expect(result.ttlDeleted).toBe(0); // all within 120 days
      expect(result.capDeleted).toBeGreaterThan(0);

      // The undistilled message must survive no matter what
      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain("cap-undistilled");

      // The oldest distilled should be the first evicted
      expect(ids).not.toContain("cap-old");
    });

    test("undistilled messages are never deleted by either pass", () => {
      const now = Date.now();
      // Very old undistilled — TTL pass must not touch it
      insertMessage("undist-ancient", "sess-p3", 0, now - 365 * DAY_MS);
      // Over-cap scenario — size cap pass must not touch undistilled
      insertMessage("undist-large", "sess-p3", 0, now - 1 * DAY_MS, 2 * 1024 * 1024);

      const result = temporal.prune({ projectPath: PRUNE_PROJECT, retentionDays: 1, maxStorageMB: 1 });

      expect(result.ttlDeleted).toBe(0);
      expect(result.capDeleted).toBe(0);

      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      expect(remaining.map((r) => r.id)).toContain("undist-ancient");
      expect(remaining.map((r) => r.id)).toContain("undist-large");
    });

    test("no-op when under both thresholds", () => {
      const now = Date.now();
      insertMessage("recent-dist", "sess-p4", 1, now - 1 * DAY_MS);
      insertMessage("recent-undist", "sess-p4", 0, now - 1 * DAY_MS);

      const result = temporal.prune({ projectPath: PRUNE_PROJECT, retentionDays: 120, maxStorageMB: 1024 });

      expect(result.ttlDeleted).toBe(0);
      expect(result.capDeleted).toBe(0);
    });

    test("both passes can fire in same run", () => {
      const now = Date.now();
      // Old message caught by TTL
      insertMessage("both-old", "sess-p5", 1, now - 130 * DAY_MS, 100);
      // Recent but large messages that push over the cap (after TTL runs)
      const size = 600 * 1024;
      insertMessage("both-mid", "sess-p5", 1, now - 5 * DAY_MS, size);
      insertMessage("both-new", "sess-p5", 1, now - 1 * DAY_MS, size);

      const result = temporal.prune({ projectPath: PRUNE_PROJECT, retentionDays: 120, maxStorageMB: 1 });

      expect(result.ttlDeleted).toBe(1); // both-old caught by TTL
      expect(result.capDeleted).toBeGreaterThan(0); // at least one of the large ones evicted
    });
  });

  describe("ftsQuery sanitization", () => {
    test("plain words get prefix wildcard", () => {
      expect(ftsQuery("OAuth PKCE flow")).toBe("OAuth* PKCE* flow*");
    });

    test("hyphenated terms: dash stripped, not treated as NOT operator", () => {
      // "opencode-nuum" would crash FTS5 as "opencode NOT nuum"
      expect(ftsQuery("opencode-nuum")).toBe("opencode* nuum*");
      expect(ftsQuery("three-tier")).toBe("three* tier*");
    });

    test("dot in domain name: dot stripped, not treated as column filter", () => {
      // "sanity.io" would crash FTS5 as column-filter syntax
      expect(ftsQuery("sanity.io")).toBe("sanity* io*");
    });

    test("other punctuation stripped", () => {
      expect(ftsQuery("what's the fix?")).toBe("what* s* the* fix*");
    });

    test("empty string returns sentinel", () => {
      expect(ftsQuery("")).toBe('""');
    });

    test("search does not throw on hyphenated query", () => {
      // These previously crashed with SQLiteError
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "opencode-nuum" }),
      ).not.toThrow();
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "three-tier" }),
      ).not.toThrow();
    });

    test("search does not throw on domain name query", () => {
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "sanity.io article" }),
      ).not.toThrow();
    });
  });
});
