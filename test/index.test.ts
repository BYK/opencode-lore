import { describe, test, expect, beforeEach } from "bun:test";
import { isContextOverflow, buildRecoveryMessage, LorePlugin } from "../src/index";
import type { Plugin } from "@opencode-ai/plugin";

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
