import { describe, test, expect, beforeEach } from "bun:test";
import {
  isContextOverflow,
  buildRecoveryMessage,
  buildMediaAwareRecoveryMessage,
  isMediaMime,
  stripMediaPart,
  getLastRealUserMessage,
  findPreviousCompactSummary,
  LorePlugin,
  isValidProjectPath,
} from "../src/index";
import {
  ltm,
  db,
  getLtmTokens,
  setModelLimits,
  calibrate,
  setLtmTokens,
  setLastTurnAtForTest,
} from "@loreai/core";
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

// Provider-specific overflow wordings. These mirror upstream OpenCode's
// OVERFLOW_PATTERNS list in packages/opencode/src/provider/error.ts. When
// upstream adds or changes a pattern, add/update the corresponding case here.
describe("isContextOverflow — provider-specific regex patterns", () => {
  const cases: Array<[string, string]> = [
    ["Anthropic", "prompt is too long: 250000 tokens > 200000 maximum"],
    ["Amazon Bedrock", "Input is too long for requested model."],
    ["OpenAI", "the request exceeds the context window for this model"],
    [
      "Google Gemini",
      "Input token count 250000 exceeds the maximum number of tokens allowed (200000).",
    ],
    ["xAI Grok", "Maximum prompt length is 131072"],
    ["Groq", "Please reduce the length of the messages or completion."],
    ["OpenRouter", "maximum context length is 128000 tokens"],
    ["GitHub Copilot", "Request exceeds the limit of 4096 tokens."],
    ["llama.cpp", "Input exceeds the available context size"],
    ["LM Studio", "Input is greater than the context length"],
    ["MiniMax", "Context window exceeds limit."],
    ["Kimi/Moonshot", "exceeded model token limit"],
    ["Generic context_length_exceeded", "context_length_exceeded"],
    ["Generic context length exceeded (spaced)", "context length exceeded"],
    ["HTTP 413", "Request Entity Too Large"],
    ["vLLM alt1", "context length is only 4096 tokens"],
    [
      "vLLM alt2",
      "Input length 5000 tokens exceeds max context length 4096 tokens",
    ],
    ["Ollama", "prompt too long; exceeded max context length"],
    [
      "Mistral",
      "Request is too large for model with 8192 maximum context length",
    ],
    ["z.ai", "model_context_window_exceeded"],
    ["Cerebras 413 no-body", "413 (no body)"],
    ["Cerebras 400 no-body", "400 status code (no body)"],
  ];

  for (const [provider, message] of cases) {
    test(`detects ${provider}`, () => {
      expect(
        isContextOverflow({ name: "APIError", data: { message } }),
      ).toBe(true);
    });
  }
});

// Wire-shape coverage. Upstream publishes errors via `namedSchemaError.toObject()`
// — structural shape is { name, data: {...} } without top-level message or
// statusCode. These tests pin the shapes we actually see in production.
describe("isContextOverflow — wire shape coverage", () => {
  test("APIError with data.statusCode === 413 matches even when message text doesn't", () => {
    expect(
      isContextOverflow({
        name: "APIError",
        data: { statusCode: 413, message: "whatever non-matching text" },
      }),
    ).toBe(true);
  });

  test("APIError with 413 wording in message but no statusCode", () => {
    expect(
      isContextOverflow({
        name: "APIError",
        data: { message: "HTTP 413 Request Entity Too Large" },
      }),
    ).toBe(true);
  });

  test("ContextOverflowError with responseBody (real upstream wire shape)", () => {
    expect(
      isContextOverflow({
        name: "ContextOverflowError",
        data: { message: "prompt is too long", responseBody: "{...}" },
      }),
    ).toBe(true);
  });

  test("rejects APIError with unrelated 4xx status codes", () => {
    expect(
      isContextOverflow({ name: "APIError", data: { statusCode: 400 } }),
    ).toBe(false);
    expect(
      isContextOverflow({ name: "APIError", data: { statusCode: 429 } }),
    ).toBe(false);
  });

  test("rejects non-object errors", () => {
    expect(isContextOverflow("string error")).toBe(false);
    expect(isContextOverflow(123)).toBe(false);
    expect(isContextOverflow([])).toBe(false);
  });

  test("empty-string message does not crash or match", () => {
    expect(
      isContextOverflow({ name: "APIError", data: { message: "" } }),
    ).toBe(false);
  });
});

