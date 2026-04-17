import { describe, test, expect, mock, beforeEach } from "bun:test";
import { promptWorker, workerSessionIDs } from "../src/worker";
import { parseSourceIds } from "../src/distillation";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(overrides: {
  prompt?: (opts: unknown) => Promise<unknown>;
  create?: (opts: unknown) => Promise<unknown>;
} = {}) {
  return {
    session: {
      prompt: overrides.prompt ?? mock(() => Promise.resolve({ data: undefined })),
      create: overrides.create ?? mock(() =>
        Promise.resolve({ data: { id: "retry-session-id" } }),
      ),
    },
  } as unknown as Parameters<typeof promptWorker>[0]["client"];
}

function successResult(text: string) {
  return {
    data: {
      info: { role: "assistant" },
      parts: [{ type: "text", text, id: "p1", sessionID: "s1", messageID: "m1" }],
    },
  };
}

function errorResult(message: string) {
  return { error: { name: "NotFoundError", data: { message } } };
}

// ---------------------------------------------------------------------------
// promptWorker tests
// ---------------------------------------------------------------------------

describe("promptWorker", () => {
  let sessionMap: Map<string, string>;

  beforeEach(() => {
    sessionMap = new Map([["parent-1", "worker-1"]]);
    workerSessionIDs.clear();
  });

  test("success — returns text from assistant response", async () => {
    const client = mockClient({
      prompt: mock(() => Promise.resolve(successResult("hello world"))),
    });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test prompt" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBe("hello world");
  });

  test("session rotation — sessionMap entry deleted after success", async () => {
    const client = mockClient({
      prompt: mock(() => Promise.resolve(successResult("ok"))),
    });

    expect(sessionMap.has("parent-1")).toBe(true);
    await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });
    expect(sessionMap.has("parent-1")).toBe(false);
  });

  test("session rotation — sessionMap entry deleted after failure", async () => {
    const client = mockClient({
      prompt: mock(() => Promise.resolve(errorResult("rate limited"))),
    });

    expect(sessionMap.has("parent-1")).toBe(true);
    await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });
    expect(sessionMap.has("parent-1")).toBe(false);
  });

  test("non-agent error — returns null, no retry", async () => {
    const promptFn = mock(() =>
      Promise.resolve(errorResult("rate limit exceeded")),
    );
    const createFn = mock(() =>
      Promise.resolve({ data: { id: "should-not-be-called" } }),
    );
    const client = mockClient({ prompt: promptFn, create: createFn });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBeNull();
    // Should NOT have created a retry session
    expect(createFn).not.toHaveBeenCalled();
    // prompt called exactly once (no retry)
    expect(promptFn).toHaveBeenCalledTimes(1);
  });

  test("agent-not-found → retry succeeds", async () => {
    let callCount = 0;
    const promptFn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          errorResult('Agent not found: "lore-distill". Available agents: build, explore, general, plan'),
        );
      }
      return Promise.resolve(successResult("retried response"));
    });
    const createFn = mock(() =>
      Promise.resolve({ data: { id: "retry-session-id" } }),
    );
    const client = mockClient({ prompt: promptFn, create: createFn });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBe("retried response");
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(createFn).toHaveBeenCalledTimes(1);
    // Retry session registered in workerSessionIDs
    expect(workerSessionIDs.has("retry-session-id")).toBe(true);
  });

  test("agent-not-found → retry also fails", async () => {
    const promptFn = mock(() =>
      Promise.resolve(
        errorResult('Agent not found: "lore-distill". Available agents: build, explore, general, plan'),
      ),
    );
    const client = mockClient({ prompt: promptFn });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBeNull();
    expect(promptFn).toHaveBeenCalledTimes(2);
  });

  test("no text part in response — returns null", async () => {
    const client = mockClient({
      prompt: mock(() =>
        Promise.resolve({
          data: {
            info: { role: "assistant" },
            parts: [{ type: "reasoning", text: "thinking..." }],
          },
        }),
      ),
    });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBeNull();
  });

  test("SDK throws (e.g. JSON parse error) — returns null, retries on agent-not-found", async () => {
    const client = mockClient({
      prompt: mock(() =>
        Promise.reject(new SyntaxError("JSON Parse error: Unexpected EOF")),
      ),
    });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    // SyntaxError doesn't match "agent not found" — no retry, returns null
    expect(result).toBeNull();
  });

  test("agent-not-found with SDK throw on retry succeeds", async () => {
    let callCount = 0;
    const promptFn = mock(() => {
      callCount++;
      if (callCount === 1) {
        // Simulate SDK throwing with agent-not-found in the error message
        return Promise.reject(
          Object.assign(new Error("Agent not found: lore-distill"), {
            data: { message: 'Agent not found: "lore-distill"' },
          }),
        );
      }
      return Promise.resolve(successResult("recovered"));
    });
    const client = mockClient({ prompt: promptFn });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBe("recovered");
    expect(promptFn).toHaveBeenCalledTimes(2);
  });

  test("retry skipped when session creation fails", async () => {
    const promptFn = mock(() =>
      Promise.resolve(
        errorResult('Agent not found: "lore-distill"'),
      ),
    );
    const createFn = mock(() =>
      Promise.resolve({ data: undefined }),
    );
    const client = mockClient({ prompt: promptFn, create: createFn });

    const result = await promptWorker({
      client,
      workerID: "worker-1",
      parts: [{ type: "text", text: "test" }],
      agent: "lore-distill",
      sessionMap,
      sessionKey: "parent-1",
    });

    expect(result).toBeNull();
    // prompt only called once — retry skipped because session creation returned no data
    expect(promptFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// parseSourceIds tests
// ---------------------------------------------------------------------------

describe("parseSourceIds", () => {
  test("valid JSON array", () => {
    expect(parseSourceIds('["a","b","c"]')).toEqual(["a", "b", "c"]);
  });

  test("empty array", () => {
    expect(parseSourceIds("[]")).toEqual([]);
  });

  test("empty string — returns []", () => {
    expect(parseSourceIds("")).toEqual([]);
  });

  test("malformed JSON — returns []", () => {
    expect(parseSourceIds("{not valid")).toEqual([]);
  });

  test("non-array JSON (object) — returns []", () => {
    expect(parseSourceIds('{"key": "value"}')).toEqual([]);
  });

  test("non-array JSON (string) — returns []", () => {
    expect(parseSourceIds('"just a string"')).toEqual([]);
  });

  test("non-array JSON (number) — returns []", () => {
    expect(parseSourceIds("42")).toEqual([]);
  });
});
