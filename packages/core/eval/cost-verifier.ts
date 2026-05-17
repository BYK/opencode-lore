/**
 * Independent cost tracking for the Lore eval suite.
 *
 * Wraps upstream API interactions to independently measure token usage
 * and costs, then compares against Lore's internal cost-tracker.ts
 * numbers to verify accuracy.
 */
import type { CostMetrics, TurnSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndependentCostRecord {
  timestamp: number;
  callType: "conversation" | "distillation" | "curation" | "recall" | "warmup";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
}

export interface CostComparison {
  loreReported: CostMetrics;
  independent: CostMetrics;
  /** Absolute error as a fraction (0.0 = perfect match). */
  totalErrorPct: number;
  /** Per-component error percentages. */
  componentErrors: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pricing (per million tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-opus-4-6": {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  "claude-haiku-3-5-20241022": {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  // GitHub Models API (OpenAI) — pricing is $0 for free tier
  "gpt-4.1": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const DEFAULT_PRICING: ModelPricing = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? DEFAULT_PRICING;
}

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * p.cacheRead +
      cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Cost tracker
// ---------------------------------------------------------------------------

export class IndependentCostTracker {
  readonly records: IndependentCostRecord[] = [];

  record(entry: Omit<IndependentCostRecord, "estimatedCost">): void {
    const estimatedCost = computeCost(
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
    );
    this.records.push({ ...entry, estimatedCost });
  }

  /**
   * Record from turn snapshots (conversation turns captured during replay).
   */
  recordFromSnapshots(
    snapshots: TurnSnapshot[],
    model: string,
  ): void {
    for (const snap of snapshots) {
      this.record({
        timestamp: Date.now(),
        callType: "conversation",
        model,
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        cacheReadTokens: snap.cacheReadTokens,
        cacheWriteTokens: snap.cacheWriteTokens,
      });
    }
  }

  totalCost(): number {
    return this.records.reduce((s, r) => s + r.estimatedCost, 0);
  }

  costByType(): Record<string, number> {
    const byType: Record<string, number> = {};
    for (const r of this.records) {
      byType[r.callType] = (byType[r.callType] ?? 0) + r.estimatedCost;
    }
    return byType;
  }

  totalTokens(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const r of this.records) {
      input += r.inputTokens;
      output += r.outputTokens;
      cacheRead += r.cacheReadTokens;
      cacheWrite += r.cacheWriteTokens;
    }
    return { input, output, cacheRead, cacheWrite };
  }

  toCostMetrics(): CostMetrics {
    const byType = this.costByType();
    const conversationCost = byType.conversation ?? 0;
    const totalCost = this.totalCost();

    return {
      totalCostWithLore: totalCost,
      totalCostBaseline: 0, // filled in by comparison
      loreOverheadPct: 0,
      savingsPct: 0,
      breakdown: {
        conversation: conversationCost,
        distillation: byType.distillation ?? 0,
        curation: byType.curation ?? 0,
        recall: byType.recall ?? 0,
        warmup: byType.warmup ?? 0,
      },
      counterfactual: {
        avoidedCompactions: 0,
        avoidedCompactionCost: 0,
        cacheHitRate: 0,
        batchSavings: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function pctError(reported: number, independent: number): number {
  if (independent === 0) return reported === 0 ? 0 : 1;
  return Math.abs(reported - independent) / independent;
}

/**
 * Compare Lore's internal cost report against independently tracked costs.
 */
export function compareCosts(
  loreMetrics: CostMetrics,
  independentTracker: IndependentCostTracker,
): CostComparison {
  const independent = independentTracker.toCostMetrics();

  const componentErrors: Record<string, number> = {
    conversation: pctError(
      loreMetrics.breakdown.conversation,
      independent.breakdown.conversation,
    ),
    distillation: pctError(
      loreMetrics.breakdown.distillation,
      independent.breakdown.distillation,
    ),
    curation: pctError(
      loreMetrics.breakdown.curation,
      independent.breakdown.curation,
    ),
    recall: pctError(
      loreMetrics.breakdown.recall,
      independent.breakdown.recall,
    ),
    warmup: pctError(
      loreMetrics.breakdown.warmup,
      independent.breakdown.warmup,
    ),
  };

  return {
    loreReported: loreMetrics,
    independent,
    totalErrorPct: pctError(
      loreMetrics.totalCostWithLore,
      independent.totalCostWithLore,
    ),
    componentErrors,
  };
}

/**
 * Verify cost tracking accuracy meets the threshold.
 */
export function verifyCostAccuracy(
  comparison: CostComparison,
  maxErrorPct = 0.05,
): { passed: boolean; message: string } {
  if (comparison.totalErrorPct <= maxErrorPct) {
    return {
      passed: true,
      message: `Cost tracking accuracy: ${(comparison.totalErrorPct * 100).toFixed(1)}% error (within ${maxErrorPct * 100}% threshold)`,
    };
  }

  const worstComponent = Object.entries(comparison.componentErrors)
    .sort(([, a], [, b]) => b - a)[0];

  return {
    passed: false,
    message:
      `Cost tracking accuracy FAILED: ${(comparison.totalErrorPct * 100).toFixed(1)}% total error ` +
      `(threshold: ${maxErrorPct * 100}%). ` +
      `Worst component: ${worstComponent[0]} at ${(worstComponent[1] * 100).toFixed(1)}% error.`,
  };
}
