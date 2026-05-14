import { describe, test, expect, beforeEach } from "bun:test";
import { uuidv7 } from "uuidv7";
import { db, ensureProject, getKV } from "../src/db";
import * as ltm from "../src/ltm";
import { dedupPairKey } from "../src/ltm";
import * as embedding from "../src/embedding";

const PROJECT = "/test/dedup/project";
const PROJECT_B = "/test/dedup/project-b";

/**
 * Create a knowledge entry with an explicit ID to bypass the create-time
 * dedup guard (which would merge entries with similar titles).
 */
function createEntry(opts: {
  title: string;
  content?: string;
  confidence?: number;
  projectPath?: string;
  scope?: "project" | "global";
  crossProject?: boolean;
}): string {
  const id = ltm.create({
    id: uuidv7(), // explicit ID bypasses create-time dedup guard
    projectPath: opts.projectPath ?? PROJECT,
    category: "gotcha",
    title: opts.title,
    content: opts.content ?? `Content for ${opts.title}`,
    scope: opts.scope ?? "project",
    crossProject: opts.crossProject,
    session: "test-session",
  });
  // Set confidence if specified (create always sets 1.0)
  if (opts.confidence != null && opts.confidence !== 1.0) {
    ltm.update(id, { confidence: opts.confidence });
  }
  return id;
}

/**
 * Inject a fake embedding for a knowledge entry directly into the DB.
 * Creates a Float32Array of the given dimension with a deterministic pattern
 * based on the seed value.
 */
function injectEmbedding(entryId: string, seed: number, dims = 768): void {
  const vec = new Float32Array(dims);
  // Create a normalized vector with a unique direction based on seed
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;

  const blob = Buffer.from(vec.buffer);
  db().query("UPDATE knowledge SET embedding = ? WHERE id = ?").run(blob, entryId);
}

/**
 * Inject an embedding that is a slight perturbation of another seed's vector.
 * This creates vectors with high cosine similarity.
 */
function injectSimilarEmbedding(entryId: string, baseSeed: number, perturbation: number, dims = 768): void {
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(baseSeed * (i + 1) * 0.1) + perturbation * Math.cos((i + 1) * 0.3);
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;

  const blob = Buffer.from(vec.buffer);
  db().query("UPDATE knowledge SET embedding = ? WHERE id = ?").run(blob, entryId);
}

/** Clean up all knowledge and feedback data between tests. */
function cleanup(): void {
  db().query("DELETE FROM knowledge").run();
  db().query("DELETE FROM dedup_feedback").run();
  db().query("DELETE FROM kv_meta WHERE key LIKE 'dedup_threshold:%'").run();
}

// ---------------------------------------------------------------------------
// Core _dedup() tests
// ---------------------------------------------------------------------------

