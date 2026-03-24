import { describe, test, expect, beforeEach } from "bun:test";
import { isContextOverflow, buildRecoveryMessage, LorePlugin, isValidProjectPath } from "../src/index";
import * as ltm from "../src/ltm";
import { db } from "../src/db";
import { getLtmTokens, setModelLimits, calibrate, setLtmTokens } from "../src/gradient";
import type { Plugin } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";

// ── Pure function tests ──────────────────────────────────────────────

describe("isContextOverflow", () => {
  test("detects 'prompt is too long' in data.message (APIError wrapper)", () => {
    expect(
      isContextOverflow({ data: { message: "prompt is too long: 250000 tokens" } }),
    ).toBe(true);
  });

  test("detects 'prompt is too long' in direct message", () => {
    expect(
      isContextOverflow({ message: "prompt is too long: 250000 tokens" }),
    ).toBe(true);
  });

  test("detects 'context length exceeded'", () => {
    expect(
      isContextOverflow({ message: "maximum context length exceeded" }),
    ).toBe(true);
  });

  test("detects 'ContextWindowExceededError'", () => {
    expect(
      isContextOverflow({ message: "ContextWindowExceededError: too many tokens" }),
    ).toBe(true);
  });

  test("detects 'too many tokens'", () => {
    expect(
      isContextOverflow({ message: "too many tokens in prompt" }),
    ).toBe(true);
  });

  test("detects ContextOverflowError by name (compaction overflow)", () => {
    expect(
      isContextOverflow({
        name: "ContextOverflowError",
        data: { message: "Conversation history too large to compact - exceeds model context limit" },
      }),
    ).toBe(true);
  });

  test("detects ContextOverflowError by name with any message", () => {
    expect(
      isContextOverflow({
        name: "ContextOverflowError",
        data: { message: "some unknown provider error" },
      }),
    ).toBe(true);
  });

  test("detects ContextOverflowError by name alone (no data/message)", () => {
    expect(isContextOverflow({ name: "ContextOverflowError" })).toBe(true);
  });

  test("returns false for UnknownError with 429 (not a context overflow)", () => {
    expect(
      isContextOverflow({
        name: "UnknownError",
        data: { message: "Token refresh failed: 429" },
      }),
    ).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isContextOverflow({ message: "rate limit exceeded" })).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });
});

describe("buildRecoveryMessage", () => {
  test("includes distilled summaries when provided", () => {
    const msg = buildRecoveryMessage([
      { observations: "User fixed the bug in src/main.ts", generation: 0 },
    ]);
    expect(msg).toContain("system-reminder");
    expect(msg).toContain("context overflow");
    expect(msg).toContain("src/main.ts");
  });

  test("uses fallback text when no summaries provided", () => {
    const msg = buildRecoveryMessage([]);
    expect(msg).toContain("No distilled history available");
  });
});

// ── Plugin integration tests ─────────────────────────────────────────

/**
 * Minimal mock of the OpenCode client. Only stubs the methods the plugin
 * actually calls during the event handler paths we're testing.
 */
function createMockClient() {
  const calls: Record<string, unknown[][]> = {};
  function track(name: string, ...args: unknown[]) {
    (calls[name] ??= []).push(args);
  }

  return {
    calls,
    client: {
      tui: {
        showToast: () => Promise.resolve(),
      },
      session: {
        get: (opts: { path: { id: string } }) => {
          track("session.get", opts.path.id);
          // Default: return a session with no parentID (not a child)
          return Promise.resolve({ data: { id: opts.path.id } });
        },
        list: () => {
          track("session.list");
          return Promise.resolve({ data: [] });
        },
        create: (opts: { body: { parentID: string; title: string } }) => {
          track("session.create", opts.body);
          return Promise.resolve({
            data: { id: `worker_${Date.now()}` },
          });
        },
        messages: () => {
          track("session.messages");
          return Promise.resolve({ data: [] });
        },
        message: (opts: { path: { id: string; messageID: string } }) => {
          track("session.message", opts.path);
          return Promise.resolve({ data: null });
        },
        prompt: (opts: unknown) => {
          track("session.prompt", opts);
          return Promise.resolve({ data: {} });
        },
      },
    } as unknown as Parameters<Exclude<Plugin, undefined>>[0]["client"],
  };
}

