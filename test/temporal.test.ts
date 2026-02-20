import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
