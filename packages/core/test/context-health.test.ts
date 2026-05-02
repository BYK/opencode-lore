import { describe, test, expect } from "bun:test";
import { temporalCnorm } from "../src/temporal";
import { compressionRatio } from "../src/distillation";
import { reciprocalRankFusion } from "../src/search";

// ─── temporalCnorm ──────────────────────────────────────────────────────────

describe("temporalCnorm", () => {
  test("returns 0 for empty array", () => {
    expect(temporalCnorm([], 1000)).toBe(0);
  });

  test("returns 0 for single timestamp", () => {
    expect(temporalCnorm([500], 1000)).toBe(0);
  });

  test("returns 0 for two equal timestamps", () => {
    // Both have the same existence duration → uniform weights → variance = 0
    expect(temporalCnorm([500, 500], 1000)).toBe(0);
  });

  test("returns 0 when all timestamps equal now", () => {
    // All durations = 0 → totalDuration = 0 → early return 0
    const now = 5000;
    expect(temporalCnorm([now, now, now], now)).toBe(0);
  });

  test("returns ≈0 for equally-spaced timestamps", () => {
    // 10 timestamps at regular 100ms intervals. With a small n like 10,
    // equally-spaced doesn't yield exactly 0 variance (it's proportional
    // to how far each point is from the mean), but the C_norm should be
    // very low compared to pathological cases.
    const base = 1000;
    const timestamps = Array.from({ length: 10 }, (_, i) => base + i * 100);
    const now = base + 10 * 100;
    const result = temporalCnorm(timestamps, now);
    // For equally-spaced, C_norm is deterministic and low but not zero.
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(0.15);
  });

  test("approaches 1 for one ancient + many recent timestamps", () => {
    // One timestamp from long ago, rest very recent → old one dominates
    const now = 1_000_000;
    const timestamps = [
      0, // ancient — duration = 1_000_000
      999_990,
      999_991,
      999_992,
      999_993,
      999_994,
      999_995,
      999_996,
      999_997,
      999_998,
    ];
    const result = temporalCnorm(timestamps, now);
    expect(result).toBeGreaterThan(0.8);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("result is always in [0, 1]", () => {
    // Property test: random timestamps should always produce [0, 1]
    for (let trial = 0; trial < 100; trial++) {
      const n = 2 + Math.floor(Math.random() * 20);
      const now = Date.now();
      const timestamps = Array.from(
        { length: n },
        () => now - Math.floor(Math.random() * 10_000_000),
      );
      const result = temporalCnorm(timestamps, now);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1.0001); // tiny float tolerance
    }
  });

  test("two timestamps: one old, one recent → high C_norm", () => {
    // With exactly 2 items, extreme asymmetry should produce high C_norm
    const now = 10_000;
    const result = temporalCnorm([0, 9_999], now);
    // Old: duration = 10_000, Recent: duration = 1
    // Weights: [10000/10001, 1/10001] ≈ [0.9999, 0.0001]
    // This is highly skewed
    expect(result).toBeGreaterThan(0.9);
  });

  test("defaults to Date.now() when now is omitted", () => {
    const past = Date.now() - 60_000;
    const result = temporalCnorm([past, past + 100]);
    // Should not throw and should return a valid number
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test("spike detection: C_norm is higher for clustered timestamps than uniform", () => {
    // Two distinct clusters separated by a large gap produce higher
    // C_norm than the same number of evenly-spaced timestamps.
    const now = 20_000;

    // Clustered: 5 messages at t≈0, 5 messages at t≈19_000 (big gap)
    const clustered = [
      ...Array.from({ length: 5 }, (_, i) => i * 10),
      ...Array.from({ length: 5 }, (_, i) => 19_000 + i * 10),
    ];
    const cClustered = temporalCnorm(clustered, now);

    // Uniform: 10 messages evenly spaced
    const uniform = Array.from({ length: 10 }, (_, i) => i * 2000);
    const cUniform = temporalCnorm(uniform, now);

    // Clustered layout should produce higher C_norm (more imbalance)
    expect(cClustered).toBeGreaterThan(cUniform);
  });
});

// ─── compressionRatio ───────────────────────────────────────────────────────

describe("compressionRatio", () => {
  test("returns 0 for zero source tokens", () => {
    expect(compressionRatio(100, 0)).toBe(0);
  });

  test("returns 0 for negative source tokens", () => {
    expect(compressionRatio(100, -10)).toBe(0);
  });

  test("returns k/√N for valid inputs", () => {
    // k=10, N=100 → 10/√100 = 10/10 = 1.0
    expect(compressionRatio(10, 100)).toBe(1.0);
  });

  test("returns < 1.0 for aggressively compressed output", () => {
    // k=5, N=100 → 5/10 = 0.5
    expect(compressionRatio(5, 100)).toBe(0.5);
  });

  test("returns > 1.0 for faithful/verbose compression", () => {
    // k=20, N=100 → 20/10 = 2.0
    expect(compressionRatio(20, 100)).toBe(2.0);
  });

  test("handles large token counts", () => {
    // k=1000, N=1_000_000 → 1000/1000 = 1.0
    expect(compressionRatio(1000, 1_000_000)).toBe(1.0);
  });

  test("returns exactly 1.0 when k = √N", () => {
    // N = 10000, k = 100 → 100/√10000 = 100/100 = 1.0
    expect(compressionRatio(100, 10_000)).toBe(1.0);
  });

  test("realistic distillation: 30 messages → summary", () => {
    // 30 messages averaging 500 tokens each = 15000 source tokens
    // Distilled to 300 tokens of observations
    // R = 300 / √15000 = 300 / 122.47 ≈ 2.45
    const r = compressionRatio(300, 15_000);
    expect(r).toBeGreaterThan(2);
    expect(r).toBeLessThan(3);
  });
});

// ─── Recall recency biasing via RRF ─────────────────────────────────────────

describe("recency-biased RRF fusion", () => {
  // Simulate the pattern used in recall.ts: BM25-sorted list + recency-sorted
  // list of the same items, fused via RRF. Items appearing in both lists get
  // a higher score than items in just one.
  type Item = { id: string; bm25Rank: number; created_at: number };

  function makeItems(): Item[] {
    return [
      { id: "old-relevant", bm25Rank: 0, created_at: 1000 }, // best BM25, oldest
      { id: "mid-mid", bm25Rank: 1, created_at: 5000 }, // mid BM25, mid recency
      { id: "new-weak", bm25Rank: 2, created_at: 9000 }, // worst BM25, newest
    ];
  }

  test("BM25-only: ordered purely by BM25 rank", () => {
    const items = makeItems();
    const bm25List = items; // already sorted by bm25Rank

    const fused = reciprocalRankFusion([
      { items: bm25List, key: (i) => i.id },
    ]);

    expect(fused.map((r) => r.item.id)).toEqual([
      "old-relevant",
      "mid-mid",
      "new-weak",
    ]);
  });

  test("BM25 + recency: items appearing in both lists get boosted", () => {
    const items = makeItems();
    const bm25List = items; // [old-relevant, mid-mid, new-weak]
    const recencyList = [...items].sort((a, b) => b.created_at - a.created_at);
    // recencyList = [new-weak, mid-mid, old-relevant]

    const fused = reciprocalRankFusion([
      { items: bm25List, key: (i) => i.id },
      { items: recencyList, key: (i) => i.id },
    ]);

    // With k=60:
    // old-relevant: rank 0 in BM25 (1/60) + rank 2 in recency (1/62)
    // new-weak: rank 2 in BM25 (1/62) + rank 0 in recency (1/60)
    // → old-relevant and new-weak have equal scores (symmetric)
    // mid-mid: rank 1 in both (2 * 1/61) — very close but slightly less
    //
    // The key property: ALL items get boosted vs BM25-only, and items
    // that are extreme on one axis but weak on the other (old-relevant,
    // new-weak) score the same — the symmetry is correct.
    expect(fused).toHaveLength(3);

    // old-relevant and new-weak should have equal scores (symmetric ranks)
    const oldRelevant = fused.find((r) => r.item.id === "old-relevant")!;
    const newWeak = fused.find((r) => r.item.id === "new-weak")!;
    expect(oldRelevant.score).toBeCloseTo(newWeak.score, 10);
  });

  test("recency list does not duplicate items in output", () => {
    const items = makeItems();
    const bm25List = items;
    const recencyList = [...items].sort((a, b) => b.created_at - a.created_at);

    const fused = reciprocalRankFusion([
      { items: bm25List, key: (i) => i.id },
      { items: recencyList, key: (i) => i.id },
    ]);

    // Should have exactly 3 unique items, not 6
    expect(fused).toHaveLength(3);
    const ids = fused.map((r) => r.item.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("scores are strictly higher with recency list than without", () => {
    const items = makeItems();
    const bm25List = items;
    const recencyList = [...items].sort((a, b) => b.created_at - a.created_at);

    const withoutRecency = reciprocalRankFusion([
      { items: bm25List, key: (i) => i.id },
    ]);
    const withRecency = reciprocalRankFusion([
      { items: bm25List, key: (i) => i.id },
      { items: recencyList, key: (i) => i.id },
    ]);

    // Every item should have a higher score with the recency list
    for (const item of withRecency) {
      const without = withoutRecency.find((r) => r.item.id === item.item.id);
      expect(item.score).toBeGreaterThan(without!.score);
    }
  });
});