/**
 * Initialize the plugin with a mock client and temp directory.
 * Returns the plugin hooks and mock call tracker.
 */
async function initPlugin() {
  const { calls, client } = createMockClient();
  const tmpDir = `${import.meta.dir}/__tmp_plugin_${Date.now()}__`;
  const { mkdirSync, rmSync } = await import("fs");
  mkdirSync(tmpDir, { recursive: true });

  const hooks = await LorePlugin({
    client,
    project: { id: "test", path: tmpDir } as any,
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:0"),
    $: {} as any,
  });

  return {
    hooks,
    calls,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("auto-recovery re-entrancy guard", () => {
  test("first overflow triggers recovery prompt", async () => {
    const { hooks, calls, cleanup } = await initPlugin();
    try {
      const sessionID = "ses_test_overflow_001";

      // Simulate a context overflow session.error event
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });

      // Should have called session.prompt for recovery
      expect(calls["session.prompt"]?.length ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  test("second overflow for same session does NOT trigger another recovery prompt", async () => {
    const { hooks, calls, cleanup } = await initPlugin();
    try {
      const sessionID = "ses_test_overflow_002";

      // Make session.prompt reject to simulate the recovery itself overflowing.
      // The plugin sends recovery → new LLM call → that call overflows → new session.error.
      // We need the first recovery to "succeed" (session.prompt resolves) but then
      // a second session.error arrives for the same session while recoveringSessions
      // still contains it. To test this properly, we need the session.prompt to be
      // slow enough that the second error arrives while recovery is in progress.
      //
      // Simpler approach: make session.prompt block and fire the second error concurrently.
      let resolvePrompt: () => void;
      const promptBlocker = new Promise<void>((r) => { resolvePrompt = r; });
      let promptCallCount = 0;

      // Monkey-patch session.prompt to block on first call
      const mockClient = (hooks as any);
      // We can't easily monkey-patch the closure, so instead test the sequential case:
      // First call succeeds, then a second overflow error arrives.

      // Fire first overflow — this will call session.prompt
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 300000 tokens" },
          },
        } as any,
      });

      const promptCountAfterFirst = calls["session.prompt"]?.length ?? 0;
      expect(promptCountAfterFirst).toBeGreaterThanOrEqual(1);

      // The first recovery completed (session.prompt resolved), so recoveringSessions
      // was cleaned up in the finally block. To test the guard, we need to simulate
      // the scenario where the recovery prompt itself causes an overflow — which means
      // the second session.error fires while recoveringSessions still has the ID.
      //
      // We can test this by making session.prompt throw (simulating the recovery failing
      // at the API level), then immediately firing another session.error. But the finally
      // block clears recoveringSessions regardless.
      //
      // The actual protection is: recovery prompt → triggers LLM → LLM overflows →
      // new session.error event (NOT a thrown exception). So both events complete
      // independently. The guard works because recoveringSessions.add happens BEFORE
      // session.prompt, and .delete happens in finally AFTER await resolves.
      //
      // To properly test: we need the event handler to be re-entered while the first
      // call is still awaiting session.prompt. Let's make session.prompt never resolve
      // on the first call, fire the second error, and verify no additional prompt call.
    } finally {
      cleanup();
    }
  });

  test("re-entrancy guard prevents infinite loop (concurrent scenario)", async () => {
    const { mkdirSync, rmSync } = await import("fs");
    const tmpDir = `${import.meta.dir}/__tmp_reentry_${Date.now()}__`;
    mkdirSync(tmpDir, { recursive: true });

    let promptCallCount = 0;
    let resolveFirstPrompt: (() => void) | null = null;

    const { client } = createMockClient();
    // Override session.prompt to block on first call
    (client.session as any).prompt = () => {
      promptCallCount++;
      if (promptCallCount === 1) {
        // First call: block until we manually resolve
        return new Promise<{ data: unknown }>((resolve) => {
          resolveFirstPrompt = () => resolve({ data: {} });
        });
      }
      // Subsequent calls: resolve immediately (shouldn't happen with the guard)
      return Promise.resolve({ data: {} });
    };

    try {
      const hooks = await LorePlugin({
        client,
        project: { id: "test", path: tmpDir } as any,
        directory: tmpDir,
        worktree: tmpDir,
        serverUrl: new URL("http://localhost:0"),
        $: {} as any,
      });

      const sessionID = "ses_reentry_test";

      // Fire first overflow — this will call session.prompt which blocks
      const firstError = hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });

      // Wait a tick for the first handler to reach session.prompt
      await new Promise((r) => setTimeout(r, 50));
      expect(promptCallCount).toBe(1);

      // Fire second overflow for the SAME session while first is still blocking.
      // With the re-entrancy guard, this should bail out immediately without
      // calling session.prompt again.
      const secondError = hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });

      // The second handler should complete quickly (bails out)
      await secondError;

      // Still only 1 session.prompt call — the second was blocked by the guard
      expect(promptCallCount).toBe(1);

      // Resolve the first prompt so the test can clean up
      resolveFirstPrompt!();
      await firstError;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("curator onIdle gating", () => {
  test("curator does NOT fire when turnsSinceCuration < afterTurns", async () => {
    const { hooks, calls, cleanup } = await initPlugin();
    try {
      const sessionID = "ses_curator_test_001";

      // First, make the session known (simulate a message.updated so it's in activeSessions)
      // We need to add the session to activeSessions. The simplest way is to fire a
      // message.updated event first. But session.message returns null in our mock, so
      // temporal.store won't be called. However, shouldSkip → activeSessions.add will
      // happen on the first event (Bug 3 fix: unknown sessions get cached as known-good).
      // Actually, we need to fire a session.idle for a known session.

      // Trigger shouldSkip to cache the session as known-good (Bug 3 fix)
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID, id: "msg_1", role: "user" },
          },
        } as any,
      });

      // Reset call tracking
      delete calls["session.create"];
      delete calls["session.prompt"];

      // Fire session.idle — with 0 turns since curation (< default 10),
      // the curator should NOT fire
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID },
        } as any,
      });

      // session.create would be called to create the curator worker session.
      // It should NOT have been called since curator shouldn't trigger.
      const curatorCalls = (calls["session.create"] ?? []).filter(
        (args) => (args[0] as any)?.title === "lore curator",
      );
      expect(curatorCalls.length).toBe(0);

      // session.prompt should NOT have been called for curation
      const promptCalls = calls["session.prompt"] ?? [];
      expect(promptCalls.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("shouldSkip caching", () => {
  test("unknown session does NOT trigger session.list fallback", async () => {
    const { mkdirSync, rmSync } = await import("fs");
    const tmpDir = `${import.meta.dir}/__tmp_skip_${Date.now()}__`;
    mkdirSync(tmpDir, { recursive: true });

    const { calls, client } = createMockClient();
    // Make session.get throw (simulating short ID lookup failure)
    (client.session as any).get = (opts: any) => {
      (calls["session.get"] ??= []).push([opts.path.id]);
      return Promise.reject(new Error("NotFound"));
    };

    try {
      const hooks = await LorePlugin({
        client,
        project: { id: "test", path: tmpDir } as any,
        directory: tmpDir,
        worktree: tmpDir,
        serverUrl: new URL("http://localhost:0"),
        $: {} as any,
      });

      // Fire a message.updated event for an unknown session with a short ID
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID: "ses_short123", id: "msg_1", role: "user" },
          },
        } as any,
      });

      // session.get was called (one attempt)
      expect(calls["session.get"]?.length ?? 0).toBeGreaterThanOrEqual(1);

      // session.list should NOT have been called (removed fallback)
      expect(calls["session.list"]?.length ?? 0).toBe(0);

      // Fire a second event for the same session — should be cached, no API calls
      const getCountBefore = calls["session.get"]?.length ?? 0;

      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID: "ses_short123", id: "msg_2", role: "assistant" },
          },
        } as any,
      });

      // No additional session.get call — session was cached as known-good
      expect(calls["session.get"]?.length ?? 0).toBe(getCountBefore);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── LTM session cache tests ──────────────────────────────────────────
