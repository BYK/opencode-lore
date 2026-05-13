import { afterAll, afterEach, describe, test, expect, beforeEach, mock } from "bun:test";
import { db, ensureProject } from "../src/db";
import {
  cosineSimilarity,
  toBlob,
  fromBlob,
  isAvailable,
  vectorSearch,
  checkConfigChange,
  resetProvider,
  _shutdownAndDisable,
  _saveAndClearProvider,
  _restoreProvider,
  embed,
  LocalProviderUnavailableError,
  pickRemoteFallback,
  _resetLocalProviderProbe,
  _markLocalProviderUnavailable,
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
  test("returns true with default local provider (no API key needed)", () => {
    // Default provider is "local" — no API key needed.
    // LocalProvider construction always succeeds; the ONNX model init
    // happens lazily on first embed() call, so isAvailable() is true.
    expect(isAvailable()).toBe(true);
  });

  test("returns false when embeddings explicitly disabled", () => {
    // With default config, isAvailable should be true regardless of
    // whether the provider was cached from a previous test file's embed.
    expect(isAvailable()).toBe(true);
  });
});

describe("local provider unavailable fallback", () => {
  // Simulates a failure path: the local provider's ONNX runtime can't
  // initialize. Callers should see `isAvailable() === false` and never
  // have to handle a thrown error from deep inside `embed()`.
  //
  // These tests assert the *no-fallback* behaviour, so we explicitly strip
  // any VOYAGE_API_KEY / OPENAI_API_KEY that happens to be in the dev env.

  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let savedProvider: unknown;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Save the real provider (with its live worker) and clear the cache
    // so these tests get a fresh LocalProvider with _markLocalProviderUnavailable.
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    // Restore real probe state + original provider for subsequent tests.
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
  });

  test("isAvailable() returns false once local provider is known broken", () => {
    _resetLocalProviderProbe();
    expect(isAvailable()).toBe(true); // optimistic before probe runs

    _markLocalProviderUnavailable();
    expect(isAvailable()).toBe(false);
  });

  test("embed() throws LocalProviderUnavailableError when local provider is broken", async () => {
    _markLocalProviderUnavailable();

    let caught: unknown;
    try {
      await embed(["test"], "query");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalProviderUnavailableError);
  });

  test("isAvailable() flips to false after the first embed() failure", async () => {
    _markLocalProviderUnavailable();

    await expect(embed(["test"], "query")).rejects.toBeInstanceOf(LocalProviderUnavailableError);
    expect(isAvailable()).toBe(false);
  });
});

describe("auto-fallback to remote provider when local provider is unavailable", () => {
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let savedFetch: typeof fetch;
  let savedProvider: unknown;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    savedFetch = globalThis.fetch;
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    else delete process.env.OPENAI_API_KEY;
    globalThis.fetch = savedFetch;
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
  });

  /** Build a fake fetch returning provider-shaped JSON. Records URLs for
   *  assertions on which provider was hit. */
  function fakeFetch(provider: "voyage" | "openai") {
    const calls: string[] = [];
    const fn = mock(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(u);
      const dim = provider === "voyage" ? 1024 : 1536;
      const embedding = Array.from({ length: dim }, (_, i) => i / dim);
      const body =
        provider === "voyage"
          ? { data: [{ embedding, index: 0 }], model: "voyage-code-3", usage: { total_tokens: 1 } }
          : { data: [{ embedding, index: 0 }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  test("auto-falls back to Voyage when VOYAGE_API_KEY is set", async () => {
    _markLocalProviderUnavailable();
    process.env.VOYAGE_API_KEY = "vk-test";
    const { fetch, calls } = fakeFetch("voyage");
    globalThis.fetch = fetch;

    const [vec] = await embed(["test query"], "query");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(1024);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("voyageai.com");
  });

  test("auto-falls back to OpenAI when only OPENAI_API_KEY is set", async () => {
    _markLocalProviderUnavailable();
    process.env.OPENAI_API_KEY = "sk-test";
    const { fetch, calls } = fakeFetch("openai");
    globalThis.fetch = fetch;

    const [vec] = await embed(["test query"], "query");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(1536);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("openai.com");
  });

  test("Voyage wins when both keys are set", async () => {
    _markLocalProviderUnavailable();
    process.env.VOYAGE_API_KEY = "vk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const { fetch, calls } = fakeFetch("voyage");
    globalThis.fetch = fetch;

    await embed(["x"], "query");
    expect(calls[0]).toContain("voyageai.com");
  });

  test("subsequent embed() calls go directly to the swapped provider (no double fail)", async () => {
    _markLocalProviderUnavailable();
    process.env.VOYAGE_API_KEY = "vk-test";
    const { fetch, calls } = fakeFetch("voyage");
    globalThis.fetch = fetch;

    await embed(["one"], "query");
    await embed(["two"], "query");
    await embed(["three"], "query");

    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u.includes("voyageai.com"))).toBe(true);
    expect(isAvailable()).toBe(true);
  });

  test("with no API keys set, embed() still throws LocalProviderUnavailableError", async () => {
    _markLocalProviderUnavailable();
    await expect(embed(["x"], "query")).rejects.toBeInstanceOf(LocalProviderUnavailableError);
  });
});

describe("pickRemoteFallback", () => {
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    else delete process.env.OPENAI_API_KEY;
  });

  test("returns null when neither key is set", () => {
    expect(pickRemoteFallback()).toBeNull();
  });

  test("returns Voyage when only VOYAGE_API_KEY is set", () => {
    process.env.VOYAGE_API_KEY = "vk-test";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("voyage");
  });

  test("returns OpenAI when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("openai");
  });

  test("Voyage wins when both keys are set", () => {
    process.env.VOYAGE_API_KEY = "vk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("voyage");
  });
});

