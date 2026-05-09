/**
 * Worker model resolution.
 *
 * Background workers (distillation, curation, query expansion) default to
 * sonnet-4 when the session model is more expensive ($5+/M input, i.e. opus).
 * Sonnet produces equivalent-quality distillations at ~60% lower cost.
 * An explicit `workerModel` config override takes priority over this default.
 *
 * Resolution order:
 *   1. Explicit config override (`workerModel`)
 *   2. Cost-aware default (sonnet-4 for expensive session models)
 *   3. Session model fallback (same model as the conversation)
 */

// ---------------------------------------------------------------------------
// Types (kept for config compatibility)
// ---------------------------------------------------------------------------

/** Minimal model info — kept for downstream consumers. */
export type ModelInfo = {
  id: string;
  providerID: string;
  cost: { input: number }; // per-token cost
  status: string;
  capabilities: {
    input: { text: boolean };
    /** Whether this model supports extended thinking/reasoning. */
    reasoning?: boolean;
  };
};

// ---------------------------------------------------------------------------
// Effective worker model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective worker model for a given provider.
 * Priority: explicit config override > cost-aware default > session model.
 */
export function resolveWorkerModel(
  _providerID: string,
  configWorkerModel?: { providerID: string; modelID: string },
  configModel?: { providerID: string; modelID: string },
  costAwareDefault?: { providerID: string; modelID: string },
): { providerID: string; modelID: string } | undefined {
  // Explicit override wins
  if (configWorkerModel) return configWorkerModel;

  // Cost-aware default: cheaper model for background work when the session
  // model is expensive. Caller determines when this applies based on pricing.
  if (costAwareDefault) return costAwareDefault;

  // Fall back to the session model config (or undefined = host default)
  return configModel;
}