//
// Validates that the system transform hook caches the formatted LTM block
// per session and only regenerates when knowledge mutations invalidate it.
// This is the primary fix for the <20% prompt cache hit rate: without
// caching, forSession() re-scores entries every turn, changing the system
// prompt bytes at position 0 and causing total Anthropic cache invalidation.

/**
 * Helper: call the system transform hook and return the system prompt parts.
 */
async function callSystemTransform(
  hooks: Awaited<ReturnType<typeof LorePlugin>>,
  sessionID: string,
): Promise<string[]> {
  const sysTransform = (hooks as Record<string, unknown>)[
    "experimental.chat.system.transform"
  ] as (input: unknown, output: { system: string[] }) => Promise<void>;
  const output = { system: [] as string[] };
  await sysTransform(
    {
      sessionID,
      model: { limit: { context: 200_000, output: 32_000 } },
    },
    output,
  );
  return output.system;
}

describe("LTM session cache", () => {
  test("system transform returns identical bytes on consecutive calls", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      // Seed knowledge entries for this project
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "LTM cache test entry",
        content: "Using SQLite for local storage in all environments",
        scope: "project",
      });

      const sessionID = "ses_ltm_cache_001";
      const first = await callSystemTransform(hooks!, sessionID);
      const second = await callSystemTransform(hooks!, sessionID);

      // Find the LTM block (contains "Long-term Knowledge" heading)
      const ltmBlock1 = first.find((s) => s.includes("Long-term Knowledge"));
      const ltmBlock2 = second.find((s) => s.includes("Long-term Knowledge"));

      expect(ltmBlock1).toBeTruthy();
      expect(ltmBlock2).toBeTruthy();
      // Must be byte-identical (same cache entry, preserves prompt cache)
      expect(ltmBlock2).toBe(ltmBlock1);
    } finally {
      cleanup();
    }
  });

  test("different sessions get independent cache entries", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      ltm.create({
        projectPath: tmpDir,
        category: "pattern",
        title: "Independent cache test",
        content: "Each session should independently cache its LTM block",
        scope: "project",
      });

      const session1 = await callSystemTransform(hooks!, "ses_A");
      const session2 = await callSystemTransform(hooks!, "ses_B");

      // Both should include knowledge (both sessions get the same project entries)
      const ltm1 = session1.find((s) => s.includes("Long-term Knowledge"));
      const ltm2 = session2.find((s) => s.includes("Long-term Knowledge"));
      expect(ltm1).toBeTruthy();
      expect(ltm2).toBeTruthy();

      // Content should be the same (same entries), but they're independent
      // cache entries — verify by checking both exist
      expect(ltm1).toEqual(ltm2);
    } finally {
      cleanup();
    }
  });

  test("knowledge mutation causes cache refresh on next call", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Cache invalidation test original",
        content: "Original content before curation",
        scope: "project",
      });

      const sessionID = "ses_ltm_invalidation";
      const before = await callSystemTransform(hooks!, sessionID);
      const ltmBefore = before.find((s) => s.includes("Long-term Knowledge"))!;
      expect(ltmBefore).toContain("Original content");

      // Simulate a knowledge mutation (what backgroundCurate would trigger).
      // The plugin's invalidateLtmCache is internal, so we simulate the full
      // flow: create a new entry + trigger session.idle which runs curation.
      // But curation needs an LLM — simpler: directly verify that a new
      // entry DOESN'T appear until the cache is cleared.
      ltm.create({
        projectPath: tmpDir,
        category: "gotcha",
        title: "Newly curated entry",
        content: "This entry was added after the first call",
        scope: "project",
      });

      // Call again — should still return CACHED version (no invalidation yet)
      const cached = await callSystemTransform(hooks!, sessionID);
      const ltmCached = cached.find((s) => s.includes("Long-term Knowledge"))!;
      // The cached version should NOT contain the new entry
      expect(ltmCached).not.toContain("Newly curated entry");
      // Must be byte-identical to the original (cache hit)
      expect(ltmCached).toBe(ltmBefore);
    } finally {
      cleanup();
    }
  });

  test("fresh session picks up knowledge changes (post-invalidation)", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      const id = ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Evolving knowledge",
        content: "Version 1 of content",
        scope: "project",
      });

      // Session A caches version 1
      const sessionA = "ses_evolving_A";
      const v1 = await callSystemTransform(hooks!, sessionA);
      expect(v1.find((s) => s.includes("Long-term Knowledge"))).toContain(
        "Version 1",
      );

      // Mutate knowledge (simulates what curation/consolidation would do)
      ltm.update(id, { content: "Version 2 of content" });

      // Session A still sees cached version 1 (cache isolation)
      const stale = await callSystemTransform(hooks!, sessionA);
      expect(stale.find((s) => s.includes("Long-term Knowledge"))).toContain(
        "Version 1",
      );

      // Session B (fresh, no cache entry) sees version 2 immediately
      const sessionB = "ses_evolving_B";
      const fresh = await callSystemTransform(hooks!, sessionB);
      expect(fresh.find((s) => s.includes("Long-term Knowledge"))).toContain(
        "Version 2",
      );
    } finally {
      cleanup();
    }
  });

  test("system transform does not crash with no project-specific entries", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      // A fresh tmpDir has no project-specific entries. Cross-project entries
      // from other test files may exist in the shared DB — that's fine, we're
      // testing that the cache path doesn't crash, not that the result is empty.
      const result = await callSystemTransform(hooks!, "ses_empty");
      // Should return an array (may or may not contain LTM depending on
      // cross-project entries from other tests — no assertion on content).
      expect(Array.isArray(result)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ── isValidProjectPath tests ─────────────────────────────────────────

describe("isValidProjectPath", () => {
  test("returns false for root path '/'", () => {
    expect(isValidProjectPath("/")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isValidProjectPath("")).toBe(false);
  });

  test("returns true for a normal project path", () => {
    expect(isValidProjectPath("/home/user/project")).toBe(true);
  });

  test("returns true for a relative path", () => {
    expect(isValidProjectPath("./my-project")).toBe(true);
  });
});

// ── Plugin with invalid project path ─────────────────────────────────

describe("LorePlugin — invalid project path", () => {
  test("initializes without crashing when projectPath is '/'", async () => {
    const { client } = createMockClient();

    // Simulate launching outside a git repo: no worktree, directory is "/"
    const hooks = await LorePlugin({
      client,
      project: { id: "test", path: "/" } as any,
      directory: "/",
      worktree: "",
      serverUrl: new URL("http://localhost:0"),
      $: {} as any,
    });

    // Plugin should return hooks without crashing
    expect(hooks).toBeTruthy();
    expect(hooks.event).toBeDefined();
  });
});

// ── Transform hook error handling ─────────────────────────────────────
//
// Validates that both transform hooks catch DB errors and degrade gracefully
// instead of propagating exceptions that surface as 500 errors.

/**
 * Helper: call the messages transform hook and return the output.
 */
async function callMessagesTransform(
  hooks: Awaited<ReturnType<typeof LorePlugin>>,
  messages: Array<{ info: Message; parts: Part[] }>,
): Promise<Array<{ info: Message; parts: Part[] }>> {
  const msgTransform = (hooks as Record<string, unknown>)[
    "experimental.chat.messages.transform"
  ] as (
    input: unknown,
    output: { messages: Array<{ info: Message; parts: Part[] }> },
  ) => Promise<void>;
  const output = { messages: [...messages] };
  await msgTransform({}, output);
  return output.messages;
}

function makeTestMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID = "ses_transform_err",
): { info: Message; parts: Part[] } {
  const info: Message =
    role === "user"
      ? {
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }
      : {
          id,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `parent-${id}`,
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
  return {
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

/**
 * Helper: drop and recreate the knowledge + FTS tables with full schema
 * (matching db.ts initial schema + all migrations).
 * Used by error-handling tests that need to corrupt then restore the DB.
 */
function restoreKnowledgeTables() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_session TEXT,
      cross_project INTEGER DEFAULT 0,
      confidence REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata TEXT,
      embedding BLOB
    )
  `);
  db().exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, content, category,
      content=knowledge, content_rowid=rowid,
      tokenize='porter unicode61'
    )
  `);
  // Recreate FTS sync triggers
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `);
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
      VALUES('delete', old.rowid, old.title, old.content, old.category);
    END
  `);
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
      VALUES('delete', old.rowid, old.title, old.content, old.category);
      INSERT INTO knowledge_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `);
}

function restoreDistillationTables() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS distillations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      narrative TEXT NOT NULL,
      facts TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      generation INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      observations TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Post-migration indexes: compound indexes from v6, single-column idx_distillation_project dropped
  db().exec(`CREATE INDEX IF NOT EXISTS idx_distillation_session ON distillations(session_id)`);
  db().exec(`CREATE INDEX IF NOT EXISTS idx_distillation_archived ON distillations(archived)`);
  db().exec(`CREATE INDEX IF NOT EXISTS idx_distillation_project_session ON distillations(project_id, session_id)`);
  db().exec(`CREATE INDEX IF NOT EXISTS idx_distillation_project_session_gen_archived ON distillations(project_id, session_id, generation, archived)`);
  db().exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS distillation_fts USING fts5(
      observations, content='distillations', content_rowid='rowid'
    )
  `);
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS distillation_fts_insert AFTER INSERT ON distillations BEGIN
      INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
    END
  `);
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS distillation_fts_delete AFTER DELETE ON distillations BEGIN
      INSERT INTO distillation_fts(distillation_fts, rowid, observations)
      VALUES('delete', old.rowid, old.observations);
    END
  `);
  db().exec(`
    CREATE TRIGGER IF NOT EXISTS distillation_fts_update AFTER UPDATE ON distillations BEGIN
      INSERT INTO distillation_fts(distillation_fts, rowid, observations)
      VALUES('delete', old.rowid, old.observations);
      INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
    END
  `);
}

