/**
 * Gateway worker model discovery and resolution.
 *
 * Discovers available models from the upstream Anthropic `/v1/models` API,
 * fetches per-model pricing from models.dev (open-source model database),
 * and integrates with core's worker model validation/resolution pipeline.
 *
 * This replaces the OpenCode adapter's `getProviderModels()` +
 * `maybeValidateWorkerModel()` — the gateway is the universal path and
 * doesn't depend on the OpenCode SDK's model listing (which can report
 * deprecated models as "active").
 */

import {
  workerModel,
  temporal,
  distillation as distillationMod,
  config as loreConfig,
  log,
} from "@loreai/core";
import type { LLMClient } from "@loreai/core";
import type { AuthCredential } from "./auth";
import { authHeaders } from "./auth";

// ---------------------------------------------------------------------------
// Cost lookup — models.dev with hardcoded fallback
// ---------------------------------------------------------------------------

/**
 * Base URL for fetching model pricing data from models.dev (open-source).
 *
 * TOML files live at:
 *   {MODELS_DEV_BASE}/{model-id}.toml
 * and contain `[cost] input = X.XX` (per-million-token USD).
 */
const MODELS_DEV_BASE =
  "https://raw.githubusercontent.com/sst/models.dev/dev/providers/anthropic/models";

/**
 * Hardcoded fallback costs (per-input-token, USD) used when models.dev
 * fetch fails. Prefix-matched against model IDs.
 *
 * These only serve as a safety net — runtime pricing from models.dev is
 * preferred and fetched on every discovery cycle (cached 1h).
 */
const FALLBACK_COSTS: Array<{ prefix: string; inputCostPerToken: number }> = [
  { prefix: "claude-opus-4", inputCostPerToken: 15 / 1_000_000 },
  { prefix: "claude-sonnet-4", inputCostPerToken: 3 / 1_000_000 },
  { prefix: "claude-haiku-4", inputCostPerToken: 1 / 1_000_000 },
  { prefix: "claude-haiku-3-5", inputCostPerToken: 0.8 / 1_000_000 },
  { prefix: "claude-sonnet-3-5", inputCostPerToken: 3 / 1_000_000 },
  { prefix: "claude-3-haiku", inputCostPerToken: 0.25 / 1_000_000 },
  { prefix: "claude-3-sonnet", inputCostPerToken: 3 / 1_000_000 },
  { prefix: "claude-3-opus", inputCostPerToken: 15 / 1_000_000 },
];

function fallbackCost(modelID: string): number {
  for (const { prefix, inputCostPerToken } of FALLBACK_COSTS) {
    if (modelID.startsWith(prefix)) return inputCostPerToken;
  }
  // Unknown model — assume expensive so it doesn't get picked as a worker
  return 100 / 1_000_000;
}

/**
 * Parse the `[cost] input = X.XX` field from a models.dev TOML string.
 *
 * Minimal parser — we only need the input cost, not a full TOML library.
 * Returns per-million-token USD cost, or null if not found.
 */
export function parseCostFromTOML(toml: string): number | null {
  // Match `input = <number>` inside a [cost] section
  const costSection = toml.indexOf("[cost]");
  if (costSection === -1) return null;

  // Find the next section header or end of string
  const nextSection = toml.indexOf("\n[", costSection + 1);
  const section = nextSection === -1
    ? toml.slice(costSection)
    : toml.slice(costSection, nextSection);

  const match = /^\s*input\s*=\s*([0-9]+(?:\.[0-9]+)?)/m.exec(section);
  if (!match) return null;

  return parseFloat(match[1]);
}

/**
 * Fetch per-model input cost from models.dev TOML files.
 *
 * Fetches in parallel with a 5s timeout per model. Returns a map of
 * modelID → per-token cost. Models that fail to fetch get fallback costs.
 */
