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

/** Cached models.dev data: model entries for all supported providers. */
let cachedModelData: Map<string, ModelsDevEntry> | null = null;
let cachedModelDataAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Providers to fetch pricing data for from models.dev. */
const SUPPORTED_PROVIDERS = ["anthropic", "openai"] as const;

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
 * Minimal fallback costs (per-million-token, USD) used when models.dev
 * API is unreachable. Only includes models involved in worker selection
 * decisions — everything else uses the generic unknown-model default.
 *
 * Dynamic pricing from models.dev is the primary source; these are a
 * safety net for offline/unreachable scenarios.
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
  // Session models that trigger cost-aware worker selection (input ≥ $1.50/M)
  { prefix: "claude-opus-4", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, context: 1_000_000, outputLimit: 128_000 },
  { prefix: "gpt-5.4", input: 2.5, output: 15, cache_read: 0.625, cache_write: 3.125, context: 1_050_000, outputLimit: 100_000 },
  { prefix: "gpt-5.5", input: 5, output: 30, cache_read: 1.25, cache_write: 6.25, context: 1_050_000, outputLimit: 100_000 },
  // Worker model defaults
  { prefix: "claude-sonnet-4", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 1_000_000, outputLimit: 64_000 },
  { prefix: "gpt-5.4-mini", input: 0.75, output: 4.5, cache_read: 0.19, cache_write: 0.94, context: 400_000, outputLimit: 100_000 },
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
 * Fetch model data from models.dev for supported providers.
 *
 * Single HTTP request, cached for 1 hour. Returns a map of
 * modelID → entry with cost and limit data across all supported providers.
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
    const modelData = new Map<string, ModelsDevEntry>();

    for (const providerName of SUPPORTED_PROVIDERS) {
      const providerModels = data[providerName]?.models;
      if (!providerModels) {
        log.warn(`models.dev API: no ${providerName} provider found`);
        continue;
      }

      for (const [modelId, entry] of Object.entries(providerModels)) {
        const e: ModelsDevEntry = { ...entry, id: modelId };
        // Compute cache_write cost if not provided (typically 1.25× input price)
        if (e.cost && e.cost.cache_write == null && e.cost.input != null) {
          e.cost.cache_write = e.cost.input * 1.25;
        }
        modelData.set(modelId, e);
      }
    }

    cachedModelData = modelData;
    cachedModelDataAt = Date.now();

    log.info(`models.dev: loaded data for ${modelData.size} models across ${SUPPORTED_PROVIDERS.join(", ")}`);
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
 * Cost-aware worker model defaults per provider family.
 *
 * When the session model costs ≥ EXPENSIVE_MODEL_THRESHOLD, background workers
 * (distillation, curation, query expansion) use a cheaper model from the same
 * provider family. Each mapping was validated via A/B testing on large
 * conversation segments (22 msgs, complex debugging with corrections).
 *
 * Validated pairs (observation counts on large segment):
 *   Anthropic:  Opus 4.6 (23 obs) → Sonnet 4.6 (25 obs)  — quality parity
 *   OpenAI:     GPT-5.4  (24 obs) → GPT-5.4-mini (24 obs) — exact match
 *
 * Disqualified (>20% observation loss):
 *   Google:     Gemini 3.1 Pro (20 obs) → Gemini 3 Flash (13 obs) — -35% drop
 *
 * Untested (API returned no response via OpenCode SDK):
 *   xAI, Mistral — fall back to session model
 */
const WORKER_DEFAULTS: Record<string, { providerID: string; modelID: string; alreadyCheap: (id: string) => boolean }> = {
  // Anthropic: sonnet-4-6 matches opus quality on distillation at 40% lower cost
  anthropic: {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    alreadyCheap: (id) => id.includes("sonnet") || id.includes("haiku"),
  },
  // OpenAI: gpt-5.4-mini matched gpt-5.4 exactly (24 obs each) at 70% lower cost
  openai: {
    providerID: "openai",
    modelID: "gpt-5.4-mini",
    alreadyCheap: (id) => id.includes("mini") || id.includes("nano"),
  },
  // GitHub Copilot proxies multiple providers — match by model ID prefix
  "github-copilot": {
    providerID: "github-copilot",
    modelID: "gpt-5.4-mini", // default; overridden by _resolveGitHubCopilotWorker
    alreadyCheap: (id) => id.includes("mini") || id.includes("nano") || id.includes("flash") || id.includes("haiku"),
  },
};

/** Cost threshold ($/M input) above which we downgrade to a cheaper worker. */
const EXPENSIVE_MODEL_THRESHOLD = 1.5;

/**
 * General-purpose fallback worker for GitHub Copilot sessions where no
 * same-family worker is detected. GPT-5.4-mini matched GPT-5.4 exactly
 * (24 obs each) on distillation quality.
 *
 * Only used for GitHub Copilot (where all models are available at no
 * extra cost). For other providers, we fall back to the session model
 * rather than risk calling a provider that may not be configured.
 */
const GENERAL_FALLBACK_WORKER = { providerID: "github-copilot", modelID: "gpt-5.4-mini" };

/**
 * For GitHub Copilot sessions, pick the worker based on which provider family
 * the session model belongs to (detected via model ID prefix).
 */
function resolveGitHubCopilotWorker(sessionModelID: string): { providerID: string; modelID: string } {
  if (sessionModelID.startsWith("claude-")) {
    return { providerID: "github-copilot", modelID: "claude-sonnet-4.6" };
  }
  // For all other model families (OpenAI, Google, xAI, etc.) use GPT-5.4-mini
  // which is available on Copilot and validated for quality parity
  return { providerID: "github-copilot", modelID: "gpt-5.4-mini" };
}

/**
 * Resolve the effective worker model for background calls.
 *
 * Checks (in order):
 *  1. Explicit config override (`workerModel` in lore config)
 *  2. Provider-aware cost default (validated cheaper model from same family)
 *  3. General fallback (GPT-5.4-mini) for unknown providers
 *  4. Config model fallback (session model)
 */
export function getWorkerModel(): { providerID: string; modelID: string } | undefined {
  const cfg = loreConfig();

  // Determine if the session model is expensive enough to warrant a cheaper worker
  let costAwareDefault: { providerID: string; modelID: string } | undefined;
  if (cfg.model?.modelID && cfg.model?.providerID) {
    const entry = getModelEntrySync(cfg.model.modelID);
    const inputCost = entry.cost?.input ?? 3;

    if (inputCost >= EXPENSIVE_MODEL_THRESHOLD) {
      const providerID = cfg.model.providerID;

      if (providerID === "github-copilot") {
        // GitHub Copilot proxies many providers — detect family from model ID
        costAwareDefault = resolveGitHubCopilotWorker(cfg.model.modelID);
      } else {
        const mapping = WORKER_DEFAULTS[providerID];
        if (mapping && !mapping.alreadyCheap(cfg.model.modelID)) {
          costAwareDefault = { providerID: mapping.providerID, modelID: mapping.modelID };
        }
        // Unknown providers (Google, xAI, Mistral, etc.): fall back to session
        // model rather than calling a provider that may not be configured.
      }
    }
  }

  return workerModel.resolveWorkerModel(
    cfg.model?.providerID ?? "anthropic",
    cfg.workerModel,
    cfg.model,
    costAwareDefault,
  );
}

/** Reset module state (for testing). */
export function resetWorkerModelState(): void {
  clearModelDataCache();
}