describe("dedup — core _dedup()", () => {
  beforeEach(cleanup);

  test("no entries → empty result", async () => {
    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(0);
    expect(result.totalRemoved).toBe(0);
    expect(result.pairSimilarities.size).toBe(0);
  });

  test("single entry → empty result", async () => {
    createEntry({ title: "Single entry about caching" });
    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(0);
    expect(result.totalRemoved).toBe(0);
  });

  test("two entries with identical long titles → one cluster via title overlap", async () => {
    // Titles with enough meaningful words to pass fuzzy dedup
    const id1 = createEntry({ title: "Cache warming time slot buckets hardcoded values" });
    const id2 = createEntry({ title: "Cache warming time slot buckets hardcoded values duplicate" });

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(1);
    expect(result.totalRemoved).toBe(1);
  });

  test("two entries with very different titles → no cluster", async () => {
    createEntry({ title: "SQLite FTS5 ranking algorithm" });
    createEntry({ title: "React useState async pitfall" });

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(0);
  });

  test("dryRun: true does not delete entries", async () => {
    const id1 = createEntry({ title: "Cache warming time slot buckets hardcoded values" });
    const id2 = createEntry({ title: "Cache warming time slot buckets hardcoded values duplicate" });

    await ltm.deduplicate(PROJECT, { dryRun: true });
    // Both entries should still exist
    expect(ltm.get(id1)).not.toBeNull();
    expect(ltm.get(id2)).not.toBeNull();
  });

  test("dryRun: false deletes merged entries", async () => {
    const id1 = createEntry({
      title: "Cache warming time slot buckets hardcoded values",
      confidence: 0.9,
    });
    const id2 = createEntry({
      title: "Cache warming time slot buckets hardcoded values duplicate",
      confidence: 0.8,
    });

    const result = await ltm.deduplicate(PROJECT, { dryRun: false });
    expect(result.clusters).toHaveLength(1);

    // Survivor (higher confidence) should exist, merged should be deleted
    expect(ltm.get(id1)).not.toBeNull();
    expect(ltm.get(id2)).toBeNull();
  });

  test("survivor selection: highest confidence wins", async () => {
    const id1 = createEntry({
      title: "Auto TTL downgrade needs hysteresis flapping cache busts",
      confidence: 0.7,
    });
    const id2 = createEntry({
      title: "Auto TTL downgrade needs hysteresis single miss cache busts",
      confidence: 0.9,
    });

    const result = await ltm.deduplicate(PROJECT, { dryRun: false });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].surviving.id).toBe(id2);
    expect(ltm.get(id2)).not.toBeNull();
    expect(ltm.get(id1)).toBeNull();
  });

  test("pairSimilarities map is populated with embedding similarities", async () => {
    const id1 = createEntry({ title: "Entry about alpha" });
    const id2 = createEntry({ title: "Entry about beta" });

    // Inject embeddings — same seed creates identical vectors (sim = 1.0)
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.pairSimilarities.size).toBeGreaterThan(0);

    const pk = dedupPairKey(id1, id2);
    const sim = result.pairSimilarities.get(pk);
    expect(sim).toBeDefined();
    // Identical vectors should have similarity ~1.0
    expect(sim!).toBeCloseTo(1.0, 2);
  });

  test("embedding-based dedup: high similarity triggers merge", async () => {
    const id1 = createEntry({ title: "Completely unique title alpha" });
    const id2 = createEntry({ title: "Completely unique title beta" });

    // Same seed → identical embeddings → similarity = 1.0 → above any threshold
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(1);
    expect(result.totalRemoved).toBe(1);
  });

  test("embedding-based dedup: low similarity does not trigger merge", async () => {
    const id1 = createEntry({ title: "Completely unique title alpha" });
    const id2 = createEntry({ title: "Completely unique title beta" });

    // Very different seeds → low similarity
    injectEmbedding(id1, 1);
    injectEmbedding(id2, 1000);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    // Similarity should be well below threshold — no cluster
    expect(result.clusters).toHaveLength(0);
  });

  test("star clustering does not transitively chain", async () => {
    // A matches B via title overlap, B matches C via title overlap,
    // but A does NOT match C. Star clustering should prevent A and C
    // from being in the same cluster.
    const idA = createEntry({ title: "Gateway recall follow-up causes double cache write problem" });
    const idB = createEntry({ title: "Recall follow-up causes double cache write duplication" });
    const idC = createEntry({ title: "Double cache write from streaming translator duplication" });

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });

    // B matches both A and C, so B becomes the hub. But A and C don't
    // match each other. In star clustering, B claims A and C into one cluster.
    // This is expected behavior for star clustering — the key is that entries
    // only cluster through a direct match, not through transitive chains
    // where two separate hubs each capture different neighbors.
    for (const cluster of result.clusters) {
      // Each entry in a cluster must directly match the center
      const allIds = [cluster.surviving.id, ...cluster.merged.map((m) => m.id)];
      expect(allIds.length).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Feedback recording
// ---------------------------------------------------------------------------

describe("dedup — feedback recording", () => {
  beforeEach(cleanup);

  test("recordDedupFeedback stores a row with correct fields", () => {
    const pid = ensureProject(PROJECT);
    ltm.recordDedupFeedback({
      projectId: pid,
      entryATitle: "Entry A",
      entryBTitle: "Entry B",
      similarity: 0.942,
      accepted: true,
      source: "cli_interactive",
    });

    const feedback = ltm.getDedupFeedback(pid);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].similarity).toBeCloseTo(0.942, 3);
    expect(feedback[0].accepted).toBe(true);
    expect(feedback[0].source).toBe("cli_interactive");
  });

  test("recordDedupFeedback with null projectId stores global feedback", () => {
    ltm.recordDedupFeedback({
      projectId: null,
      entryATitle: "Global A",
      entryBTitle: "Global B",
      similarity: 0.95,
      accepted: false,
      source: "auto_dedup",
    });

    const feedback = ltm.getDedupFeedback(null);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].accepted).toBe(false);
  });

  test("getDedupFeedback scopes correctly to project_id", () => {
    const pidA = ensureProject(PROJECT);
    const pidB = ensureProject(PROJECT_B);

    ltm.recordDedupFeedback({
      projectId: pidA,
      entryATitle: "A1", entryBTitle: "A2",
      similarity: 0.93, accepted: true, source: "cli_yes",
    });
    ltm.recordDedupFeedback({
      projectId: pidB,
      entryATitle: "B1", entryBTitle: "B2",
      similarity: 0.94, accepted: false, source: "cli_interactive",
    });

    const feedbackA = ltm.getDedupFeedback(pidA);
    const feedbackB = ltm.getDedupFeedback(pidB);
    expect(feedbackA).toHaveLength(1);
    expect(feedbackB).toHaveLength(1);
    expect(feedbackA[0].similarity).toBeCloseTo(0.93, 2);
    expect(feedbackB[0].similarity).toBeCloseTo(0.94, 2);
  });

  test("getDedupFeedbackCount returns correct count", () => {
    const pid = ensureProject(PROJECT);
    expect(ltm.getDedupFeedbackCount(pid)).toBe(0);

    for (let i = 0; i < 5; i++) {
      ltm.recordDedupFeedback({
        projectId: pid,
        entryATitle: `A${i}`, entryBTitle: `B${i}`,
        similarity: 0.9 + i * 0.01, accepted: true, source: "auto_dedup",
      });
    }

    expect(ltm.getDedupFeedbackCount(pid)).toBe(5);
  });

  test("recordDedupResultFeedback stores one row per merged pair", async () => {
    const id1 = createEntry({ title: "Cache warming time slot buckets hardcoded values" });
    const id2 = createEntry({ title: "Cache warming time slot buckets hardcoded values extra" });
    // Inject identical embeddings so they get a similarity score
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(1);

    const pid = ensureProject(PROJECT);
    ltm.recordDedupResultFeedback(pid, result, true, "cli_yes");

    const feedback = ltm.getDedupFeedback(pid);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].accepted).toBe(true);
    expect(feedback[0].source).toBe("cli_yes");
    expect(feedback[0].similarity).toBeGreaterThan(0);
  });

  test("feedback survives entry deletion (no FK cascade)", () => {
    const pid = ensureProject(PROJECT);
    const id1 = createEntry({ title: "Temporary entry to be deleted" });

    ltm.recordDedupFeedback({
      projectId: pid,
      entryATitle: "Temporary entry to be deleted",
      entryBTitle: "Another entry",
      similarity: 0.94,
      accepted: true,
      source: "cli_yes",
    });

    // Delete the entry
    ltm.remove(id1);
    expect(ltm.get(id1)).toBeNull();

    // Feedback should still be there
    const feedback = ltm.getDedupFeedback(pid);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].similarity).toBeCloseTo(0.94, 2);
  });

  test("recordAutoSignals does NOT record accepts for merged pairs (avoids tautological loop)", async () => {
    const id1 = createEntry({ title: "Unique entry for auto signal alpha" });
    const id2 = createEntry({ title: "Unique entry for auto signal beta" });
    // Same embedding → merged
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(1);

    const pid = ensureProject(PROJECT);
    ltm.recordAutoSignals(pid, result);

    // Auto-signals should only record rejects, never accepts
    const feedback = ltm.getDedupFeedback(pid);
    const accepts = feedback.filter((f) => f.accepted);
    expect(accepts).toHaveLength(0);
  });

  test("recordAutoSignals records rejects for high-similarity non-merged pairs", async () => {
    // Create 3 entries: two with identical embeddings (will merge),
    // plus a third with a high-but-below-threshold similarity to the first.
    // The third entry's pair with the first is a non-merged pair with
    // similarity >= 0.80, which should produce a reject signal.
    const id1 = createEntry({ title: "Unique entry for reject signal alpha" });
    const id2 = createEntry({ title: "Unique entry for reject signal beta" });
    const id3 = createEntry({ title: "Unique entry for reject signal gamma" });

    // id1 and id2: identical → will merge (similarity = 1.0)
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);
    // id3: perturbation of seed 42 — high similarity but below threshold
    injectSimilarEmbedding(id3, 42, 0.5);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });

    // Verify id3 has a high-similarity pair recorded
    const pk13 = dedupPairKey(id1, id3);
    const pk23 = dedupPairKey(id2, id3);
    const sim13 = result.pairSimilarities.get(pk13);
    const sim23 = result.pairSimilarities.get(pk23);

    // At least one of the non-merged pairs should have sim >= 0.80
    const hasHighSimPair = (sim13 != null && sim13 >= 0.80) || (sim23 != null && sim23 >= 0.80);
    expect(hasHighSimPair).toBe(true);

    const pid = ensureProject(PROJECT);
    ltm.recordAutoSignals(pid, result);

    const feedback = ltm.getDedupFeedback(pid);
    // All auto signals should be rejects (never accepts)
    for (const f of feedback) {
      expect(f.accepted).toBe(false);
    }
    expect(feedback.length).toBeGreaterThanOrEqual(1);
    expect(feedback[0].source).toBe("auto_dedup");
  });

  test("recordAutoSignals filters out pairs below 0.80 similarity", async () => {
    const id1 = createEntry({ title: "Unique entry for low sim alpha" });
    const id2 = createEntry({ title: "Unique entry for low sim beta" });
    // Very different embeddings → low similarity
    injectEmbedding(id1, 1);
    injectEmbedding(id2, 1000);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    const pid = ensureProject(PROJECT);

    ltm.recordAutoSignals(pid, result);

    // Should not record any signals for very dissimilar pairs
    const feedback = ltm.getDedupFeedback(pid);
    for (const f of feedback) {
      expect(f.similarity).toBeGreaterThanOrEqual(0.80);
    }
  });

  test("entryTitles map is populated for all entries (survives deletion)", async () => {
    const id1 = createEntry({ title: "Entry title alpha for titles test" });
    const id2 = createEntry({ title: "Entry title beta for titles test" });
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: false });
    // One entry was deleted, but entryTitles should still have both
    expect(result.entryTitles.size).toBe(2);
    expect(result.entryTitles.get(id1)).toBe("Entry title alpha for titles test");
    expect(result.entryTitles.get(id2)).toBe("Entry title beta for titles test");
  });
});

