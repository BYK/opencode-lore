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
// Cost estimation metrics
// ---------------------------------------------------------------------------

/**
 * Per-model pricing (USD per million tokens).
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 */
type ModelPricing = { input: number; output: number };

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-3-5": { input: 3, output: 15 },
  "claude-haiku-3-5": { input: 0.80, output: 4 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15 };

/**
 * Look up pricing by model name, supporting prefix matches
 * (e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4").
 */
function getPricing(model: string): ModelPricing {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Emit a cost-estimate metric for an LLM call.
 *
 * Uses Anthropic's published pricing. Batch calls get 50% discount.
 * Emits as a Sentry distribution metric (aggregatable/chartable).
 */
export function emitCostMetric(
  model: string,
  usage: AnthropicUsage,
  callType: "conversation" | "direct" | "batch",
): void {
  if (!Sentry.isInitialized()) return;

  const pricing = getPricing(model);
  const multiplier = callType === "batch" ? 0.5 : 1.0;
  const inputCost =
    ((usage.input_tokens ?? 0) / 1_000_000) * pricing.input * multiplier;
  const outputCost =
    ((usage.output_tokens ?? 0) / 1_000_000) * pricing.output * multiplier;
  const totalCost = inputCost + outputCost;

  Sentry.metrics.distribution("lore.llm_cost_usd", totalCost, {
    attributes: { model, call_type: callType },
    unit: "dollar",
  });
}
