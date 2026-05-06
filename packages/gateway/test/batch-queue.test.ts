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
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
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
const UPSTREAM = "https://api.anthropic.com";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchLLMClient", () => {
  test("urgent calls bypass the queue and delegate to inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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
    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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

    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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
    expect(fetchCalls[0]!.url).toBe(`${UPSTREAM}/v1/messages/batches`);
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

    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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

    const client = createBatchLLMClient(inner, UPSTREAM, () => null, DEFAULT_MODEL, {
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
    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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
    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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
    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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

    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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

    const client = createBatchLLMClient(inner, UPSTREAM, () => "test-key", DEFAULT_MODEL, {
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
});
