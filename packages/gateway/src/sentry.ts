/**
 * Sentry scope enrichment and metrics helpers for the Lore gateway.
 *
 * All functions are no-ops when Sentry is not initialized (dev mode).
 * No request/response content is ever captured — we're a proxy sitting
 * in front of other people's projects and conversations.
 */

import * as Sentry from "@sentry/bun";
import { getInstanceId } from "@loreai/core";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Scope enrichment
// ---------------------------------------------------------------------------

/**
 * Configure Sentry scope for a gateway request.
 *
 * Sets user identity, tags, and conversation ID. Called once per
 * conversation turn before forwarding to upstream. All values are
 * non-sensitive (hashed or random identifiers only).
 */
export function setSentryRequestContext(opts: {
  authFingerprint: string | null;
  sessionID: string;
  model: string;
  upstreamUrl: string;
  port: number;
  projectPath: string;
}): void {
  if (!Sentry.isInitialized()) return;

  // Installation identity — integrates with Sentry's unique users feature
  Sentry.setUser({ id: getInstanceId() });

  // Request-scoped tags (filterable in Sentry UI)
  if (opts.authFingerprint) {
    Sentry.setTag("auth_fingerprint", opts.authFingerprint);
  }
  Sentry.setTag("model", opts.model);
  Sentry.setTag("upstream_url", opts.upstreamUrl);
  Sentry.setTag("port", String(opts.port));

  // Hash project path — sensitive info for secret projects
  const projectHash = createHash("sha256")
    .update(opts.projectPath)
    .digest("hex")
    .slice(0, 16);
  Sentry.setTag("project_hash", projectHash);

  // Link to Sentry AI monitoring conversation tracking
  Sentry.setConversationId(opts.sessionID);
}

/**
 * Lighter-weight scope enrichment for passthrough and compaction handlers.
 *
 * Sets just the installation identity and basic tags so errors in these
 * paths are attributable, without the full conversation turn context.
 */
export function setSentryLightContext(opts: {
  model?: string;
  projectPath?: string;
}): void {
  if (!Sentry.isInitialized()) return;

  Sentry.setUser({ id: getInstanceId() });

  if (opts.model) {
    Sentry.setTag("model", opts.model);
  }
  if (opts.projectPath) {
    const projectHash = createHash("sha256")
      .update(opts.projectPath)
      .digest("hex")
      .slice(0, 16);
    Sentry.setTag("project_hash", projectHash);
  }
}

// ---------------------------------------------------------------------------
// Cache context
// ---------------------------------------------------------------------------

/**
 * Record cache metrics on the current Sentry scope after upstream response.
 */
export function setSentryCacheContext(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): void {
  if (!Sentry.isInitialized()) return;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const totalInput = usage.inputTokens + cacheRead + cacheWrite;
  const hitRate = totalInput > 0 ? cacheRead / totalInput : 0;

  Sentry.setContext("cache", {
    read_tokens: cacheRead,
    write_tokens: cacheWrite,
    uncached_tokens: usage.inputTokens,
    hit_rate: Math.round(hitRate * 1000) / 1000,
    is_cold: cacheRead === 0 && cacheWrite > 0,
  });
}

// ---------------------------------------------------------------------------
// gen_ai.chat span helpers
// ---------------------------------------------------------------------------

/** Usage fields from an Anthropic API response. */
export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Set gen_ai.* usage attributes on a span from Anthropic API usage data.
 *
 * Shared by conversation turn spans, worker direct spans, and batch result
 * spans. Does NOT set input/output message content — privacy boundary.
 */
export function setGenAiUsageAttributes(
  span: Sentry.Span,
  usage: AnthropicUsage,
  responseModel?: string,
): void {
  if (responseModel) {
    span.setAttribute("gen_ai.response.model", responseModel);
  }
  span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens ?? 0);
  span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens ?? 0);
  if (usage.cache_read_input_tokens != null) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cached",
      usage.cache_read_input_tokens,
    );
  }
  if (usage.cache_creation_input_tokens != null) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cache_write",
      usage.cache_creation_input_tokens,
    );
  }
}

// ---------------------------------------------------------------------------
// Cache analytics span enrichment
// ---------------------------------------------------------------------------

import type { CacheTurnAnalysis } from "./translate/types.ts";

/**
 * Set cache analytics attributes on a gen_ai.chat span.
 *
 * Called after `analyzeCacheTurn()` returns — adds divergence diagnostics
 * and prefix match data so cache busting issues are visible in Sentry traces
 * without needing to grep server logs.
 *
 * For early divergences (< 5% prefix match), also includes short byte
 * snippets around the divergence point for forensic debugging.
 */
