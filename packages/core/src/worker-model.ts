/**
 * Worker model resolution.
 *
 * Background workers (distillation, curation, query expansion) use the session
 * model by default. An explicit `workerModel` config override is supported for
 * cases where the user wants to pin background work to a specific model.
 *
 * Previously this module contained dynamic worker model selection with
 * candidate discovery, two-phase validation (structural check + LLM judge),
 * and fingerprint-based staleness detection. That complexity was removed in
 * favor of always using the session model — A/B testing showed the quality
 * gap on complex conversations wasn't worth the infrastructure cost.
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
 * Priority: explicit config override > session model (fallback).
 */
export function resolveWorkerModel(
  _providerID: string,
  configWorkerModel?: { providerID: string; modelID: string },
  configModel?: { providerID: string; modelID: string },
): { providerID: string; modelID: string } | undefined {
  // Explicit override wins
  if (configWorkerModel) return configWorkerModel;

  // Fall back to the session model config (or undefined = host default)
  return configModel;
}
