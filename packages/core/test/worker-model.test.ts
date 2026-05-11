import { describe, test, expect } from "bun:test";
import { resolveWorkerModel } from "../src/worker-model";
import { computeLayer0Cap } from "../src/gradient";

// ---------------------------------------------------------------------------
// resolveWorkerModel
// ---------------------------------------------------------------------------

describe("resolveWorkerModel", () => {
  test("returns explicit workerModel config when set", () => {
    const result = resolveWorkerModel(
      "anthropic",
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      { providerID: "anthropic", modelID: "claude-opus-4-6" },
    );
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" });
  });

  test("falls back to config model when no workerModel override", () => {
    const result = resolveWorkerModel(
      "anthropic",
      undefined,
      { providerID: "anthropic", modelID: "claude-opus-4-6" },
    );
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" });
  });

  test("returns undefined when no config at all", () => {
    const result = resolveWorkerModel("anthropic", undefined, undefined);
    expect(result).toBeUndefined();
  });

  test("workerModel takes priority over configModel", () => {
    const result = resolveWorkerModel(
      "anthropic",
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      { providerID: "anthropic", modelID: "claude-opus-4-6" },
    );
    expect(result?.modelID).toBe("claude-haiku-4-5");
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

  test("distillation.minSegmentTokens defaults to 64", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.distillation.minSegmentTokens).toBe(64);
  });

  test("distillation.maxSegmentTokens defaults to 8192", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.distillation.maxSegmentTokens).toBe(8192);
  });
});