export function setCacheAnalyticsAttributes(
  span: Sentry.Span,
  analysis: CacheTurnAnalysis,
  bustCause: string,
  prevSnippet?: string,
  currSnippet?: string,
): void {
  span.setAttribute("lore.cache.turn", analysis.turn);
  span.setAttribute("lore.cache.hit_rate", Math.round(analysis.cacheHitRate * 1000) / 1000);
  span.setAttribute("lore.cache.prefix_match", Math.round(analysis.prefixMatchPercent * 1000) / 1000);
  span.setAttribute("lore.cache.divergence_point", analysis.divergencePoint);
  span.setAttribute("lore.cache.divergence_reason", analysis.divergenceReason);
  span.setAttribute("lore.cache.bust_cause", bustCause);

  // Include diverging byte snippets for early divergences — these are from the
  // system prompt prefix (client env info), not user conversation content.
  if (prevSnippet) {
    span.setAttribute("lore.cache.divergence_prev_snippet", prevSnippet);
  }
  if (currSnippet) {
    span.setAttribute("lore.cache.divergence_curr_snippet", currSnippet);
  }
}

// ---------------------------------------------------------------------------
// Cache bust telemetry
// ---------------------------------------------------------------------------

/**
 * Emit cache-bust cause metrics for observability and cost analysis.
 *
 * Emits a counter per cause category and a distribution of cache-write
 * token counts, both tagged by cause and model. Enables identifying which
 * bust causes dominate and tracking improvements over time.
 */
export function emitCacheBustMetric(
  cause: string,
  writeTokens: number,
  model: string,
): void {
  if (!Sentry.isInitialized()) return;

  Sentry.metrics.count("lore.cache_bust", 1, {
    attributes: { cause, model },
  });

  if (writeTokens > 0) {
    Sentry.metrics.distribution("lore.cache_bust_tokens", writeTokens, {
      attributes: { cause, model },
      unit: "token",
    });
  }
}

// ---------------------------------------------------------------------------
// Cost estimation metrics
// ---------------------------------------------------------------------------

import { getModelEntry } from "./worker-model";

type ModelPricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };

/**
 * Look up pricing for a model from models.dev (cached, fetched at startup).
 * Falls back to sensible defaults if the fetch hasn't completed yet.
 */
async function getPricing(model: string): Promise<ModelPricing> {
  const entry = await getModelEntry(model);
  const input = entry.cost?.input ?? DEFAULT_PRICING.input;
  return {
    input,
    output: entry.cost?.output ?? DEFAULT_PRICING.output,
    cache_read: entry.cost?.cache_read ?? input * 0.1,
    cache_write: entry.cost?.cache_write ?? input * 1.25,
  };
}

/**
 * Emit a cost-estimate metric for an LLM call.
 *
 * Uses live pricing from models.dev (fetched at gateway startup, cached 1h).
 * Properly accounts for cache-read and cache-write pricing tiers, and
 * applies the 50% batch discount only to base input/output (not cache ops,
 * which are not discounted by the batch API).
 *
 * Token categories from Anthropic:
 *  - input_tokens: uncached input (base input price)
 *  - cache_read_input_tokens: served from prompt cache (0.1× input price)
 *  - cache_creation_input_tokens: written to prompt cache (1.25× input price)
 *  - output_tokens: generated output (output price)
 */
// ---------------------------------------------------------------------------
// Cache warming telemetry
// ---------------------------------------------------------------------------

import type { SessionState, WarmupResult } from "./translate/types";

/**
 * Emit metrics for a cache warmup attempt.
 *
 * Tracks warmup sent/hit/miss counts and estimated cost/savings for
 * ROI analysis. All metrics are tagged by model and TTL.
 */
