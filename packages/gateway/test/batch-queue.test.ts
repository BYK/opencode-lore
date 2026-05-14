/**
 * Tests for the batch queue (BatchLLMClient wrapper).
 *
 * Uses a fake inner LLMClient and fake fetch to verify:
 *  - Urgent calls bypass the queue
 *  - Non-urgent calls are queued and flushed
 *  - Batch results are polled and promises resolved
 *  - Fallback to synchronous on batch API errors
 *  - Shutdown drains the queue
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createBatchLLMClient, type BatchStats } from "../src/batch-queue";
import type { LLMClient } from "@loreai/core";
import type { AuthCredential } from "../src/auth";

const TEST_AUTH: AuthCredential = { scheme: "api-key", value: "test-key" };
const getTestAuth = () => TEST_AUTH;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock LLMClient that records calls and returns canned responses. */
function createMockLLMClient(): LLMClient & { calls: Array<{ system: string; user: string; opts: unknown }> } {
  const calls: Array<{ system: string; user: string; opts: unknown }> = [];
  return {
    calls,
    async prompt(system, user, opts) {
      calls.push({ system, user, opts });
      return `sync-response-for: ${user.slice(0, 30)}`;
    },
  };
}

/** Shape of the batch create request body for typed assertions. */
interface BatchCreateBody {
  requests: Array<{
    custom_id: string;
    params: {
      model: string;
      max_tokens: number;
      system: string | Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
  }>;
}

/** Track fetch calls for assertions. */
let fetchCalls: Array<{ url: string; method: string; body?: BatchCreateBody }> = [];
let fetchResponses: Array<{ ok: boolean; status: number; body: unknown }> = [];

function pushFetchResponse(ok: boolean, status: number, body: unknown) {
  fetchResponses.push({ ok, status, body });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];

  // @ts-expect-error — mock global fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // FormData bodies (OpenAI file uploads) can't be JSON-parsed
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    fetchCalls.push({ url: url.toString(), method, body });

    const response = fetchResponses.shift();
    if (!response) {
      return { ok: false, status: 500, text: async () => "no mock response", json: async () => ({}) };
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.ok ? "OK" : "Error",
      text: async () => JSON.stringify(response.body),
      json: async () => response.body,
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DEFAULT_MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" };
const UPSTREAMS = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchLLMClient", () => {
  test("urgent calls bypass the queue and delegate to inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000, // Long interval so flush doesn't auto-trigger
    });

    const result = await client.prompt("system", "urgent message", {
      workerID: "lore-distill",
      urgent: true,
    });