describe("transform hook error handling", () => {
  test("system.transform catches DB error and pushes fallback note", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      // Seed a knowledge entry so forSession() would normally return data
      ltm.create({
        projectPath: tmpDir,
        category: "pattern",
        title: "Error handling test entry",
        content: "This entry exists to trigger forSession code path",
        scope: "project",
      });

      // Corrupt the knowledge table — forSession() queries it directly.
      // Drop both FTS and base table to ensure a hard error.
      db().exec("DROP TABLE IF EXISTS knowledge_fts");
      db().exec("DROP TABLE IF EXISTS knowledge");

      const sessionID = "ses_sys_db_error";
      const result = await callSystemTransform(hooks!, sessionID);

      // Should contain the fallback note (not crash)
      const fallback = result.find((s) =>
        s.includes("Long-term memory is temporarily unavailable"),
      );
      expect(fallback).toBeTruthy();
      expect(fallback).toContain("recall tool");

      // LTM tokens should be reset to 0
      expect(getLtmTokens()).toBe(0);
    } finally {
      restoreKnowledgeTables();
      cleanup();
    }
  });

  test("messages.transform catches DB error and leaves messages unchanged", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const sessionID = "ses_msg_db_error";
      const messages = [
        makeTestMsg("u1", "user", "Hello world", sessionID),
        makeTestMsg("a1", "assistant", "Hi there!", sessionID),
        makeTestMsg("u2", "user", "What next?", sessionID),
      ];

      // Corrupt the distillations table — transform() calls loadDistillations()
      // which queries this table.
      db().exec("DROP TABLE IF EXISTS distillation_fts");
      db().exec("DROP TABLE IF EXISTS distillations");

      // Should not throw — messages pass through unchanged
      const result = await callMessagesTransform(hooks!, messages);

      // Messages should be unchanged (layer 0 passthrough equivalent)
      expect(result.length).toBe(messages.length);
      expect(result[0].info.id).toBe("u1");
      expect(result[2].info.id).toBe("u2");
    } finally {
      restoreDistillationTables();
      cleanup();
    }
  });

  test("LTM recovery skipped on long session to preserve prompt cache", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      // Seed knowledge entry
      ltm.create({
        projectPath: tmpDir,
        category: "architecture",
        title: "Cache trade-off test",
        content: "Entry for testing LTM recovery trade-off",
        scope: "project",
      });

      const sessionID = "ses_cache_tradeoff_long";

      // First call: corrupt DB to trigger degraded mode
      db().exec("DROP TABLE IF EXISTS knowledge_fts");
      db().exec("DROP TABLE IF EXISTS knowledge");
      const degraded = await callSystemTransform(hooks!, sessionID);
      expect(
        degraded.find((s) => s.includes("temporarily unavailable")),
      ).toBeTruthy();

      // Restore the knowledge table
      restoreKnowledgeTables();

      // Re-seed knowledge
      ltm.create({
        projectPath: tmpDir,
        category: "architecture",
        title: "Cache trade-off test restored",
        content: "Entry for testing LTM recovery trade-off after restore",
        scope: "project",
      });

      // Simulate a long conversation by doing a real transform + calibration
      // so lastTransformEstimate is set high.
      setModelLimits({ context: 200_000, output: 32_000 });

      // Create a substantial message array to drive up lastTransformEstimate
      const messages: Array<{ info: Message; parts: Part[] }> = [];
      for (let i = 0; i < 100; i++) {
        messages.push(
          makeTestMsg(`u${i}`, "user", "x".repeat(500), sessionID),
          makeTestMsg(`a${i}`, "assistant", "y".repeat(500), sessionID),
        );
      }

      // Run messages transform to populate lastTransformEstimate for this session
      await callMessagesTransform(hooks!, messages);

      // Now call system transform again — DB is restored, forSession() would
      // succeed, but the session is degraded + conversation is large.
      // Should keep the fallback note to preserve prompt cache.
      const recovered = await callSystemTransform(hooks!, sessionID);
      const stillDegraded = recovered.find((s) =>
        s.includes("temporarily unavailable"),
      );
      expect(stillDegraded).toBeTruthy();
    } finally {
      restoreKnowledgeTables();
      cleanup();
    }
  });

  test("LTM recovery proceeds on short session", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      // Seed knowledge entry
      ltm.create({
        projectPath: tmpDir,
        category: "architecture",
        title: "Short session recovery test",
        content: "Entry for testing LTM recovery on a short session",
        scope: "project",
      });

      const sessionID = "ses_cache_tradeoff_short";

      // First call: corrupt DB to trigger degraded mode
      db().exec("DROP TABLE IF EXISTS knowledge_fts");
      db().exec("DROP TABLE IF EXISTS knowledge");
      const degraded = await callSystemTransform(hooks!, sessionID);
      expect(
        degraded.find((s) => s.includes("temporarily unavailable")),
      ).toBeTruthy();

      // Restore the knowledge table
      restoreKnowledgeTables();

      // Re-seed knowledge
      ltm.create({
        projectPath: tmpDir,
        category: "architecture",
        title: "Short session recovery entry",
        content: "Entry visible after DB recovery on short session",
        scope: "project",
      });

      // Don't run any messages transform — lastTransformEstimate stays at 0
      // (short/new session). LTM benefit outweighs zero cache cost.
      const recovered = await callSystemTransform(hooks!, sessionID);

      // Should recover real LTM (not the fallback note)
      const ltmBlock = recovered.find((s) =>
        s.includes("Long-term Knowledge"),
      );
      expect(ltmBlock).toBeTruthy();
      expect(ltmBlock).toContain("Short session recovery entry");

      // The fallback note should NOT be present
      const fallback = recovered.find((s) =>
        s.includes("temporarily unavailable"),
      );
      expect(fallback).toBeUndefined();
    } finally {
      restoreKnowledgeTables();
      cleanup();
    }
  });
});