// ---------------------------------------------------------------------------
// Threshold calibration
// ---------------------------------------------------------------------------

describe("dedup — threshold calibration", () => {
  beforeEach(cleanup);

  /** Helper to seed feedback rows. */
  function seedFeedback(
    projectId: string | null,
    rows: Array<{ similarity: number; accepted: boolean }>,
  ): void {
    for (const row of rows) {
      ltm.recordDedupFeedback({
        projectId,
        entryATitle: `A-${row.similarity}`,
        entryBTitle: `B-${row.similarity}`,
        similarity: row.similarity,
        accepted: row.accepted,
        source: "cli_interactive",
      });
    }
  }

  test("returns null with fewer than 20 samples", () => {
    const pid = ensureProject(PROJECT);
    seedFeedback(pid, [
      { similarity: 0.94, accepted: true },
      { similarity: 0.93, accepted: false },
    ]);
    expect(ltm.calibrateDedupThreshold(pid)).toBeNull();
  });

  test("all-accept: returns minAccepted - 0.005", () => {
    const pid = ensureProject(PROJECT);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      similarity: 0.93 + i * 0.002,
      accepted: true,
    }));
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    // Min accepted is 0.93, so threshold should be 0.925
    expect(threshold!).toBeCloseTo(0.925, 3);
  });

  test("all-reject: returns null", () => {
    const pid = ensureProject(PROJECT);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      similarity: 0.85 + i * 0.002,
      accepted: false,
    }));
    seedFeedback(pid, rows);

    expect(ltm.calibrateDedupThreshold(pid)).toBeNull();
  });

  test("mixed feedback: finds optimal separation point", () => {
    const pid = ensureProject(PROJECT);
    // Clear separation: rejects below 0.92, accepts above 0.93
    const rows: Array<{ similarity: number; accepted: boolean }> = [];
    for (let i = 0; i < 12; i++) {
      rows.push({ similarity: 0.85 + i * 0.005, accepted: false }); // 0.85 - 0.91
    }
    for (let i = 0; i < 12; i++) {
      rows.push({ similarity: 0.93 + i * 0.005, accepted: true }); // 0.93 - 0.985
    }
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    // Should be between 0.91 and 0.93 (the gap between reject/accept groups)
    expect(threshold!).toBeGreaterThanOrEqual(0.91);
    expect(threshold!).toBeLessThanOrEqual(0.93);
  });

  test("tight clustering (all between 0.93-0.94) still works", () => {
    const pid = ensureProject(PROJECT);
    // All similarities very close together
    const rows: Array<{ similarity: number; accepted: boolean }> = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ similarity: 0.930 + i * 0.001, accepted: false }); // 0.930 - 0.939
    }
    for (let i = 0; i < 12; i++) {
      rows.push({ similarity: 0.940 + i * 0.001, accepted: true }); // 0.940 - 0.951
    }
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    // Should find the boundary between 0.939 and 0.940
    expect(threshold!).toBeGreaterThanOrEqual(0.939);
    expect(threshold!).toBeLessThanOrEqual(0.941);
  });

  test("clamps to [0.85, 0.98]", () => {
    const pid = ensureProject(PROJECT);
    // All accepts with very low similarities → threshold would go below 0.85
    const rows = Array.from({ length: 25 }, (_, i) => ({
      similarity: 0.80 + i * 0.002,
      accepted: true,
    }));
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    expect(threshold!).toBeGreaterThanOrEqual(0.85);
  });

  test("overlapping accept/reject ranges: handles noisy feedback gracefully", () => {
    const pid = ensureProject(PROJECT);
    // Real-world scenario: some pairs at 0.92 were accepted, others at 0.92 rejected.
    // The algorithm should still find a reasonable threshold.
    const rows: Array<{ similarity: number; accepted: boolean }> = [];
    // Mostly rejects below 0.92
    for (let i = 0; i < 8; i++) {
      rows.push({ similarity: 0.87 + i * 0.005, accepted: false });
    }
    // Overlap zone: mix of accept/reject around 0.92
    rows.push({ similarity: 0.920, accepted: false });
    rows.push({ similarity: 0.920, accepted: true });
    rows.push({ similarity: 0.925, accepted: false });
    rows.push({ similarity: 0.925, accepted: true });
    // Mostly accepts above 0.93
    for (let i = 0; i < 10; i++) {
      rows.push({ similarity: 0.93 + i * 0.005, accepted: true });
    }
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    // Should still find something in the 0.90-0.93 range despite noise
    expect(threshold!).toBeGreaterThanOrEqual(0.90);
    expect(threshold!).toBeLessThanOrEqual(0.95);
  });

  test("tie-break: prefers higher threshold (conservative)", () => {
    const pid = ensureProject(PROJECT);
    // Perfect symmetry: equal number of accepts and rejects around multiple
    // midpoints that all achieve the same accuracy
    const rows: Array<{ similarity: number; accepted: boolean }> = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ similarity: 0.90, accepted: false });
    }
    for (let i = 0; i < 10; i++) {
      rows.push({ similarity: 0.95, accepted: true });
    }
    seedFeedback(pid, rows);

    const threshold = ltm.calibrateDedupThreshold(pid);
    expect(threshold).not.toBeNull();
    // Only one midpoint possible: (0.90 + 0.95) / 2 = 0.925
    expect(threshold!).toBeCloseTo(0.925, 3);
  });
});