export async function fetchModelCosts(
  modelIDs: string[],
): Promise<Map<string, number>> {
  const costs = new Map<string, number>();

  const fetches = modelIDs.map(async (id) => {
    try {
      const url = `${MODELS_DEV_BASE}/${id}.toml`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        costs.set(id, fallbackCost(id));
        return;
      }

      const toml = await response.text();
      const inputCostPerMillion = parseCostFromTOML(toml);

      if (inputCostPerMillion != null) {
        costs.set(id, inputCostPerMillion / 1_000_000);
      } else {
        costs.set(id, fallbackCost(id));
      }
    } catch {
      costs.set(id, fallbackCost(id));
    }
  });

  await Promise.all(fetches);
  return costs;
}

// ---------------------------------------------------------------------------
// Anthropic /v1/models API types (subset we care about)
// ---------------------------------------------------------------------------

type AnthropicModelEntry = {
  id: string;
  display_name: string;
  created_at: string;
  capabilities?: {
    thinking?: { supported: boolean };
  };
};

type AnthropicModelsResponse = {
  data: AnthropicModelEntry[];
  has_more: boolean;
  last_id?: string;
};

// ---------------------------------------------------------------------------
// Model discovery — fetch from upstream /v1/models
// ---------------------------------------------------------------------------

/** Cached model list with TTL. */
let cachedModels: workerModel.ModelInfo[] | null = null;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch available Anthropic models from the upstream API.
 *
 * Results are cached for 1 hour — model listings change rarely and we
 * don't want to hit the API on every idle cycle.
 *
 * Unlike the OpenCode SDK's `provider.list()`, the Anthropic `/v1/models`
 * API only returns models that actually exist — deprecated models are
 * removed, so we never get stale entries like `claude-3-haiku-20240307`.
 */
export async function discoverModels(
  upstreamUrl: string,
  cred: AuthCredential,
): Promise<workerModel.ModelInfo[]> {
  // Return cache if fresh
  if (cachedModels && Date.now() - cachedModelsAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const entries: AnthropicModelEntry[] = [];
    let afterId: string | undefined;

    // Paginate through all models
    do {
      const url = new URL(`${upstreamUrl}/v1/models`);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);

      const response = await fetch(url.toString(), {
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders(cred),
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        log.warn(
          `model discovery failed: ${response.status} ${response.statusText} — ${text}`,
        );
        return cachedModels ?? [];
      }

      const data = (await response.json()) as AnthropicModelsResponse;

      for (const entry of data.data) {
        entries.push(entry);
      }

      afterId = data.has_more ? data.last_id : undefined;
    } while (afterId);

    // Fetch costs from models.dev in parallel (with fallback to hardcoded)
    const modelIDs = entries.map((e) => e.id);
    const costs = await fetchModelCosts(modelIDs);

    const models: workerModel.ModelInfo[] = entries.map((entry) => ({
      id: entry.id,
      providerID: "anthropic",
      cost: { input: costs.get(entry.id) ?? fallbackCost(entry.id) },
      status: "active", // Only active models are returned by the API
      capabilities: {
        input: { text: true }, // All Anthropic models accept text
        reasoning: entry.capabilities?.thinking?.supported ?? false,
      },
    }));

    cachedModels = models;
    cachedModelsAt = Date.now();

    log.info(
      `model discovery: found ${models.length} models (${models.map((m) => m.id).join(", ")})`,
    );

    return models;
  } catch (e) {
    log.warn("model discovery error:", e);
    return cachedModels ?? [];
  }
}

/** Clear the cached model list (for testing). */
export function clearModelCache(): void {
  cachedModels = null;
  cachedModelsAt = 0;
}

// ---------------------------------------------------------------------------
// Worker model validation — gateway version of maybeValidateWorkerModel
// ---------------------------------------------------------------------------

/** Guard against concurrent validation runs. */
let validating = false;