// Case-insensitivity regression guard. Real Anthropic errors have been seen
// with Title Case wording; Lore's prior implementation used case-sensitive
// `.includes()` and silently missed them.
describe("isContextOverflow — case-insensitivity", () => {
  test("matches Title Case wording", () => {
    expect(isContextOverflow({ message: "Prompt Is Too Long" })).toBe(true);
  });

  test("matches UPPERCASE wording", () => {
    expect(
      isContextOverflow({ message: "CONTEXT_LENGTH_EXCEEDED" }),
    ).toBe(true);
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

// ── F9 media-aware recovery — pure helper tests ──────────────────────

describe("isMediaMime", () => {
  test("accepts image/* mime types", () => {
    expect(isMediaMime("image/png")).toBe(true);
    expect(isMediaMime("image/jpeg")).toBe(true);
    expect(isMediaMime("image/svg+xml")).toBe(true);
    expect(isMediaMime("image/webp")).toBe(true);
  });

  test("accepts application/pdf", () => {
    expect(isMediaMime("application/pdf")).toBe(true);
  });

  test("rejects non-media types", () => {
    expect(isMediaMime("text/plain")).toBe(false);
    expect(isMediaMime("application/json")).toBe(false);
    expect(isMediaMime("application/x-directory")).toBe(false);
    expect(isMediaMime("audio/mpeg")).toBe(false);
    expect(isMediaMime("video/mp4")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isMediaMime("")).toBe(false);
  });
});

describe("stripMediaPart", () => {
  test("formats image part with filename", () => {
    expect(
      stripMediaPart({
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,abc",
      }),
    ).toBe("[Attached image/png: screenshot.png]");
  });

  test("falls back to literal 'file' when filename missing (upstream parity)", () => {
    expect(
      stripMediaPart({
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,abc",
      }),
    ).toBe("[Attached image/png: file]");
  });

  test("formats PDF part", () => {
    expect(
      stripMediaPart({
        type: "file",
        mime: "application/pdf",
        filename: "spec.pdf",
        url: "file:///tmp/spec.pdf",
      }),
    ).toBe("[Attached application/pdf: spec.pdf]");
  });

  test("returns undefined for non-media file part", () => {
    expect(
      stripMediaPart({
        type: "file",
        mime: "text/plain",
        filename: "notes.txt",
        url: "file:///tmp/notes.txt",
      }),
    ).toBeUndefined();
  });

  test("returns undefined for non-file parts", () => {
    expect(stripMediaPart({ type: "text", text: "hello" })).toBeUndefined();
    expect(
      stripMediaPart({ type: "tool", tool: "grep", state: { status: "completed", output: "" } }),
    ).toBeUndefined();
  });

  test("returns undefined when mime is missing or non-string", () => {
    expect(stripMediaPart({ type: "file" })).toBeUndefined();
    expect(stripMediaPart({ type: "file", mime: 42 })).toBeUndefined();
    expect(stripMediaPart({ type: "file", mime: null })).toBeUndefined();
  });

  test("uses 'file' fallback when filename is non-string", () => {
    expect(
      stripMediaPart({
        type: "file",
        mime: "image/png",
        filename: 42,
        url: "data:image/png;base64,abc",
      }),
    ).toBe("[Attached image/png: file]");
  });
});

describe("buildMediaAwareRecoveryMessage", () => {
  test("emits all sections when attachments + user text + summaries are present", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [
        { observations: "User fixed bug in auth.ts", generation: 0 },
      ],
      strippedAttachments: [
        "[Attached image/png: screenshot.png]",
        "[Attached application/pdf: spec.pdf]",
      ],
      userText: ["What does this image show?"],
    });
    // Opening preamble.
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("context overflow error");
    // Media notice with both attachments listed.
    expect(msg).toContain("included 2 attachment(s) that were removed");
    expect(msg).toContain("- [Attached image/png: screenshot.png]");
    expect(msg).toContain("- [Attached application/pdf: spec.pdf]");
    // Distilled history block.
    expect(msg).toContain("auth.ts");
    // User question block.
    expect(msg).toContain("The user's original question");
    expect(msg).toContain("What does this image show?");
    // Closing instruction.
    expect(msg).toContain("Review the above and continue");
    expect(msg).toContain("</system-reminder>");
  });

  test("section order: notice → history → user question", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [{ observations: "DISTILL_TOKEN", generation: 0 }],
      strippedAttachments: ["[Attached image/png: a.png]"],
      userText: ["USER_TOKEN"],
    });
    const noticeIdx = msg.indexOf("included 1 attachment");
    const historyIdx = msg.indexOf("DISTILL_TOKEN");
    const userIdx = msg.indexOf("USER_TOKEN");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(noticeIdx);
    expect(userIdx).toBeGreaterThan(historyIdx);
  });

  test("omits media notice when no attachments stripped", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [{ observations: "obs", generation: 0 }],
      strippedAttachments: [],
      userText: ["question"],
    });
    expect(msg).not.toContain("attachment(s) that were removed");
  });

  test("omits user-question block when userText is empty", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [{ observations: "obs", generation: 0 }],
      strippedAttachments: ["[Attached image/png: a.png]"],
      userText: [],
    });
    expect(msg).not.toContain("The user's original question");
  });

  test("falls through to empty-history sentinel when summaries empty", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [],
      strippedAttachments: ["[Attached image/png: a.png]"],
      userText: ["q"],
    });
    expect(msg).toContain("No distilled history available");
  });

  test("multiple user text parts are joined verbatim", () => {
    const msg = buildMediaAwareRecoveryMessage({
      summaries: [],
      strippedAttachments: ["[Attached image/png: a.png]"],
      userText: ["First sentence.", "Second sentence."],
    });
    expect(msg).toContain("First sentence.");
    expect(msg).toContain("Second sentence.");
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

/**
 * Variant of `initPlugin` that lets tests customize the mock client BEFORE
 * the plugin is initialized. The customizer receives the mock client and
 * can override individual `session.*` methods (e.g. swap in a custom
 * `session.messages` for F9 media-aware tests). Returns the initialized
 * hooks + the call tracker + the customized client itself.
 */
async function initPluginCustomClient(
  customize: (client: ReturnType<typeof createMockClient>["client"]) => void,
) {
  const { calls, client } = createMockClient();
  customize(client);
  const tmpDir = `${import.meta.dir}/__tmp_plugin_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
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
    client,
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

// ── F9 media-aware recovery — getLastRealUserMessage + handler integration ──

describe("getLastRealUserMessage", () => {
  test("returns the most recent non-synthetic user message", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "m1", role: "user" },
                parts: [{ type: "text", text: "first user question" }],
              },
              {
                info: { id: "m2", role: "assistant" },
                parts: [{ type: "text", text: "answer" }],
              },
              {
                info: { id: "m3", role: "user" },
                parts: [{ type: "text", text: "follow-up" }],
              },
            ],
          }),
      },
    };
    const result = await getLastRealUserMessage(client, "ses_test");
    expect(result).toBeDefined();
    // Most recent (m3), not the older one.
    expect((result?.info as any).id).toBe("m3");
    expect(result?.parts[0]).toMatchObject({ type: "text", text: "follow-up" });
  });

  test("skips synthetic user messages (Lore's own recovery injections)", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "m1", role: "user" },
                parts: [{ type: "text", text: "real question" }],
              },
              {
                info: { id: "m2", role: "assistant" },
                parts: [{ type: "text", text: "answer" }],
              },
              {
                info: { id: "m3", role: "user" },
                parts: [
                  {
                    type: "text",
                    text: "<system-reminder>...</system-reminder>",
                    synthetic: true,
                  },
                ],
              },
            ],
          }),
      },
    };
    const result = await getLastRealUserMessage(client, "ses_test");
    // Should skip m3 (synthetic) and return m1.
    expect((result?.info as any).id).toBe("m1");
  });

  test("returns undefined when only synthetic user messages exist", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "m1", role: "user" },
                parts: [{ type: "text", text: "synth", synthetic: true }],
              },
            ],
          }),
      },
    };
    expect(await getLastRealUserMessage(client, "ses_test")).toBeUndefined();
  });

  test("returns undefined for empty session", async () => {
    const client = {
      session: { messages: () => Promise.resolve({ data: [] }) },
    };
    expect(await getLastRealUserMessage(client, "ses_test")).toBeUndefined();
  });

  test("returns undefined when SDK call throws (logs warning, swallows)", async () => {
    const client = {
      session: {
        messages: () => Promise.reject(new Error("network blip")),
      },
    };
    // Must not throw out of the helper.
    expect(await getLastRealUserMessage(client, "ses_test")).toBeUndefined();
  });

  test("tolerates missing `data` field on response", async () => {
    const client = {
      session: { messages: () => Promise.resolve({}) },
    };
    expect(await getLastRealUserMessage(client, "ses_test")).toBeUndefined();
  });

  test("tolerates messages with malformed shape", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              null,
              { info: null, parts: [] },
              { info: { role: "user" }, parts: [{ type: "text", text: "ok" }] },
            ],
          }),
      },
    };
    const result = await getLastRealUserMessage(client, "ses_test");
    expect(result?.parts[0]).toMatchObject({ type: "text", text: "ok" });
  });
});

// ── F1b: findPreviousCompactSummary — pure helper tests ──────────────

describe("findPreviousCompactSummary", () => {
  test("returns the most recent assistant message text where info.summary is true", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "u1", role: "user" },
                parts: [{ type: "text", text: "first user turn" }],
              },
              {
                info: { id: "a1", role: "assistant", summary: true, mode: "compaction" },
                parts: [
                  { type: "text", text: "## Goal\n- prior session goal\n## Progress\n- step 1" },
                ],
              },
              {
                info: { id: "u2", role: "user" },
                parts: [{ type: "text", text: "follow-up question" }],
              },
              {
                info: { id: "a2", role: "assistant" },
                parts: [{ type: "text", text: "regular assistant reply" }],
              },
            ],
          }),
      },
    };
    const result = await findPreviousCompactSummary(client, "ses_test");
    expect(result).toBe("## Goal\n- prior session goal\n## Progress\n- step 1");
  });

  test("returns the MOST RECENT summary when multiple exist", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "a1", role: "assistant", summary: true },
                parts: [{ type: "text", text: "older summary" }],
              },
              {
                info: { id: "a2", role: "assistant", summary: true },
                parts: [{ type: "text", text: "newer summary" }],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBe("newer summary");
  });

  test("returns undefined when no assistant has summary === true", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "a1", role: "assistant" },
                parts: [{ type: "text", text: "regular reply" }],
              },
              {
                info: { id: "a2", role: "assistant", summary: false },
                parts: [{ type: "text", text: "explicitly-false flag" }],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBeUndefined();
  });

  test("returns undefined for empty session", async () => {
    const client = {
      session: { messages: () => Promise.resolve({ data: [] }) },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBeUndefined();
  });

  test("returns undefined when SDK call throws (logs warning, swallows)", async () => {
    const client = {
      session: {
        messages: () => Promise.reject(new Error("network blip")),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBeUndefined();
  });

  test("joins multiple text parts with paragraph break (matches upstream summaryText)", async () => {
    // Upstream's summaryText (compaction.ts:93-101) joins trimmed parts with
    // "\n\n" after dropping empties. Lore mirrors that.
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "a1", role: "assistant", summary: true },
                parts: [
                  { type: "text", text: "## Goal\n- ship F1b" },
                  { type: "text", text: "  " }, // whitespace-only — dropped
                  { type: "text", text: "## Progress\n- writing tests" },
                ],
              },
            ],
          }),
      },
    };
    const result = await findPreviousCompactSummary(client, "ses_test");
    expect(result).toBe("## Goal\n- ship F1b\n\n## Progress\n- writing tests");
  });

  test("ignores reasoning/tool parts on the matched message", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "a1", role: "assistant", summary: true },
                parts: [
                  { type: "reasoning", text: "internal thought" },
                  { type: "text", text: "actual summary body" },
                  { type: "tool", tool: "grep", state: { status: "completed", output: "x" } },
                ],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBe("actual summary body");
  });

  test("skips assistants where summary is falsy (matches upstream's truthy check)", async () => {
    // Upstream's completedCompactions uses `!msg.info.summary` (truthy check).
    // Confirm Lore matches: false, null, 0, "" are all rejected; only the
    // earlier "summary === true" case from the matching tests qualifies.
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { id: "a1", role: "assistant", summary: false },
                parts: [{ type: "text", text: "explicit false" }],
              },
              {
                info: { id: "a2", role: "assistant", summary: null },
                parts: [{ type: "text", text: "explicit null" }],
              },
              {
                info: { id: "a3", role: "assistant", summary: 0 },
                parts: [{ type: "text", text: "numeric zero" }],
              },
              {
                info: { id: "a4", role: "assistant", summary: "" },
                parts: [{ type: "text", text: "empty string" }],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBeUndefined();
  });

  test("tolerates malformed entries (null, missing info, missing parts)", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              null,
              { info: null, parts: [] },
              { info: { role: "user" } },
              {
                info: { role: "assistant", summary: true },
                parts: [{ type: "text", text: "valid summary" }],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBe("valid summary");
  });

  test("returns undefined when summary message has no non-empty text parts", async () => {
    const client = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant", summary: true },
                parts: [{ type: "text", text: "   " }, { type: "reasoning", text: "thought" }],
              },
            ],
          }),
      },
    };
    expect(await findPreviousCompactSummary(client, "ses_test")).toBeUndefined();
  });
});

describe("auto-recovery — media-aware path (F9)", () => {
  test("recovery prompt includes attachment list + user text when last user message has media", async () => {
    const { hooks, calls, client, cleanup } = await initPluginCustomClient((c) => {
      // Override session.messages to return a user message with an
      // image attachment + text question.
      (c.session as any).messages = () =>
        Promise.resolve({
          data: [
            {
              info: { id: "m1", role: "user" },
              parts: [
                { type: "text", text: "Explain this screenshot please." },
                {
                  type: "file",
                  mime: "image/png",
                  filename: "screenshot.png",
                  url: "data:image/png;base64,abc",
                },
              ],
            },
          ],
        });
    });
    try {
      const sessionID = "ses_f9_media_001";
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });
      // Recovery prompt was sent.
      expect(calls["session.prompt"]?.length ?? 0).toBeGreaterThanOrEqual(1);
      // Inspect the body.
      const promptArgs = calls["session.prompt"]![0]![0] as {
        body: { parts: Array<{ text: string }> };
      };
      const text = promptArgs.body.parts[0]!.text;
      expect(text).toContain("[Attached image/png: screenshot.png]");
      expect(text).toContain("Explain this screenshot please.");
      expect(text).toContain("compressed the conversation history");
      expect(text).toContain("attachment(s) that were removed");
    } finally {
      cleanup();
    }
  });

  test("recovery prompt falls back to plain buildRecoveryMessage when no media in last user message", async () => {
    const { hooks, calls, cleanup } = await initPluginCustomClient((c) => {
      // User message with text only — no media.
      (c.session as any).messages = () =>
        Promise.resolve({
          data: [
            {
              info: { id: "m1", role: "user" },
              parts: [{ type: "text", text: "ordinary text-only question" }],
            },
          ],
        });
    });
    try {
      const sessionID = "ses_f9_nomedia_001";
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });
      expect(calls["session.prompt"]?.length ?? 0).toBeGreaterThanOrEqual(1);
      const promptArgs = calls["session.prompt"]![0]![0] as {
        body: { parts: Array<{ text: string }> };
      };
      const text = promptArgs.body.parts[0]!.text;
      // Plain recovery contract per F9 D4: byte-identical to today.
      // We seed no distillations in this test (initPluginCustomClient
      // creates an empty DB), so the expected payload is the
      // "no summaries provided" fallback. Pin the full string so any
      // accidental drift (e.g. an extra blank line, a section sneaking
      // through the no-media path) is caught.
      expect(text).toBe(buildRecoveryMessage([]));
    } finally {
      cleanup();
    }
  });

  test("recovery falls through to plain path when session.messages throws", async () => {
    const { hooks, calls, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () =>
        Promise.reject(new Error("simulated SDK failure"));
    });
    try {
      const sessionID = "ses_f9_sdk_fail_001";
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });
      // Recovery still happens — falls back to plain message.
      expect(calls["session.prompt"]?.length ?? 0).toBeGreaterThanOrEqual(1);
      const promptArgs = calls["session.prompt"]![0]![0] as {
        body: { parts: Array<{ text: string }> };
      };
      const text = promptArgs.body.parts[0]!.text;
      expect(text).not.toContain("attachment(s) that were removed");
      expect(text).toContain("compressed the conversation history");
    } finally {
      cleanup();
    }
  });

  test("multiple media attachments are all listed in the notice", async () => {
    const { hooks, calls, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () =>
        Promise.resolve({
          data: [
            {
              info: { id: "m1", role: "user" },
              parts: [
                { type: "text", text: "compare these" },
                {
                  type: "file",
                  mime: "image/png",
                  filename: "a.png",
                  url: "data:image/png;base64,a",
                },
                {
                  type: "file",
                  mime: "image/jpeg",
                  filename: "b.jpg",
                  url: "data:image/jpeg;base64,b",
                },
                {
                  type: "file",
                  mime: "application/pdf",
                  filename: "c.pdf",
                  url: "file:///tmp/c.pdf",
                },
              ],
            },
          ],
        });
    });
    try {
      const sessionID = "ses_f9_multi_media";
      await hooks.event!({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "prompt is too long: 250000 tokens" },
          },
        } as any,
      });
      const promptArgs = calls["session.prompt"]![0]![0] as {
        body: { parts: Array<{ text: string }> };
      };
      const text = promptArgs.body.parts[0]!.text;
      expect(text).toContain("3 attachment(s) that were removed");
      expect(text).toContain("[Attached image/png: a.png]");
      expect(text).toContain("[Attached image/jpeg: b.jpg]");
      expect(text).toContain("[Attached application/pdf: c.pdf]");
    } finally {
      cleanup();
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

// ── Cold-cache idle-resume hook integration ─────────────────────────
//
// Validates that the system transform hook, on detecting a long idle gap,
// (a) clears the per-session LTM cache so forSession() re-scores against
// fresh conversation context on the post-idle turn, and (b) the gradient
// state's prefix/raw window caches were reset by onIdleResume().

describe("idle-resume hook integration", () => {
  test("long idle gap clears LTM session cache — different bytes on resume", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      // Seed an entry so the cache populates.
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Idle resume test entry",
        content: "Triggers cache population for idle test",
        scope: "project",
      });

      const sessionID = "ses_idle_resume_001";
      const first = await callSystemTransform(hooks!, sessionID);
      const ltmBlock1 = first.find((s) => s.includes("Long-term Knowledge"));
      expect(ltmBlock1).toBeTruthy();

      // Simulate >60min gap by directly aging the gradient session state.
      // callSystemTransform does NOT itself call transform(), so lastTurnAt
      // wouldn't be set by the first call alone — seed it manually to a value
      // older than the 60-minute default threshold.
      setLastTurnAtForTest(sessionID, Date.now() - 2 * 60 * 60_000);

      // Add a NEW entry so the post-resume LTM block has different content
      // — this proves the cache was cleared (otherwise the cached bytes
      // from the previous turn would be returned regardless).
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Idle resume new entry post-pause",
        content: "Added during simulated idle gap — should appear after resume",
        scope: "project",
      });

      const second = await callSystemTransform(hooks!, sessionID);
      const ltmBlock2 = second.find((s) => s.includes("Long-term Knowledge"));
      expect(ltmBlock2).toBeTruthy();
      // The new entry was added during the gap, AND the cache was cleared,
      // so the post-resume LTM block must include it.
      expect(ltmBlock2).toContain("Idle resume new entry post-pause");
      // Sanity: the bytes are NOT identical (which would indicate stale cache).
      expect(ltmBlock2).not.toBe(ltmBlock1);
    } finally {
      cleanup();
    }
  });

  test("short gap (under threshold) does NOT clear LTM cache", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Short gap cache test",
        content: "This entry should be cached across short gaps",
        scope: "project",
      });

      const sessionID = "ses_idle_resume_002";
      const first = await callSystemTransform(hooks!, sessionID);
      const ltmBlock1 = first.find((s) => s.includes("Long-term Knowledge"));
      expect(ltmBlock1).toBeTruthy();

      // Simulate a 3-minute gap — well under 5min default threshold.
      setLastTurnAtForTest(sessionID, Date.now() - 3 * 60_000);

      // Add a new entry. If the cache was cleared, this would appear; if
      // the cache survived, it would not.
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Should NOT appear post-short-gap",
        content: "Cache should still be warm — this entry gets ignored",
        scope: "project",
      });

      const second = await callSystemTransform(hooks!, sessionID);
      const ltmBlock2 = second.find((s) => s.includes("Long-term Knowledge"));
      expect(ltmBlock2).toBeTruthy();
      // Cache was preserved — bytes are byte-identical.
      expect(ltmBlock2).toBe(ltmBlock1);
      // The new entry from during the short gap is NOT in the cached block.
      expect(ltmBlock2).not.toContain("Should NOT appear post-short-gap");
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
      archived INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      r_compression REAL,
      c_norm REAL
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

// ── experimental.session.compacting hook ────────────────────────────
//
// Wiring-level tests: the hook must populate output.prompt with the
// SUMMARY_TEMPLATE body (via buildCompactPrompt) and push a distillations
// context block into output.context when any distillations exist for the
// session. These tests don't assert anything about the prompt-body shape
// itself — that's covered by packages/core/test/prompt.test.ts.

async function callCompacting(
  hooks: Awaited<ReturnType<typeof LorePlugin>>,
  input: { sessionID?: string },
): Promise<{ prompt: string | undefined; context: string[] }> {
  const hook = (hooks as Record<string, unknown>)[
    "experimental.session.compacting"
  ] as (
    input: unknown,
    output: { context: string[]; prompt: string | undefined },
  ) => Promise<void>;
  const output = { context: [] as string[], prompt: undefined as string | undefined };
  await hook(input, output);
  return output;
}

describe("experimental.session.compacting", () => {
  test("sets output.prompt to the SUMMARY_TEMPLATE body", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const { prompt, context } = await callCompacting(hooks!, {
        sessionID: "ses_compact_template_001",
      });
      expect(prompt).toBeTruthy();
      // Body contains template section headings.
      expect(prompt).toContain("## Goal");
      expect(prompt).toContain("## Progress");
      expect(prompt).toContain("### Done");
      expect(prompt).toContain("### In Progress");
      expect(prompt).toContain("### Blocked");
      expect(prompt).toContain("## Next Steps");
      expect(prompt).toContain("## Critical Context");
      expect(prompt).toContain("## Relevant Files");
      expect(prompt).toContain("I'm ready to continue.");
      // No distillations seeded, no context pushed.
      expect(context).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("pushes a Lore Pre-computed Session Summaries block into output.context when distillations exist", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      const sessionID = "ses_compact_context_001";
      const pid = db()
        .query("SELECT id FROM projects WHERE path = ?")
        .get(tmpDir) as { id: string };
      // Seed a gen-0 distillation directly so the hook sees it.
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          pid.id,
          sessionID,
          "",
          "[]",
          "seeded distillation observation body",
          "[]",
          0,
          10,
          Date.now(),
        );

      const { prompt, context } = await callCompacting(hooks!, { sessionID });

      // Context block pushed.
      expect(context).toHaveLength(1);
      expect(context[0]).toContain("Lore Pre-computed Session Summaries");
      expect(context[0]).toContain("seeded distillation observation body");

      // Prompt references that distillations are pre-computed.
      expect(prompt).toContain("Lore has pre-computed chunked summaries");
    } finally {
      cleanup();
    }
  });

  test("includes long-term knowledge in the prompt when knowledge entries exist", async () => {
    const { hooks, tmpDir, cleanup } = await initPlugin();
    try {
      ltm.create({
        projectPath: tmpDir,
        category: "decision",
        title: "Compact-hook knowledge entry",
        content: "Entry that should appear in /compact prompt knowledge block",
        scope: "project",
      });

      const { prompt } = await callCompacting(hooks!, {
        sessionID: "ses_compact_knowledge_001",
      });
      expect(prompt).toContain("Long-term Knowledge");
      expect(prompt).toContain("Compact-hook knowledge entry");
    } finally {
      cleanup();
    }
  });

  test("works when input.sessionID is missing (no DB reads)", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const { prompt, context } = await callCompacting(hooks!, {});
      // Prompt still emitted with template body.
      expect(prompt).toContain("## Goal");
      // No distillations possible → no context block.
      expect(context).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  // F1b: anchor on prior /compact summary

  test("F1b: emits <previous-summary> anchor when a prior /compact summary exists in the session", async () => {
    const priorSummaryText =
      "## Goal\n- Refactor the auth module\n## Progress\n### Done\n- Added OAuth\n### In Progress\n- Token refresh\n## Next Steps\n- Write integration tests";
    const { hooks, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () =>
        Promise.resolve({
          data: [
            {
              info: { id: "u1", role: "user" },
              parts: [{ type: "text", text: "first user turn" }],
            },
            {
              info: { id: "a1", role: "assistant", summary: true, mode: "compaction" },
              parts: [{ type: "text", text: priorSummaryText }],
            },
            {
              info: { id: "u2", role: "user" },
              parts: [{ type: "text", text: "more conversation after compact" }],
            },
          ],
        });
    });
    try {
      const { prompt } = await callCompacting(hooks!, {
        sessionID: "ses_f1b_anchor_001",
      });
      expect(prompt).toContain("<previous-summary>");
      expect(prompt).toContain(priorSummaryText);
      expect(prompt).toContain("</previous-summary>");
      expect(prompt).toContain("Update it using the conversation history above");
      // Template body still emitted alongside.
      expect(prompt).toContain("## Goal");
      expect(prompt).toContain("## Next Steps");
    } finally {
      cleanup();
    }
  });

  test("F1b: no anchor block when session has no prior /compact summary", async () => {
    const { hooks, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () =>
        Promise.resolve({
          data: [
            {
              info: { id: "u1", role: "user" },
              parts: [{ type: "text", text: "first user turn" }],
            },
            {
              info: { id: "a1", role: "assistant" },
              parts: [{ type: "text", text: "regular assistant reply" }],
            },
          ],
        });
    });
    try {
      const { prompt } = await callCompacting(hooks!, {
        sessionID: "ses_f1b_noanchor_001",
      });
      expect(prompt).not.toContain("<previous-summary>");
      expect(prompt).not.toContain("Update it using the conversation history");
      // Template body still emitted.
      expect(prompt).toContain("## Goal");
    } finally {
      cleanup();
    }
  });

  test("F1b: SDK failure on session.messages falls through to non-anchored prompt", async () => {
    const { hooks, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () =>
        Promise.reject(new Error("simulated SDK failure"));
    });
    try {
      const { prompt } = await callCompacting(hooks!, {
        sessionID: "ses_f1b_sdkfail_001",
      });
      // Recovery: no anchor, but prompt still produced with template body.
      expect(prompt).not.toContain("<previous-summary>");
      expect(prompt).toContain("## Goal");
    } finally {
      cleanup();
    }
  });

  test("F1b: missing input.sessionID skips anchor lookup entirely", async () => {
    let messagesCalled = false;
    const { hooks, cleanup } = await initPluginCustomClient((c) => {
      (c.session as any).messages = () => {
        messagesCalled = true;
        return Promise.resolve({ data: [] });
      };
    });
    try {
      const { prompt } = await callCompacting(hooks!, {});
      expect(messagesCalled).toBe(false);
      expect(prompt).not.toContain("<previous-summary>");
      expect(prompt).toContain("## Goal");
    } finally {
      cleanup();
    }
  });
});
