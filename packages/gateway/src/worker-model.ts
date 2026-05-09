/**
 * Gateway model pricing and resolution.
 *
 * Fetches per-model pricing from models.dev (open-source model database)
 * for cost estimation in Sentry metrics and gradient cost-aware capping.
 *
 * Worker model resolution delegates to core's simple chain:
 *   explicit config override > session model fallback.
 */

import {
  workerModel,
  config as loreConfig,
  log,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// Cost lookup — models.dev
// ---------------------------------------------------------------------------

/**
 * models.dev JSON API endpoint — returns all providers/models with pricing.
 *
 * Single request replaces N individual TOML fetches. Response shape:
 *   { anthropic: { models: { "claude-sonnet-4-20250514": { cost: { input: 3, output: 15, cache_read: 0.3 }, limit: { context: 200000, output: 64000 } }, ... } } }
 * Cost values are per-million-token USD. Limit values are token counts.
 */
const MODELS_DEV_API = "https://models.dev/api.json";

/** Cached models.dev data: full model entries for Anthropic. */
let cachedModelData: Map<string, ModelsDevEntry> | null = null;
let cachedModelDataAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Shape of a model entry in the models.dev JSON API. */
export type ModelsDevEntry = {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
};

/** Shape of the models.dev JSON API response (subset we care about). */
type ModelsDevResponse = {
  [provider: string]: {
    models?: { [modelId: string]: ModelsDevEntry };
  };
};

/**
 * Hardcoded fallback costs (per-million-token, USD) used when models.dev
 * API is unreachable. Prefix-matched against model IDs.
 */
const FALLBACK_PRICING: Array<{
  prefix: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  context: number;
  outputLimit: number;
}> = [
  { prefix: "claude-opus-4-6", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, context: 1_000_000, outputLimit: 128_000 },
  { prefix: "claude-opus-4-5", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, context: 200_000, outputLimit: 64_000 },
  { prefix: "claude-opus-4", input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, context: 200_000, outputLimit: 32_000 },
  { prefix: "claude-sonnet-4-6", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 1_000_000, outputLimit: 64_000 },
  { prefix: "claude-sonnet-4", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 200_000, outputLimit: 64_000 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, context: 200_000, outputLimit: 64_000 },
  { prefix: "claude-haiku-3-5", input: 0.8, output: 4, cache_read: 0.08, cache_write: 1.0, context: 200_000, outputLimit: 8_192 },
  { prefix: "claude-sonnet-3-5", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 200_000, outputLimit: 8_192 },
  { prefix: "claude-3-haiku", input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.3125, context: 200_000, outputLimit: 4_096 },
  { prefix: "claude-3-sonnet", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 200_000, outputLimit: 4_096 },
  { prefix: "claude-3-opus", input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, context: 200_000, outputLimit: 4_096 },
];

function fallbackEntry(modelID: string): ModelsDevEntry {
  for (const fb of FALLBACK_PRICING) {
    if (modelID.startsWith(fb.prefix)) {
      return {
        id: modelID,
        cost: { input: fb.input, output: fb.output, cache_read: fb.cache_read, cache_write: fb.cache_write },
        limit: { context: fb.context, output: fb.outputLimit },
      };
    }
  }
  // Unknown model — assume mid-range so metrics are roughly correct
  return {
    id: modelID,
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    limit: { context: 200_000, output: 8_192 },
  };
}

/**
 * Fetch model data from models.dev for Anthropic models.
 *
 * Single HTTP request, cached for 1 hour. Returns a map of
 * modelID → entry with cost and limit data.
 */
export async function fetchModelData(): Promise<Map<string, ModelsDevEntry>> {
  // Return cache if fresh
  if (cachedModelData && Date.now() - cachedModelDataAt < CACHE_TTL_MS) {
    return cachedModelData;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(MODELS_DEV_API, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      log.warn(`models.dev API failed: ${response.status} ${response.statusText}`);
      return cachedModelData ?? new Map();
    }

    const data = (await response.json()) as ModelsDevResponse;
    const anthropic = data.anthropic?.models;
    if (!anthropic) {
      log.warn("models.dev API: no anthropic provider found");
      return cachedModelData ?? new Map();
    }

    const modelData = new Map<string, ModelsDevEntry>();
    for (const [modelId, entry] of Object.entries(anthropic)) {
      const e: ModelsDevEntry = { ...entry, id: modelId };
      // Compute cache_write cost if not provided (Anthropic: 1.25× input price)
      if (e.cost && e.cost.cache_write == null && e.cost.input != null) {
        e.cost.cache_write = e.cost.input * 1.25;
      }
      modelData.set(modelId, e);
    }

    cachedModelData = modelData;
    cachedModelDataAt = Date.now();

    log.info(`models.dev: loaded data for ${modelData.size} anthropic models`);
    return modelData;
  } catch (e) {
    log.warn("models.dev API error:", e);
    return cachedModelData ?? new Map();
  }
}

/**
 * Look up model data by ID, with prefix matching and fallback.
 *
 * First tries exact match, then prefix match (e.g. "claude-opus-4-6-20260101"
 * matches "claude-opus-4-6"), then falls back to hardcoded defaults.
 */
export async function getModelEntry(modelID: string): Promise<ModelsDevEntry> {
  const data = await fetchModelData();

  // Exact match
  const exact = data.get(modelID);
  if (exact) return exact;

  // Prefix match: find the entry whose ID is a prefix of the requested model
  for (const [id, entry] of data) {
    if (modelID.startsWith(id)) return entry;
  }

  // Reverse prefix: find if the requested model is a prefix of any entry
  for (const [id, entry] of data) {
    if (id.startsWith(modelID)) return entry;
  }

  return fallbackEntry(modelID);
}

/**
 * Synchronous model entry lookup — reads from the in-memory cache only.
 *
 * Use this on the hot request path where async is impractical. Returns
 * fallback defaults if the cache hasn't been populated yet (e.g. before
 * the first `fetchModelData()` call completes). Pre-warm the cache by
 * calling `fetchModelData()` during gateway init.
 */
export function getModelEntrySync(modelID: string): ModelsDevEntry {
  if (!cachedModelData) return fallbackEntry(modelID);

  // Exact match
  const exact = cachedModelData.get(modelID);
  if (exact) return exact;

  // Prefix match
  for (const [id, entry] of cachedModelData) {
    if (modelID.startsWith(id)) return entry;
  }

  // Reverse prefix
  for (const [id, entry] of cachedModelData) {
    if (id.startsWith(modelID)) return entry;
  }

  return fallbackEntry(modelID);
}

/** Clear cached data (for testing). */
export function clearModelDataCache(): void {
  cachedModelData = null;
  cachedModelDataAt = 0;
}

// ---------------------------------------------------------------------------
// Resolution — wrapper around core's resolveWorkerModel
// ---------------------------------------------------------------------------

/**
 * Cost-aware default: when the session model costs ≥$5/M input (opus tier),
 * default background workers to sonnet-4 which produces equivalent-quality
 * distillations at ~60% lower cost. The user can always override via the
 * explicit `workerModel` config.
 */
const SONNET_WORKER_DEFAULT = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" };
const EXPENSIVE_MODEL_THRESHOLD = 5; // $/M input tokens

/**
 * Resolve the effective worker model for background calls.
 *
 * Checks (in order):
 *  1. Explicit config override (`workerModel` in lore config)
 *  2. Cost-aware default (sonnet-4 when session model is ≥$5/M input)
 *  3. Config model fallback (session model)
 */
export function getWorkerModel(): { providerID: string; modelID: string } | undefined {
  const cfg = loreConfig();

  // Determine if the session model is expensive enough to warrant a cheaper worker
  let costAwareDefault: { providerID: string; modelID: string } | undefined;
  if (cfg.model?.modelID) {
    const entry = getModelEntrySync(cfg.model.modelID);
    const inputCost = entry.cost?.input ?? 3;
    if (inputCost >= EXPENSIVE_MODEL_THRESHOLD) {
      // Don't downgrade if the session model IS already sonnet or cheaper
      if (!cfg.model.modelID.includes("sonnet") && !cfg.model.modelID.includes("haiku")) {
        costAwareDefault = SONNET_WORKER_DEFAULT;
      }
    }
  }

  return workerModel.resolveWorkerModel(
    "anthropic",
    cfg.workerModel,
    cfg.model,
    costAwareDefault,
  );
}

/** Reset module state (for testing). */
export function resetWorkerModelState(): void {
  clearModelDataCache();
}
