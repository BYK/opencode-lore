import { describe, test, expect } from "bun:test";
import {
  selectWorkerCandidates,
  computeModelFingerprint,
  structuralCheck,
  parseJudgeScore,
  type ModelInfo,
} from "../src/worker-model";
import { computeLayer0Cap } from "../src/gradient";

// ---------------------------------------------------------------------------
// selectWorkerCandidates
// ---------------------------------------------------------------------------

const mkModel = (id: string, provider: string, costInput: number): ModelInfo => ({
  id,
  providerID: provider,
  cost: { input: costInput },
  status: "active",
  capabilities: { input: { text: true } },
});

describe("selectWorkerCandidates", () => {
  const haiku = mkModel("claude-haiku-4-5", "anthropic", 1);
  const sonnet = mkModel("claude-sonnet-4-6", "anthropic", 3);
  const opus = mkModel("claude-opus-4-7", "anthropic", 5);
  const gemini = mkModel("gemini-pro", "google", 2);

  test("returns cheapest + one-below-session for Opus session", () => {
    const candidates = selectWorkerCandidates(
      { id: opus.id, providerID: "anthropic", cost: { input: 5 } },
      [haiku, sonnet, opus, gemini],
    );
    // Should pick haiku (cheapest) and sonnet (one below opus)
    expect(candidates.length).toBe(2);
    expect(candidates[0].id).toBe("claude-haiku-4-5");
    expect(candidates[1].id).toBe("claude-sonnet-4-6");
  });

  test("returns only cheapest when session is Sonnet (one-below = cheapest)", () => {
    const candidates = selectWorkerCandidates(
      { id: sonnet.id, providerID: "anthropic", cost: { input: 3 } },
      [haiku, sonnet, opus],
    );
    // Haiku is both cheapest and one-below-sonnet → deduplicated to 1
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe("claude-haiku-4-5");
  });

  test("returns session model when it is the cheapest", () => {
    const candidates = selectWorkerCandidates(
      { id: haiku.id, providerID: "anthropic", cost: { input: 1 } },
      [haiku, sonnet, opus],
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe("claude-haiku-4-5");
  });

  test("filters to same provider only", () => {
    const candidates = selectWorkerCandidates(
      { id: opus.id, providerID: "anthropic", cost: { input: 5 } },
      [gemini], // only google models
    );
    expect(candidates.length).toBe(0);
  });

  test("filters out inactive models", () => {
    const deprecated = { ...sonnet, status: "deprecated" };
    const candidates = selectWorkerCandidates(
      { id: opus.id, providerID: "anthropic", cost: { input: 5 } },
      [deprecated, haiku, opus],
    );
    // Should still find haiku (active)
    expect(candidates.some((c) => c.id === "claude-haiku-4-5")).toBe(true);
    expect(candidates.some((c) => c.id === "claude-sonnet-4-6")).toBe(false);
  });

  test("returns empty array when no eligible models", () => {
    const candidates = selectWorkerCandidates(
      { id: opus.id, providerID: "anthropic", cost: { input: 5 } },
      [],
    );
    expect(candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeModelFingerprint
// ---------------------------------------------------------------------------

describe("computeModelFingerprint", () => {
  test("is deterministic", () => {
    const a = computeModelFingerprint("anthropic", "opus-4-7", ["haiku", "sonnet", "opus"]);
    const b = computeModelFingerprint("anthropic", "opus-4-7", ["haiku", "sonnet", "opus"]);
    expect(a).toBe(b);
  });

  test("changes when model list changes", () => {
    const a = computeModelFingerprint("anthropic", "opus-4-7", ["haiku", "sonnet", "opus"]);
    const b = computeModelFingerprint("anthropic", "opus-4-7", ["haiku", "sonnet", "opus", "haiku-new"]);
    expect(a).not.toBe(b);
  });

  test("changes when session model changes", () => {
    const a = computeModelFingerprint("anthropic", "opus-4-6", ["haiku", "sonnet", "opus"]);
    const b = computeModelFingerprint("anthropic", "opus-4-7", ["haiku", "sonnet", "opus"]);
    expect(a).not.toBe(b);
  });

  test("order-independent (sorts internally)", () => {
    const a = computeModelFingerprint("anthropic", "opus", ["haiku", "sonnet"]);
    const b = computeModelFingerprint("anthropic", "opus", ["sonnet", "haiku"]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// structuralCheck
// ---------------------------------------------------------------------------

describe("structuralCheck", () => {
  const reference = "Line 1: user asked about X\nLine 2: decided to do Y\nLine 3: implemented Z\n";

  test("passes when candidate has similar structure", () => {
    const candidate = "Obs 1: question about X\nObs 2: decision Y\nObs 3: did Z\n";
    const result = structuralCheck(candidate, reference);
    expect(result.passed).toBe(true);
  });

  test("fails when candidate is null (parse failure)", () => {
    const result = structuralCheck(null, reference);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("parse_failed");
  });

  test("fails when candidate is empty", () => {
    const result = structuralCheck("", reference);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("empty");
  });

  test("fails when observation count is too low", () => {
    const candidate = "Just one line\n";
    const result = structuralCheck(candidate, reference);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("observation_count");
  });

  test("fails when token count is >3x reference", () => {
    // Same line count as reference but each line is 10x longer → token count way over 3x
    const candidate = "Line 1: " + "x".repeat(500) + "\nLine 2: " + "x".repeat(500) + "\nLine 3: " + "x".repeat(500) + "\n";
    const result = structuralCheck(candidate, reference);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("3x");
  });
});

// ---------------------------------------------------------------------------
// parseJudgeScore
// ---------------------------------------------------------------------------

describe("parseJudgeScore", () => {
  test("parses single digit", () => {
    expect(parseJudgeScore("4")).toBe(4);
  });

  test("parses digit with trailing text", () => {
    expect(parseJudgeScore("3\nThe candidate captures most facts")).toBe(3);
  });

  test("parses with leading whitespace", () => {
    expect(parseJudgeScore("  5")).toBe(5);
  });

  test("returns null for non-digit", () => {
    expect(parseJudgeScore("The score is 4")).toBeNull();
  });

  test("returns null for out-of-range digit", () => {
    expect(parseJudgeScore("0")).toBeNull();
    expect(parseJudgeScore("6")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseJudgeScore("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeLayer0Cap
// ---------------------------------------------------------------------------

describe("computeLayer0Cap", () => {
  test("Opus: $0.10 target / $0.50 per MTok → 200K", () => {
    // $0.50/MTok = $0.0000005/token
    const cap = computeLayer0Cap(0.10, 0.50 / 1e6);
    expect(cap).toBe(200_000);
  });

  test("Sonnet: $0.10 target / $0.30 per MTok → 333K", () => {
    const cap = computeLayer0Cap(0.10, 0.30 / 1e6);
    expect(cap).toBe(333_333);
  });

  test("Haiku: $0.10 target / $0.10 per MTok → 1M", () => {
    const cap = computeLayer0Cap(0.10, 0.10 / 1e6);
    expect(cap).toBe(1_000_000);
  });

  test("very expensive model: cap floors at 40K", () => {
    // $10/MTok = very expensive
    const cap = computeLayer0Cap(0.01, 10 / 1e6);
    expect(cap).toBe(40_000);
  });

  test("returns 0 when target is 0 (disabled)", () => {
    const cap = computeLayer0Cap(0, 0.50 / 1e6);
    expect(cap).toBe(0);
  });

  test("returns 0 when cache read cost is 0 (free model)", () => {
    const cap = computeLayer0Cap(0.10, 0);
    expect(cap).toBe(0);
  });

  test("$0.05 target gives tighter cap for Opus", () => {
    const cap = computeLayer0Cap(0.05, 0.50 / 1e6);
    expect(cap).toBe(100_000);
  });

  test("$0.15 target gives looser cap for Opus", () => {
    const cap = computeLayer0Cap(0.15, 0.50 / 1e6);
    expect(cap).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Config schema — new budget fields
// ---------------------------------------------------------------------------

describe("LoreConfig — budget cost fields", () => {
  const { LoreConfig } = require("../src/config");

  test("budget defaults include new fields", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.budget.ltm).toBe(0.05);
    expect(cfg.budget.targetCacheReadCostPerTurn).toBe(0.10);
    expect(cfg.budget.maxLayer0Tokens).toBeUndefined();
  });

  test("targetCacheReadCostPerTurn can be customized", () => {
    const cfg = LoreConfig.parse({ budget: { targetCacheReadCostPerTurn: 0.05 } });
    expect(cfg.budget.targetCacheReadCostPerTurn).toBe(0.05);
  });

  test("targetCacheReadCostPerTurn=0 disables cost-aware cap", () => {
    const cfg = LoreConfig.parse({ budget: { targetCacheReadCostPerTurn: 0 } });
    expect(cfg.budget.targetCacheReadCostPerTurn).toBe(0);
  });

  test("maxLayer0Tokens explicit override", () => {
    const cfg = LoreConfig.parse({ budget: { maxLayer0Tokens: 150000 } });
    expect(cfg.budget.maxLayer0Tokens).toBe(150000);
  });

  test("maxLayer0Tokens=0 disables cap", () => {
    const cfg = LoreConfig.parse({ budget: { maxLayer0Tokens: 0 } });
    expect(cfg.budget.maxLayer0Tokens).toBe(0);
  });

  test("workerModel can be set", () => {
    const cfg = LoreConfig.parse({
      workerModel: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    });
    expect(cfg.workerModel?.providerID).toBe("anthropic");
    expect(cfg.workerModel?.modelID).toBe("claude-haiku-4-5");
  });

  test("workerModel is optional", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.workerModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config schema — updated distillation defaults
// ---------------------------------------------------------------------------

describe("LoreConfig — updated distillation defaults", () => {
  const { LoreConfig } = require("../src/config");

  test("distillation.minMessages defaults to 5", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.distillation.minMessages).toBe(5);
  });

  test("distillation.maxSegment defaults to 30", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.distillation.maxSegment).toBe(30);
  });
});
