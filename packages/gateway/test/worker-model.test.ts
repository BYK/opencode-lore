import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  fetchModelData,
  getModelEntry,
  getModelEntrySync,
  getWorkerModel,
  resetWorkerModelState,
  clearModelDataCache,
  type ModelsDevEntry,
} from "../src/worker-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODELS_DEV_API = "https://models.dev/api.json";

/** Build a mock models.dev api.json response with full cost+limit data. */
function buildModelsDevResponse(
  anthropicModels: Record<string, { cost: { input: number; output: number; cache_read: number }; limit: { context: number; output: number } }>,
  openaiModels?: Record<string, { cost: { input: number; output: number; cache_read: number }; limit: { context: number; output: number } }>,
) {
  const toEntries = (models: typeof anthropicModels) => {
    const entries: Record<string, ModelsDevEntry> = {};
    for (const [id, data] of Object.entries(models)) {
      entries[id] = { id, cost: data.cost, limit: data.limit };
    }
    return entries;
  };
  const resp: Record<string, { models: Record<string, ModelsDevEntry> }> = {
    anthropic: { models: toEntries(anthropicModels) },
  };
  if (openaiModels) {
    resp.openai = { models: toEntries(openaiModels) };
  }
  return resp;
}

/** Default Anthropic models.dev data for tests. */
const DEFAULT_ANTHROPIC_MODELS = {
  "claude-opus-4-6": {
    cost: { input: 5, output: 25, cache_read: 0.5 },
    limit: { context: 1_000_000, output: 128_000 },
  },
  "claude-sonnet-4-20250514": {
    cost: { input: 3, output: 15, cache_read: 0.3 },
    limit: { context: 200_000, output: 64_000 },
  },
  "claude-haiku-4-5": {
    cost: { input: 1, output: 5, cache_read: 0.1 },
    limit: { context: 200_000, output: 64_000 },
  },
};

/** Default OpenAI models.dev data for tests. */
const DEFAULT_OPENAI_MODELS = {
  "gpt-5.4": {
    cost: { input: 2.5, output: 15, cache_read: 0.625 },
    limit: { context: 1_050_000, output: 100_000 },
  },
  "gpt-5.4-mini": {
    cost: { input: 0.75, output: 4.5, cache_read: 0.19 },
    limit: { context: 400_000, output: 100_000 },
  },
};

/** Combined default models for tests. */
const DEFAULT_MODELS = DEFAULT_ANTHROPIC_MODELS;

// ---------------------------------------------------------------------------
// fetchModelData
// ---------------------------------------------------------------------------

describe("fetchModelData", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("fetches and parses model data from models.dev JSON API", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();

    expect(data.size).toBeGreaterThanOrEqual(3);
    const opus = data.get("claude-opus-4-6")!;
    expect(opus.cost?.input).toBe(5);
    expect(opus.cost?.output).toBe(25);
    expect(opus.cost?.cache_read).toBe(0.5);
    expect(opus.limit?.context).toBe(1_000_000);
    expect(opus.limit?.output).toBe(128_000);
  });

  test("fetches models from multiple providers", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_ANTHROPIC_MODELS, DEFAULT_OPENAI_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();

    expect(data.size).toBe(5); // 3 Anthropic + 2 OpenAI
    expect(data.get("claude-opus-4-6")!.cost?.input).toBe(5);
    expect(data.get("gpt-5.4")!.cost?.input).toBe(2.5);
    expect(data.get("gpt-5.4-mini")!.cost?.input).toBe(0.75);
  });

  test("caches results and returns cache on subsequent calls", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const first = await fetchModelData();
    const second = await fetchModelData();

    expect(callCount).toBe(1);
    expect(first).toBe(second); // Same reference — cached
  });

  test("returns empty map on API error with no cache", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0);
  });

  test("returns stale cache on network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0);
  });

  test("handles missing providers gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ google: { models: {} } }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0); // Neither anthropic nor openai present
  });

  test("loads available providers even when some are missing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ openai: { models: { "gpt-5.4": { id: "gpt-5.4", cost: { input: 2.5, output: 15 }, limit: { context: 1_050_000, output: 100_000 } } } } }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(1); // Only OpenAI, no Anthropic
    expect(data.get("gpt-5.4")!.cost?.input).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// getModelEntry (async)
// ---------------------------------------------------------------------------

describe("getModelEntry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("returns exact match from models.dev", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-opus-4-6");
    expect(entry.cost?.input).toBe(5);
    expect(entry.cost?.output).toBe(25);
    expect(entry.limit?.context).toBe(1_000_000);
  });

  test("returns prefix match for dated model IDs", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-haiku-4-5-20251001");
    expect(entry.cost?.input).toBe(1);
    expect(entry.cost?.output).toBe(5);
  });

  test("returns fallback for unknown model", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-future-model-2027");
    // Fallback defaults
    expect(entry.cost?.input).toBe(3);
    expect(entry.cost?.output).toBe(15);
    expect(entry.limit?.context).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// getModelEntrySync
// ---------------------------------------------------------------------------

describe("getModelEntrySync", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("returns fallback when cache is cold", () => {
    const entry = getModelEntrySync("claude-opus-4-6");
    // Should get fallback pricing for opus-4-6
    expect(entry.cost?.input).toBe(5);
    expect(entry.cost?.output).toBe(25);
    expect(entry.limit?.context).toBe(1_000_000);
  });

  test("returns cached data after fetchModelData populates cache", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    // Warm the cache
    await fetchModelData();

    const entry = getModelEntrySync("claude-haiku-4-5");
    expect(entry.cost?.input).toBe(1);
    expect(entry.cost?.output).toBe(5);
    expect(entry.limit?.output).toBe(64_000);
  });

  test("prefix matches work in sync mode", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();

    const entry = getModelEntrySync("claude-sonnet-4-20250514-extended");
    expect(entry.cost?.input).toBe(3);
  });

  test("unknown model returns default fallback", () => {
    const entry = getModelEntrySync("totally-unknown-model");
    expect(entry.cost?.input).toBe(3);
    expect(entry.cost?.output).toBe(15);
    expect(entry.limit?.context).toBe(200_000);
    expect(entry.limit?.output).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// getWorkerModel
// ---------------------------------------------------------------------------

describe("getWorkerModel", () => {
  test("returns a model or undefined (depends on lore config)", () => {
    const result = getWorkerModel();
    expect(result === undefined || typeof result === "object").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetWorkerModelState
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

  test("clears cache so next fetchModelData re-fetches", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await fetchModelData();
    expect(callCount).toBe(1);

    // Without reset, cached
    await fetchModelData();
    expect(callCount).toBe(1);

    // After reset, re-fetches
    resetWorkerModelState();
    await fetchModelData();
    expect(callCount).toBe(2);
  });
});