export function emitWarmupMetric(
  state: SessionState,
  result: WarmupResult,
): void {
  if (!Sentry.isInitialized()) return;

  const model = state.lastModel ?? "unknown";
  const ttl = state.resolvedConversationTTL ?? "5m";
  const attrs = { model, ttl };

  // Count every warmup sent
  Sentry.metrics.count("lore.cache_warmup.sent", 1, { attributes: attrs });

  if (result.ok && result.cacheReadTokens > 0 && result.cacheCreationTokens === 0) {
    // Pure cache refresh — ideal outcome
    Sentry.metrics.count("lore.cache_warmup.refresh", 1, { attributes: attrs });
  } else if (result.ok && result.cacheCreationTokens > 0 && result.cacheReadTokens === 0) {
    // Uncached warmup — circuit breaker material
    Sentry.metrics.count("lore.cache_warmup.uncached", 1, { attributes: attrs });
  }

  // Emit warmup cost as a distribution (fire-and-forget)
  if (result.ok) {
    getPricing(model).then((pricing) => {
      const readCost = (result.cacheReadTokens / 1_000_000) * pricing.cache_read;
      const writeCost = (result.cacheCreationTokens / 1_000_000) * pricing.cache_write;
      Sentry.metrics.distribution("lore.cache_warmup.cost_usd", readCost + writeCost, {
        attributes: attrs,
        unit: "dollar",
      });
    }).catch(() => {});
  }
}

/**
 * Emit a metric when a user returns after a warmup (confirmed save).
 */
export function emitWarmupHitMetric(
  model: string,
  ttl: string,
): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.count("lore.cache_warmup.hit", 1, {
    attributes: { model, ttl },
  });
}

/**
 * Emit a metric when the circuit breaker trips.
 */
export function emitWarmupCircuitBreakerMetric(): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.count("lore.cache_warmup.circuit_breaker_tripped", 1, {});
}

// ---------------------------------------------------------------------------
// LLM cost estimation
// ---------------------------------------------------------------------------

export function emitCostMetric(
  model: string,
  usage: AnthropicUsage,
  callType: "conversation" | "direct" | "batch",
): void {
  if (!Sentry.isInitialized()) return;

  // Fire-and-forget: pricing lookup is async but we don't want to block callers.
  // The models.dev data is cached after first fetch, so subsequent calls resolve
  // from memory without network I/O.
  getPricing(model).then((pricing) => {
    // Batch discount applies to base input/output only — cache ops have their
    // own pricing tiers and are not discounted by the batch API.
    const batchMultiplier = callType === "batch" ? 0.5 : 1.0;

    const uncachedInputCost =
      ((usage.input_tokens ?? 0) / 1_000_000) * pricing.input * batchMultiplier;
    const cacheReadCost =
      ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cache_read;
    const cacheWriteCost =
      ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cache_write;
    const outputCost =
      ((usage.output_tokens ?? 0) / 1_000_000) * pricing.output * batchMultiplier;

    const totalCost = uncachedInputCost + cacheReadCost + cacheWriteCost + outputCost;

    Sentry.metrics.distribution("lore.llm_cost_usd", totalCost, {
      attributes: { model, call_type: callType },
      unit: "dollar",
    });
  }).catch(() => {
    // Silently ignore — cost metrics are best-effort, not critical path.
  });
}

// ---------------------------------------------------------------------------
// Session-level cost/savings aggregates
// ---------------------------------------------------------------------------

import {
  getSessionCosts,
  totalActualCost,
  totalWorkerCost,
  totalSavings,
} from "./cost-tracker";

/**
 * Emit session-level cost and savings metrics to Sentry.
 *
 * Called when a session goes idle (natural "session over" signal) and
 * captures the accumulated cost intelligence for alerting and dashboards.
 */
export function emitSessionCostMetrics(sessionID: string): void {
  if (!Sentry.isInitialized()) return;

  const costs = getSessionCosts(sessionID);
  if (!costs || costs.conversation.turns === 0) return;

  const actual = totalActualCost(costs);
  const worker = totalWorkerCost(costs);
  const saved = totalSavings(costs);
  const savingsPct = actual + saved > 0
    ? (saved / (actual + saved)) * 100
    : 0;

  Sentry.metrics.distribution("lore.session_cost_usd", actual, {
    unit: "dollar",
  });

  Sentry.metrics.distribution("lore.session_worker_cost_usd", worker, {
    unit: "dollar",
  });

  Sentry.metrics.distribution("lore.session_savings_usd", saved, {
    unit: "dollar",
  });

  Sentry.metrics.gauge("lore.session_savings_pct", savingsPct, {
    unit: "percent",
  });

  // Emit counterfactual breakdown
  if (costs.counterfactual.avoidedCompactions > 0) {
    Sentry.metrics.distribution(
      "lore.session_avoided_compactions",
      costs.counterfactual.avoidedCompactions,
    );
  }

  if (costs.batchSavings > 0) {
    Sentry.metrics.distribution("lore.session_batch_savings_usd", costs.batchSavings, {
      unit: "dollar",
    });
  }
}