/**
 * Run worker model validation if needed.
 *
 * Called on session idle — discovers available models, selects candidates,
 * checks if the stored validation is stale, and runs the two-phase
 * comparison (structural check + LLM judge) if needed.
 *
 * @param sessionModel  The model ID being used for conversation (frontier)
 * @param upstreamUrl   Anthropic API base URL
 * @param cred          Auth credential for API calls
 * @param llm           LLM client for validation prompts
 * @param projectPath   Project directory path
 * @param sessionID     Session ID for loading reference distillation data
 */
export async function maybeValidateWorkerModel(
  sessionModel: string,
  upstreamUrl: string,
  cred: AuthCredential,
  llm: LLMClient,
  projectPath: string,
  sessionID: string,
): Promise<void> {
  if (validating) return;

  const cfg = loreConfig();
  if (cfg.workerModel) return; // explicit override — skip auto-selection

  const models = await discoverModels(upstreamUrl, cred);
  if (models.length === 0) return;

  // Build the session model info for candidate selection.
  // Use cost from discovered models if available, otherwise fallback.
  const discoveredModel = models.find((m) => m.id === sessionModel);
  const sessionModelInfo: Parameters<typeof workerModel.selectWorkerCandidates>[0] = {
    id: sessionModel,
    providerID: "anthropic",
    cost: { input: discoveredModel?.cost.input ?? fallbackCost(sessionModel) },
  };

  const candidates = workerModel.selectWorkerCandidates(sessionModelInfo, models);
  if (candidates.length === 0) return;
  // If session model is already the cheapest, no comparison needed
  if (candidates.length === 1 && candidates[0].id === sessionModel) return;

  const fingerprint = workerModel.computeModelFingerprint(
    "anthropic",
    sessionModel,
    models.filter((m) => m.providerID === "anthropic").map((m) => m.id),
  );

  const stored = workerModel.getValidatedWorkerModel("anthropic");
  if (!workerModel.isValidationStale(stored, fingerprint)) return;

  // Need reference distillation data
  const distillations = distillationMod.loadForSession(projectPath, sessionID, true);
  const gen0 = distillations.filter((d) => d.generation === 0);
  if (gen0.length === 0) return;

  const reference = gen0[gen0.length - 1]; // most recent gen-0
  const sourceIds = reference.source_ids;
  if (sourceIds.length === 0) return;

  // Load source temporal messages
  const allMessages = temporal.bySession(projectPath, sessionID);
  const sourceSet = new Set(sourceIds);
  const sourceMessages = allMessages.filter((m) => sourceSet.has(m.id));
  if (sourceMessages.length === 0) return;

  const messagesText = sourceMessages.map((m) => m.content).join("\n");
  const date = new Date(sourceMessages[0].created_at).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  validating = true;
  try {
    const result = await workerModel.runValidation({
      llm,
      providerID: "anthropic",
      sessionModelID: sessionModel,
      candidates,
      referenceObservations: reference.observations,
      sourceMessagesText: messagesText,
      date,
    });
    if (result) {
      log.info(
        `worker model validated: ${result.modelID} (judge=${result.judgeScore}) — saving 50%+ on worker calls`,
      );
    }
  } catch (e) {
    log.error("worker model validation error:", e);
  } finally {
    validating = false;
  }
}

// ---------------------------------------------------------------------------
// Resolution — wrapper around core's resolveWorkerModel
// ---------------------------------------------------------------------------

/**
 * Resolve the effective worker model for background calls.
 *
 * Checks (in order):
 *  1. Explicit config override (`workerModel` in lore config)
 *  2. Validated auto-selection from kv_meta (with 24h TTL)
 *  3. Config model fallback (frontier model)
 */
export function getWorkerModel(): { providerID: string; modelID: string } | undefined {
  const cfg = loreConfig();
  return workerModel.resolveWorkerModel(
    "anthropic",
    cfg.workerModel,
    cfg.model,
  );
}

/** Reset module state (for testing). */
export function resetWorkerModelState(): void {
  clearModelCache();
  validating = false;
}
