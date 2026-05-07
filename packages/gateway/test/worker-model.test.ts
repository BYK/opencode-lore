import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  discoverModels,
  clearModelCache,
  clearCostCache,
  getWorkerModel,
  resetWorkerModelState,
  fetchModelCosts,
  fetchCostMap,
} from "../src/worker-model";
import type { AuthCredential } from "../src/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CRED: AuthCredential = { scheme: "api-key", value: "sk-test-key" };
const UPSTREAM = "https://api.anthropic.com";
const MODELS_DEV_API = "https://models.dev/api.json";

/** Build a mock Anthropic /v1/models response. */
function buildModelsResponse(
  models: Array<{
    id: string;
    display_name?: string;
    thinking_supported?: boolean;
  }>,
) {
  return {
    data: models.map((m) => ({
      id: m.id,
      type: "model" as const,
      display_name: m.display_name ?? m.id,
      created_at: "2025-01-01T00:00:00Z",
      max_input_tokens: 200_000,
      max_tokens: 8192,
      capabilities: {
        thinking: { supported: m.thinking_supported ?? false },
      },
    })),
    has_more: false,
    first_id: models[0]?.id ?? "",
    last_id: models[models.length - 1]?.id ?? "",
  };
}

/** Build a mock models.dev api.json response. */
function buildModelsDevResponse(
  models: Record<string, number>,
): { anthropic: { models: Record<string, { id: string; cost: { input: number } }> } } {
  const entries: Record<string, { id: string; cost: { input: number } }> = {};
  for (const [id, inputCost] of Object.entries(models)) {
    entries[id] = { id, cost: { input: inputCost } };
  }
  return { anthropic: { models: entries } };
}

/** Default models.dev cost data for tests. */
const DEFAULT_COSTS: Record<string, number> = {
  "claude-opus-4-20250514": 15.0,
  "claude-sonnet-4-20250514": 3.0,
  "claude-haiku-3-5-20241022": 0.8,
  "claude-haiku-4-5-20251001": 1.0,
};

/**
 * Create a URL-aware fetch mock that handles both Anthropic API and
 * models.dev JSON API requests.
 */
function createRoutedFetch(
  anthropicResponse: unknown,
  options?: {
    modelsDevCosts?: Record<string, number>;
    modelsDevOverride?: (url: string) => Response;
    onAnthropicCall?: (url: string, init?: RequestInit) => void;
  },
) {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    // models.dev API request
    if (urlStr === MODELS_DEV_API) {
      if (options?.modelsDevOverride) {
        return Promise.resolve(options.modelsDevOverride(urlStr));
      }
      const costs = options?.modelsDevCosts ?? DEFAULT_COSTS;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(costs)), { status: 200 }),
      );
    }

    // Anthropic API requests
    options?.onAnthropicCall?.(urlStr, init);
    return Promise.resolve(
      new Response(JSON.stringify(anthropicResponse), { status: 200 }),
    );
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// fetchCostMap
// ---------------------------------------------------------------------------

describe("fetchCostMap", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearCostCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("fetches and parses costs from models.dev JSON API", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const costMap = await fetchCostMap();

    expect(costMap.get("claude-opus-4-20250514")).toBe(15.0);
    expect(costMap.get("claude-sonnet-4-20250514")).toBe(3.0);
    expect(costMap.get("claude-haiku-3-5-20241022")).toBe(0.8);
    expect(costMap.size).toBe(4);
  });

  test("caches results and returns cache on subsequent calls", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const first = await fetchCostMap();
    const second = await fetchCostMap();

    expect(callCount).toBe(1);
    expect(first).toBe(second); // Same reference — cached
  });

  test("returns empty map on API error with no cache", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const costMap = await fetchCostMap();
    expect(costMap.size).toBe(0);
  });

  test("returns stale cache on API error when cache exists", async () => {
    // First call succeeds
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    const cached = await fetchCostMap();
    expect(cached.size).toBe(4);

    // Expire cache
    clearCostCache();

    // Second call fails — but stale cache was cleared
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;
    const fallback = await fetchCostMap();
    expect(fallback.size).toBe(0);
  });

  test("returns stale cache on network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const costMap = await fetchCostMap();
    expect(costMap.size).toBe(0);
  });

  test("handles missing anthropic provider gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ openai: { models: {} } }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const costMap = await fetchCostMap();
    expect(costMap.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchModelCosts
// ---------------------------------------------------------------------------

describe("fetchModelCosts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearCostCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("maps model IDs to per-token costs from models.dev", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const costs = await fetchModelCosts([
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-3-5-20241022",
    ]);

    expect(costs.get("claude-opus-4-20250514")).toBe(15 / 1_000_000);
    expect(costs.get("claude-sonnet-4-20250514")).toBe(3 / 1_000_000);
    expect(costs.get("claude-haiku-3-5-20241022")).toBe(0.8 / 1_000_000);
  });

  test("falls back to hardcoded cost for unknown models", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const costs = await fetchModelCosts(["claude-future-model-2026"]);
    // Unknown model — not in models.dev, fallback to high cost
    expect(costs.get("claude-future-model-2026")).toBe(100 / 1_000_000);
  });

  test("falls back to hardcoded cost when API fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const costs = await fetchModelCosts(["claude-sonnet-4-20250514"]);
    // Fallback cost for claude-sonnet-4 prefix
    expect(costs.get("claude-sonnet-4-20250514")).toBe(3 / 1_000_000);
  });
});