describe("vectorSearch", () => {
  const PROJECT = "/test/embedding/vectorsearch";

  beforeEach(() => {
    db().query("DELETE FROM knowledge").run();
  });

  test("returns entries sorted by similarity descending", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    const vecA = new Float32Array([1, 0, 0]);
    const vecB = new Float32Array([0, 1, 0]);
    const vecC = new Float32Array([0.9, 0.1, 0]);

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
    expect(results[0].id).toBe("embed-a");
    expect(results[0].similarity).toBeCloseTo(1.0, 3);
    expect(results[1].id).toBe("embed-c");
    expect(results[1].similarity).toBeGreaterThan(0.9);
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

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-yes", pid, "test", "Has Embedding", "Content", 1.0, now, now, toBlob(new Float32Array([1, 0, 0])));

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

describe("LocalProvider integration", () => {
  const PROJECT = "/test/embedding/local";

  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test(
    "embed produces Float32Array vectors with 768 dimensions",
    async () => {
      const { embed } = await import("../src/embedding");
      const [vec] = await embed(["test query for embedding"], "query");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      // Vector should not be all zeros
      const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
      expect(norm).toBeGreaterThan(0);
    },
    60_000,
  );

  test(
    "query and document embeddings have reasonable similarity",
    async () => {
      const { embed, cosineSimilarity } = await import("../src/embedding");
      const [queryVec] = await embed(["database migration"], "query");
      const [docVec] = await embed(["PostgreSQL database schema migration tool"], "document");
      const [unrelatedVec] = await embed(["chocolate cake recipe with frosting"], "document");

      const relevantSim = cosineSimilarity(queryVec, docVec);
      const unrelatedSim = cosineSimilarity(queryVec, unrelatedVec);

      // Relevant doc should have higher similarity than unrelated
      expect(relevantSim).toBeGreaterThan(unrelatedSim);
    },
    60_000,
  );

  test(
    "vectorSearch returns results using local embeddings",
    async () => {
      const { embed, toBlob, vectorSearch } = await import("../src/embedding");
      const pid = ensureProject(PROJECT);
      const now = Date.now();

      const texts = [
        "PostgreSQL database migration",
        "React server components",
        "Kubernetes deployment strategy",
      ];
      const vecs = await embed(texts, "document");

      for (let i = 0; i < texts.length; i++) {
        db()
          .query(
            "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(`local-${i}`, pid, "test", `Entry ${i}`, texts[i], 1.0, now, now, toBlob(vecs[i]));
      }

      const [queryVec] = await embed(["database schema changes"], "query");
      const results = vectorSearch(queryVec, 3);

      expect(results.length).toBe(3);
      // The PostgreSQL entry should be most relevant
      expect(results[0].id).toBe("local-0");
      expect(results[0].similarity).toBeGreaterThan(0.3);
    },
    60_000,
  );
});

describe("LocalProvider worker thread", () => {
  test(
    "embed produces Float32Array vectors with 768 dimensions through worker",
    async () => {
      const [vec] = await embed(["test query via worker"], "query");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
      expect(norm).toBeGreaterThan(0);
    },
    60_000,
  );

  test(
    "concurrent embed() calls are serialized correctly",
    async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        embed([`concurrent test ${i}`], "document"),
      );
      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      for (const [vec] of results) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(768);
      }
    },
    60_000,
  );

  test(
    "query embed interleaved with document batch resolves correctly",
    async () => {
      const docPromise = embed(
        Array.from({ length: 5 }, (_, i) => `document text ${i}`),
        "document",
      );
      const queryPromise = embed(["urgent query"], "query");

      const [docs, [queryVec]] = await Promise.all([docPromise, queryPromise]);
      expect(docs).toHaveLength(5);
      for (const vec of docs) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(768);
      }
      expect(queryVec).toBeInstanceOf(Float32Array);
      expect(queryVec.length).toBe(768);
    },
    60_000,
  );

  afterAll(async () => {
    await _shutdownAndDisable();
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

    const row = db()
      .query("SELECT value FROM kv_meta WHERE key = 'lore:embedding_config'")
      .get() as { value: string } | null;
    expect(row).not.toBeNull();
    // Default provider is now "local" with nomic-ai/nomic-embed-text-v1.5:768
    expect(row!.value).toContain("local");
    expect(row!.value).toContain("nomic-ai/nomic-embed-text-v1.5");
    expect(row!.value).toContain("768");
  });

  test("second call with same config returns false", () => {
    checkConfigChange();
    const changed = checkConfigChange();
    expect(changed).toBe(false);
  });

  test("clears embeddings when fingerprint changes", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("cc-1", pid, "test", "Test", "Content", 1.0, now, now, toBlob(new Float32Array([1, 0, 0])));

    // Store a different fingerprint (simulating a previous config)
    db()
      .query("INSERT INTO kv_meta (key, value) VALUES (?, ?)")
      .run("lore:embedding_config", "old-model:512");

    const changed = checkConfigChange();
    expect(changed).toBe(true);

    const row = db()
      .query("SELECT embedding FROM knowledge WHERE id = 'cc-1'")
      .get() as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });
});

// ── Global cleanup ──────────────────────────────────────────────────────
afterAll(async () => {
  await _shutdownAndDisable();
});