    expect(result).toBe("sync-response-for: urgent message");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].user).toBe("urgent message");

    const s = client.stats();
    expect(s.totalUrgent).toBe(1);
    expect(s.totalQueued).toBe(0);
    expect(s.queued).toBe(0);

    await client.shutdown();
  });

  test("non-urgent calls are queued (not immediately sent to inner)", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
    });

    // Don't await — the promise is pending until batch resolves
    const promise = client.prompt("system", "background work", {
      workerID: "lore-distill",
    });

    // Inner client should NOT have been called yet
    expect(inner.calls).toHaveLength(0);

    const s = client.stats();
    expect(s.queued).toBe(1);
    expect(s.totalQueued).toBe(1);

    // Shutdown will fallback to synchronous
    await client.shutdown();

    // Now the promise should resolve (via fallback)
    const result = await promise;
    expect(result).toBe("sync-response-for: background work");
    expect(inner.calls).toHaveLength(1);
  });

  test("auto-flush when queue reaches maxQueueSize", async () => {
    const inner = createMockLLMClient();

    // Set up batch create response
    pushFetchResponse(true, 200, {
      id: "msgbatch_test1",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 3,
      pollIntervalMs: 60_000,
    });

    // Queue 3 items — should auto-flush on the 3rd
    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-distill" });
    const p3 = client.prompt("sys", "msg3", { workerID: "lore-distill" });

    // Wait a tick for the flush to complete
    await new Promise((r) => setTimeout(r, 50));

    // Should have called the batch API
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`${UPSTREAMS.anthropic}/v1/messages/batches`);
    expect(fetchCalls[0]!.method).toBe("POST");
    expect(fetchCalls[0]!.body!.requests).toHaveLength(3);

    const s = client.stats();
    expect(s.totalBatched).toBe(3);
    expect(s.inflightBatches).toBe(1);

    // Clean up — shutdown resolves remaining promises with null
    await client.shutdown();
  });

  test("fallback to synchronous when batch API returns error", async () => {
    const inner = createMockLLMClient();

    // Set up batch create to fail
    pushFetchResponse(false, 500, { error: "internal server error" });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 2,
    });

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-distill" });

    // Wait for auto-flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const r1 = await p1;
    const r2 = await p2;

    expect(r1).toBe("sync-response-for: msg1");
    expect(r2).toBe("sync-response-for: msg2");

    // Inner should have been called for both (fallback)
    expect(inner.calls).toHaveLength(2);

    const s = client.stats();
    expect(s.totalFallback).toBe(2);

    await client.shutdown();
  });

  test("fallback to synchronous when no API key", async () => {
    const inner = createMockLLMClient();

    const client = createBatchLLMClient(inner, UPSTREAMS, () => null, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
    });

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });

    // Wait for flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const result = await p1;
    expect(result).toBe("sync-response-for: msg1");
    expect(inner.calls).toHaveLength(1);

    await client.shutdown();
  });

  test("shutdown drains queue synchronously via inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
    });

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-curator" });

    // Shutdown should drain via fallback
    await client.shutdown();

    expect(await p1).toBe("sync-response-for: msg1");
    expect(await p2).toBe("sync-response-for: msg2");
    expect(inner.calls).toHaveLength(2);

    const s = client.stats();
    expect(s.totalFallback).toBe(2);
  });

  test("after shutdown, new calls go directly to inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
    });

    await client.shutdown();

    // New call after shutdown should go through inner immediately (treated as urgent)
    const result = await client.prompt("sys", "post-shutdown", {
      workerID: "lore-distill",
    });

    expect(result).toBe("sync-response-for: post-shutdown");
    expect(inner.calls).toHaveLength(1);
  });

  test("stats reflect accurate counts", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
    });

    // 2 urgent, 3 queued
    await client.prompt("sys", "urgent1", { urgent: true });
    await client.prompt("sys", "urgent2", { urgent: true });
    const p1 = client.prompt("sys", "bg1", {});
    const p2 = client.prompt("sys", "bg2", {});
    const p3 = client.prompt("sys", "bg3", {});

    let s = client.stats();
    expect(s.totalUrgent).toBe(2);
    expect(s.totalQueued).toBe(3);
    expect(s.queued).toBe(3);
    expect(s.inflightBatches).toBe(0);

    await client.shutdown();

    s = client.stats();
    expect(s.totalFallback).toBe(3);
    expect(s.queued).toBe(0);
  });

  test("default model is used when no explicit model in opts", async () => {
    const inner = createMockLLMClient();

    // Set up batch create response
    pushFetchResponse(true, 200, {
      id: "msgbatch_model_test",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
    });

    client.prompt("sys prompt", "user msg", { workerID: "lore-distill" });

    // Wait for auto-flush
    await new Promise((r) => setTimeout(r, 50));

    // Verify the batch request uses the default model
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]!.body!;
    const req0 = body.requests[0]!;
    expect(req0.params.model).toBe("claude-sonnet-4-20250514");
    const sys = req0.params.system as Array<{ type: string; text: string }>;
    expect(sys[0]!.text).toBe("sys prompt");
    expect(req0.params.messages[0]!.content).toBe("user msg");

    await client.shutdown();
  });

  test("explicit model override is used in batch request", async () => {
    const inner = createMockLLMClient();

    pushFetchResponse(true, 200, {
      id: "msgbatch_override",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
    });

    client.prompt("sys", "msg", {
      model: { providerID: "anthropic", modelID: "claude-haiku-3-5-20241022" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls[0]!.body!.requests[0]!.params.model).toBe("claude-haiku-3-5-20241022");

    await client.shutdown();
  });

  // -------------------------------------------------------------------------
  // OpenAI batch queue tests
  // -------------------------------------------------------------------------

  test("OpenAI items are grouped separately from Anthropic items", async () => {
    const inner = createMockLLMClient();

    // Response for Anthropic batch submit
    pushFetchResponse(true, 200, {
      id: "msgbatch_anthropic",
      processing_status: "in_progress",
    });
    // Response for OpenAI file upload
    pushFetchResponse(true, 200, { id: "file-abc123" });
    // Response for OpenAI batch create
    pushFetchResponse(true, 200, { id: "batch_openai1" });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 2,
    });

    // Queue one Anthropic item
    client.prompt("sys", "anthropic-msg", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });
    // Queue one OpenAI item — triggers auto-flush at maxQueueSize=2
    client.prompt("sys", "openai-msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    });

    // Wait for flush
    await new Promise((r) => setTimeout(r, 100));

    // Should have 3 fetch calls: Anthropic batch, OpenAI file upload, OpenAI batch create
    expect(fetchCalls).toHaveLength(3);

    // First call: Anthropic batch submission
    expect(fetchCalls[0]!.url).toBe(`${UPSTREAMS.anthropic}/v1/messages/batches`);
    expect(fetchCalls[0]!.method).toBe("POST");

    // Second call: OpenAI file upload (FormData — body won't be JSON-parsed)
    expect(fetchCalls[1]!.url).toBe(`${UPSTREAMS.openai}/v1/files`);
    expect(fetchCalls[1]!.method).toBe("POST");

    // Third call: OpenAI batch creation
    expect(fetchCalls[2]!.url).toBe(`${UPSTREAMS.openai}/v1/batches`);
    expect(fetchCalls[2]!.method).toBe("POST");

    const s = client.stats();
    expect(s.totalBatched).toBe(2);
    expect(s.inflightBatches).toBe(2);

    await client.shutdown();
  });

  test("OpenAI batch failure falls back to inner client", async () => {
    const inner = createMockLLMClient();

    // OpenAI file upload fails
    pushFetchResponse(false, 500, { error: "internal server error" });

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
    });

    const p1 = client.prompt("sys", "openai-msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
    });

    // Wait for flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const result = await p1;
    expect(result).toBe("sync-response-for: openai-msg");
    expect(inner.calls).toHaveLength(1);

    const s = client.stats();
    expect(s.totalFallback).toBe(1);

    await client.shutdown();
  });

  test("OpenAI batch lifecycle: upload → create → poll → results", async () => {
    const inner = createMockLLMClient();

    // Use a custom fetch mock to control the entire lifecycle in order
    let capturedCustomId = "";
    const prevFetch = globalThis.fetch;
    let callIndex = 0;

    // @ts-expect-error — mock fetch
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const idx = callIndex++;

      // 0: File upload
      if (idx === 0) {
        expect(String(url)).toContain("/v1/files");
        // Extract custom_id from the JSONL for later
        if (init?.body instanceof FormData) {
          const file = init.body.get("file") as Blob;
          const text = await file.text();
          const parsed = JSON.parse(text);
          capturedCustomId = parsed.custom_id;
        }
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ id: "file-batch123" }),
          json: async () => ({ id: "file-batch123" }),
        };
      }

      // 1: Batch create
      if (idx === 1) {
        expect(String(url)).toContain("/v1/batches");
        expect(method).toBe("POST");
        const body = JSON.parse(init?.body as string);
        expect(body.input_file_id).toBe("file-batch123");
        expect(body.endpoint).toBe("/v1/chat/completions");
        expect(body.completion_window).toBe("24h");
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ id: "batch_lifecycle" }),
          json: async () => ({ id: "batch_lifecycle" }),
        };
      }

      // 2: Poll — return completed
      if (idx === 2) {
        expect(String(url)).toContain("/v1/batches/batch_lifecycle");
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ status: "completed", output_file_id: "file-results" }),
          json: async () => ({ status: "completed", output_file_id: "file-results" }),
        };
      }

      // 3: Download results
      if (idx === 3) {
        expect(String(url)).toContain("/v1/files/file-results/content");
        const resultsJsonl = JSON.stringify({
          custom_id: capturedCustomId,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: "OpenAI batch result" } }],
              model: "gpt-5.4-mini",
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            },
          },
        });
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => resultsJsonl,
          json: async () => JSON.parse(resultsJsonl),
        };
      }

      return { ok: false, status: 500, text: async () => "unexpected", json: async () => ({}) };
    };

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
      pollIntervalMs: 50, // Fast polling for test
    });

    const promise = client.prompt("sys prompt", "user msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
    });

    // Wait for flush + poll + results
    await new Promise((r) => setTimeout(r, 300));

    const result = await promise;
    expect(result).toBe("OpenAI batch result");

    const s = client.stats();
    expect(s.totalBatched).toBe(1);
    expect(s.totalResolved).toBe(1);

    globalThis.fetch = prevFetch;
    await client.shutdown();
  });

  test("OpenAI items use system as message role, not block array", async () => {
    const inner = createMockLLMClient();

    // We need to capture the JSONL content from the file upload.
    // Override fetch to capture FormData body content.
    let capturedJsonl = "";
    const prevFetch = globalThis.fetch;

    // @ts-expect-error — mock fetch to capture FormData
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";

      // For file upload, capture the FormData body
      if (typeof url === "string" && url.includes("/v1/files") && init?.body instanceof FormData) {
        const formData = init.body as FormData;
        const file = formData.get("file") as Blob;
        if (file) {
          capturedJsonl = await file.text();
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-test" }),
          json: async () => ({ id: "file-test" }),
        };
      }

      // For batch create, return success
      if (typeof url === "string" && url.includes("/v1/batches") && method === "POST") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch-test" }),
          json: async () => ({ id: "batch-test" }),
        };
      }

      // Default
      return { ok: false, status: 500, text: async () => "unexpected", json: async () => ({}) };
    };

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, DEFAULT_MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
    });

    client.prompt("my system prompt", "my user message", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    });

    // Wait for flush
    await new Promise((r) => setTimeout(r, 100));

    // Parse the captured JSONL
    expect(capturedJsonl).not.toBe("");
    const line = JSON.parse(capturedJsonl) as {
      custom_id: string;
      method: string;
      url: string;
      body: {
        model: string;
        max_completion_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    };

    // Verify JSONL structure
    expect(line.method).toBe("POST");
    expect(line.url).toBe("/v1/chat/completions");
    expect(line.body.model).toBe("gpt-5.4-mini");
    expect(line.body.max_completion_tokens).toBe(8192);

    // System should be converted to a message, not a block array
    expect(line.body.messages).toHaveLength(2);
    expect(line.body.messages[0]).toEqual({ role: "system", content: "my system prompt" });
    expect(line.body.messages[1]).toEqual({ role: "user", content: "my user message" });

    // Restore original mock
    globalThis.fetch = prevFetch;

    await client.shutdown();
  });
});