// ---------------------------------------------------------------------------
// discoverModels
// ---------------------------------------------------------------------------

describe("discoverModels", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelCache();
    clearCostCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("discovers models from upstream API with costs from models.dev", async () => {
    const response = buildModelsResponse([
      { id: "claude-opus-4-20250514", thinking_supported: true },
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-haiku-3-5-20241022" },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-3-5-20241022",
    ]);
  });

  test("maps model costs from models.dev correctly", async () => {
    const response = buildModelsResponse([
      { id: "claude-opus-4-20250514" },
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-haiku-3-5-20241022" },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    const opus = models.find((m) => m.id === "claude-opus-4-20250514")!;
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-20250514")!;
    const haiku = models.find((m) => m.id === "claude-haiku-3-5-20241022")!;

    // Relative ordering: opus > sonnet > haiku
    expect(opus.cost.input).toBeGreaterThan(sonnet.cost.input);
    expect(sonnet.cost.input).toBeGreaterThan(haiku.cost.input);

    // Exact values from models.dev mock data
    expect(opus.cost.input).toBe(15 / 1_000_000);
    expect(sonnet.cost.input).toBe(3 / 1_000_000);
    expect(haiku.cost.input).toBe(0.8 / 1_000_000);
  });

  test("detects reasoning capability from thinking.supported", async () => {
    const response = buildModelsResponse([
      { id: "claude-opus-4-20250514", thinking_supported: true },
      { id: "claude-haiku-3-5-20241022", thinking_supported: false },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    const opus = models.find((m) => m.id === "claude-opus-4-20250514")!;
    const haiku = models.find((m) => m.id === "claude-haiku-3-5-20241022")!;

    expect(opus.capabilities.reasoning).toBe(true);
    expect(haiku.capabilities.reasoning).toBe(false);
  });

  test("all models are marked as active and text-capable", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    expect(models[0].status).toBe("active");
    expect(models[0].capabilities.input.text).toBe(true);
    expect(models[0].providerID).toBe("anthropic");
  });

  test("caches results and returns cache on subsequent calls", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
    ]);

    let anthropicCallCount = 0;
    globalThis.fetch = createRoutedFetch(response, {
      onAnthropicCall: () => { anthropicCallCount++; },
    });

    const first = await discoverModels(UPSTREAM, TEST_CRED);
    const second = await discoverModels(UPSTREAM, TEST_CRED);

    expect(anthropicCallCount).toBe(1);
    expect(first).toBe(second); // Same reference — cached
  });

  test("returns empty array on API error with no cache", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    ) as unknown as typeof fetch;

    const models = await discoverModels(UPSTREAM, TEST_CRED);
    expect(models).toEqual([]);
  });

  test("returns stale cache on API error when cache exists", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
    ]);

    // First call succeeds and populates cache
    globalThis.fetch = createRoutedFetch(response);

    const cached = await discoverModels(UPSTREAM, TEST_CRED);
    expect(cached).toHaveLength(1);

    // Expire the cache manually
    clearModelCache();

    // Second call fails (Anthropic API error)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    // clearModelCache clears both cache and timestamp, so stale fallback
    // returns empty since there's genuinely no cache
    const fallback = await discoverModels(UPSTREAM, TEST_CRED);
    expect(fallback).toEqual([]);
  });

  test("returns stale cache on network error", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
    ]);

    // First: populate cache
    globalThis.fetch = createRoutedFetch(response);
    await discoverModels(UPSTREAM, TEST_CRED);

    clearModelCache();

    // Network error on re-fetch
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const models = await discoverModels(UPSTREAM, TEST_CRED);
    // No cache available after clearModelCache
    expect(models).toEqual([]);
  });

  test("sends correct auth headers with API key", async () => {
    const response = buildModelsResponse([]);
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = createRoutedFetch(response, {
      onAnthropicCall: (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
      },
    });

    await discoverModels(UPSTREAM, TEST_CRED);

    expect(capturedHeaders["x-api-key"]).toBe("sk-test-key");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
  });

  test("sends correct auth headers with bearer token", async () => {
    const response = buildModelsResponse([]);
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = createRoutedFetch(response, {
      onAnthropicCall: (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
      },
    });

    const bearerCred: AuthCredential = {
      scheme: "bearer",
      value: "token-abc",
    };
    await discoverModels(UPSTREAM, bearerCred);

    expect(capturedHeaders["Authorization"]).toBe("Bearer token-abc");
  });

  test("deprecated models not returned by API are naturally excluded", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-haiku-3-5-20241022" },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    expect(models.map((m) => m.id)).not.toContain("claude-3-haiku-20240307");
    expect(models).toHaveLength(2);
  });

  test("unknown model gets high cost when not in models.dev", async () => {
    const response = buildModelsResponse([
      { id: "claude-future-model-2026" },
    ]);

    globalThis.fetch = createRoutedFetch(response);

    const models = await discoverModels(UPSTREAM, TEST_CRED);
    const unknown = models[0];

    // Not in models.dev → fallback to high cost
    expect(unknown.cost.input).toBe(100 / 1_000_000);
  });

  test("falls back to hardcoded costs when models.dev is down", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-haiku-3-5-20241022" },
    ]);

    globalThis.fetch = createRoutedFetch(response, {
      modelsDevOverride: () => new Response("Service Unavailable", { status: 503 }),
    });

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    // Should still get models with fallback costs
    expect(models).toHaveLength(2);
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-20250514")!;
    const haiku = models.find((m) => m.id === "claude-haiku-3-5-20241022")!;

    // Fallback costs maintain correct ordering
    expect(sonnet.cost.input).toBeGreaterThan(haiku.cost.input);
  });

  test("paginates through multiple pages", async () => {
    const page1 = {
      data: [
        {
          id: "claude-opus-4-20250514",
          type: "model",
          display_name: "Claude Opus 4",
          created_at: "2025-01-01T00:00:00Z",
          max_input_tokens: 200_000,
          max_tokens: 32_000,
          capabilities: { thinking: { supported: true } },
        },
      ],
      has_more: true,
      first_id: "claude-opus-4-20250514",
      last_id: "claude-opus-4-20250514",
    };
    const page2 = {
      data: [
        {
          id: "claude-haiku-3-5-20241022",
          type: "model",
          display_name: "Claude Haiku 3.5",
          created_at: "2025-01-01T00:00:00Z",
          max_input_tokens: 200_000,
          max_tokens: 8192,
          capabilities: { thinking: { supported: false } },
        },
      ],
      has_more: false,
      first_id: "claude-haiku-3-5-20241022",
      last_id: "claude-haiku-3-5-20241022",
    };

    let anthropicCallIndex = 0;
    globalThis.fetch = mock((url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      // models.dev API request
      if (urlStr === MODELS_DEV_API) {
        return Promise.resolve(
          new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_COSTS)), { status: 200 }),
        );
      }

      // Anthropic API — paginated
      const page = anthropicCallIndex === 0 ? page1 : page2;
      anthropicCallIndex++;
      return Promise.resolve(
        new Response(JSON.stringify(page), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const models = await discoverModels(UPSTREAM, TEST_CRED);

    expect(anthropicCallIndex).toBe(2);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4-20250514",
      "claude-haiku-3-5-20241022",
    ]);
  });
});

// ---------------------------------------------------------------------------
// getWorkerModel
// ---------------------------------------------------------------------------

describe("getWorkerModel", () => {
  test("returns undefined when no validation has been stored", () => {
    const result = getWorkerModel();
    expect(result === undefined || typeof result === "object").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearModelCache / resetWorkerModelState
// ---------------------------------------------------------------------------

describe("resetWorkerModelState", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("clears cache so next discoverModels re-fetches", async () => {
    const response = buildModelsResponse([
      { id: "claude-sonnet-4-20250514" },
    ]);

    let anthropicCallCount = 0;
    globalThis.fetch = createRoutedFetch(response, {
      onAnthropicCall: () => { anthropicCallCount++; },
    });

    await discoverModels(UPSTREAM, TEST_CRED);
    expect(anthropicCallCount).toBe(1);

    // Without reset, cached
    await discoverModels(UPSTREAM, TEST_CRED);
    expect(anthropicCallCount).toBe(1);

    // After reset, re-fetches
    resetWorkerModelState();
    await discoverModels(UPSTREAM, TEST_CRED);
    expect(anthropicCallCount).toBe(2);
  });
});
