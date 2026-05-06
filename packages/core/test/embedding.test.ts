import { describe, test, expect, beforeEach } from "bun:test";
import { db, ensureProject } from "../src/db";
import {
  cosineSimilarity,
  toBlob,
  fromBlob,
  isAvailable,
  vectorSearch,
  checkConfigChange,
  resetProvider,
} from "../src/embedding";

describe("cosineSimilarity", () => {
  test("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("similar vectors return high positive value", () => {
    const a = new Float32Array([1, 0.1, 0]);
    const b = new Float32Array([0.9, 0.2, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  test("zero vector returns 0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("both zero vectors return 0", () => {
    const a = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBe(0);
  });
});

describe("BLOB round-trip", () => {
  test("Float32Array survives toBlob → fromBlob", () => {
    const original = new Float32Array([0.123, -0.456, 0.789, 1.0, -1.0]);
    const blob = toBlob(original);
    const restored = fromBlob(blob);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });

  test("single element array", () => {
    const original = new Float32Array([42.5]);
    const restored = fromBlob(toBlob(original));
    expect(restored[0]).toBeCloseTo(42.5, 5);
  });

  test("empty array", () => {
    const original = new Float32Array([]);
    const restored = fromBlob(toBlob(original));
    expect(restored.length).toBe(0);
  });

  test("large array (1024 dims)", () => {
    const original = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) original[i] = Math.random() * 2 - 1;
    const restored = fromBlob(toBlob(original));
    expect(restored.length).toBe(1024);
    for (let i = 0; i < 1024; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });
});

describe("isAvailable", () => {
  test("returns false without VOYAGE_API_KEY", () => {
    // In test environment, VOYAGE_API_KEY should not be set
    const original = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    resetProvider(); // Clear cached provider so isAvailable re-evaluates
    expect(isAvailable()).toBe(false);
    if (original) process.env.VOYAGE_API_KEY = original;
    resetProvider(); // Restore cached provider state
  });
});

describe("vectorSearch", () => {
  const PROJECT = "/test/embedding/vectorsearch";

  beforeEach(() => {
    // vectorSearch has no project filter — clean ALL knowledge to avoid cross-test leaks
    db().query("DELETE FROM knowledge").run();
  });

  test("returns entries sorted by similarity descending", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    // Insert 3 entries with known embeddings
    const vecA = new Float32Array([1, 0, 0]); // matches query perfectly
    const vecB = new Float32Array([0, 1, 0]); // orthogonal to query
    const vecC = new Float32Array([0.9, 0.1, 0]); // similar to query

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-a", pid, "test", "Entry A", "Perfect match", 1.0, now, now, toBlob(vecA));
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-b", pid, "test", "Entry B", "Orthogonal", 1.0, now, now, toBlob(vecB));
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-c", pid, "test", "Entry C", "Similar", 1.0, now, now, toBlob(vecC));

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(3);
    // Entry A should be first (exact match, similarity ≈ 1.0)
    expect(results[0].id).toBe("embed-a");
    expect(results[0].similarity).toBeCloseTo(1.0, 3);
    // Entry C should be second (similar)
    expect(results[1].id).toBe("embed-c");
    expect(results[1].similarity).toBeGreaterThan(0.9);
    // Entry B should be last (orthogonal, similarity ≈ 0.0)
    expect(results[2].id).toBe("embed-b");
    expect(results[2].similarity).toBeCloseTo(0.0, 3);
  });

  test("respects limit parameter", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const vec = new Float32Array([Math.random(), Math.random(), 0]);
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`embed-limit-${i}`, pid, "test", `Entry ${i}`, `Content ${i}`, 1.0, now, now, toBlob(vec));
    }

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 2);
    expect(results.length).toBe(2);
  });

  test("skips entries without embeddings", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    // Entry with embedding
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-yes", pid, "test", "Has Embedding", "Content", 1.0, now, now, toBlob(new Float32Array([1, 0, 0])));

    // Entry without embedding (NULL)
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-no", pid, "test", "No Embedding", "Content", 1.0, now, now);

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("embed-yes");
  });

  test("skips low-confidence entries", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-high", pid, "test", "High Confidence", "Content", 1.0, now, now, toBlob(new Float32Array([1, 0, 0])));

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-low", pid, "test", "Low Confidence", "Content", 0.1, now, now, toBlob(new Float32Array([1, 0, 0])));

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("embed-high");
  });
});

describe("checkConfigChange", () => {
  const PROJECT = "/test/embedding/configchange";

  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM kv_meta WHERE key LIKE 'lore:%'").run();
  });

  test("first call stores fingerprint and returns true", () => {
    const changed = checkConfigChange();
    expect(changed).toBe(true);

    // Fingerprint is now stored
    const row = db()
      .query("SELECT value FROM kv_meta WHERE key = 'lore:embedding_config'")
      .get() as { value: string } | null;
    expect(row).not.toBeNull();
    expect(row!.value).toContain("voyage-code-3");
    expect(row!.value).toContain("1024");
  });

  test("second call with same config returns false", () => {
    checkConfigChange(); // first call
    const changed = checkConfigChange(); // same config
    expect(changed).toBe(false);
  });

  test("clears embeddings when fingerprint changes", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    // Insert entry with embedding
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("cc-1", pid, "test", "Test", "Content", 1.0, now, now, toBlob(new Float32Array([1, 0, 0])));

    // Store a different fingerprint (simulating a previous config)
    db()
      .query("INSERT INTO kv_meta (key, value) VALUES (?, ?)")
      .run("lore:embedding_config", "old-model:512");

    // Check config — should detect change and clear embeddings
    const changed = checkConfigChange();
    expect(changed).toBe(true);

    // Verify embedding was cleared
    const row = db()
      .query("SELECT embedding FROM knowledge WHERE id = 'cc-1'")
      .get() as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });
});