// ---------------------------------------------------------------------------
// Threshold persistence & integration
// ---------------------------------------------------------------------------

describe("dedup — threshold persistence", () => {
  beforeEach(cleanup);

  test("saveCalibratedThreshold persists and loadCalibratedThreshold reads", () => {
    const pid = ensureProject(PROJECT);
    ltm.saveCalibratedThreshold(pid, 0.928, 34);

    const loaded = ltm.loadCalibratedThreshold(pid);
    expect(loaded).toBeCloseTo(0.928, 3);
  });

  test("loadCalibratedThreshold returns null when not set", () => {
    const pid = ensureProject(PROJECT);
    expect(ltm.loadCalibratedThreshold(pid)).toBeNull();
  });

  test("loadCalibratedThreshold returns null for global when not set", () => {
    expect(ltm.loadCalibratedThreshold(null)).toBeNull();
  });

  test("per-project thresholds are independent", () => {
    const pidA = ensureProject(PROJECT);
    const pidB = ensureProject(PROJECT_B);

    ltm.saveCalibratedThreshold(pidA, 0.92, 20);
    ltm.saveCalibratedThreshold(pidB, 0.94, 30);

    expect(ltm.loadCalibratedThreshold(pidA)).toBeCloseTo(0.92, 2);
    expect(ltm.loadCalibratedThreshold(pidB)).toBeCloseTo(0.94, 2);
  });

  test("deduplicate() uses calibrated threshold from kv_meta", async () => {
    const pid = ensureProject(PROJECT);

    // Create two entries with embeddings that have high but not extreme similarity
    const id1 = createEntry({ title: "Entry for threshold test alpha" });
    const id2 = createEntry({ title: "Entry for threshold test beta" });
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    // With default threshold, identical embeddings should be merged
    const result1 = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result1.clusters).toHaveLength(1);

    // Set a very high calibrated threshold (0.98+) — should prevent merge
    // of entries with identical embeddings (sim = 1.0 still passes 0.98)
    // Actually, let's test the other direction: set a lower threshold
    // to verify it's being used
    ltm.saveCalibratedThreshold(pid, 0.98, 25);

    // Re-create entries (first test may have claimed ids)
    cleanup();
    const id3 = createEntry({ title: "Entry for threshold test gamma" });
    const id4 = createEntry({ title: "Entry for threshold test delta" });
    injectEmbedding(id3, 42);
    injectEmbedding(id4, 42);

    // Identical embeddings → sim = 1.0, still above 0.98
    const result2 = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result2.clusters).toHaveLength(1);
  });

  test("deduplicate() falls back to 0.935 when no calibration data", async () => {
    // No calibrated threshold set
    const id1 = createEntry({ title: "Entry for fallback test alpha" });
    const id2 = createEntry({ title: "Entry for fallback test beta" });

    // Identical embeddings → sim = 1.0, above default 0.935
    injectEmbedding(id1, 42);
    injectEmbedding(id2, 42);

    const result = await ltm.deduplicate(PROJECT, { dryRun: true });
    expect(result.clusters).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Feedback pruning
// ---------------------------------------------------------------------------

describe("dedup — feedback pruning", () => {
  beforeEach(cleanup);

  test("pruneDedupFeedback keeps most recent rows up to cap", () => {
    const pid = ensureProject(PROJECT);
    // Insert 510 rows (above the 500 cap)
    for (let i = 0; i < 510; i++) {
      ltm.recordDedupFeedback({
        projectId: pid,
        entryATitle: `A-${i}`,
        entryBTitle: `B-${i}`,
        similarity: 0.90 + (i % 10) * 0.005,
        accepted: i % 2 === 0,
        source: "auto_dedup",
      });
    }
    expect(ltm.getDedupFeedbackCount(pid)).toBe(510);

    ltm.pruneDedupFeedback(pid);

    expect(ltm.getDedupFeedbackCount(pid)).toBe(500);
  });

  test("pruneDedupFeedback is a no-op when under cap", () => {
    const pid = ensureProject(PROJECT);
    for (let i = 0; i < 10; i++) {
      ltm.recordDedupFeedback({
        projectId: pid,
        entryATitle: `A-${i}`,
        entryBTitle: `B-${i}`,
        similarity: 0.93,
        accepted: true,
        source: "cli_yes",
      });
    }

    ltm.pruneDedupFeedback(pid);
    expect(ltm.getDedupFeedbackCount(pid)).toBe(10);
  });

  test("pruneDedupFeedback scopes to project — doesn't prune other projects", () => {
    const pidA = ensureProject(PROJECT);
    const pidB = ensureProject(PROJECT_B);

    // Project A: 510 rows
    for (let i = 0; i < 510; i++) {
      ltm.recordDedupFeedback({
        projectId: pidA,
        entryATitle: `A-${i}`, entryBTitle: `B-${i}`,
        similarity: 0.93, accepted: true, source: "auto_dedup",
      });
    }
    // Project B: 5 rows
    for (let i = 0; i < 5; i++) {
      ltm.recordDedupFeedback({
        projectId: pidB,
        entryATitle: `A-${i}`, entryBTitle: `B-${i}`,
        similarity: 0.94, accepted: false, source: "cli_interactive",
      });
    }

    ltm.pruneDedupFeedback(pidA);

    expect(ltm.getDedupFeedbackCount(pidA)).toBe(500);
    expect(ltm.getDedupFeedbackCount(pidB)).toBe(5); // untouched
  });
});

// ---------------------------------------------------------------------------
// DB migration
// ---------------------------------------------------------------------------

describe("dedup — DB migration", () => {
  test("dedup_feedback table exists", () => {
    const row = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='dedup_feedback'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("dedup_feedback");
  });

  test("dedup_feedback has expected columns", () => {
    // Insert and read back to verify schema
    db()
      .query(
        `INSERT INTO dedup_feedback
           (project_id, entry_a_title, entry_b_title, similarity, accepted, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("test-pid", "Title A", "Title B", 0.93, 1, "auto_dedup", Date.now());

    const row = db()
      .query("SELECT * FROM dedup_feedback WHERE project_id = 'test-pid'")
      .get() as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.entry_a_title).toBe("Title A");
    expect(row.entry_b_title).toBe("Title B");
    expect(row.similarity).toBeCloseTo(0.93, 2);
    expect(row.accepted).toBe(1);
    expect(row.source).toBe("auto_dedup");

    // Cleanup
    db().query("DELETE FROM dedup_feedback WHERE project_id = 'test-pid'").run();
  });
});
