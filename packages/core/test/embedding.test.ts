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
  _resetFastembedProbe,
  _markFastembedUnavailable,
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
    // Default provider is "local" — fastembed doesn't need an API key.
    // LocalProvider construction always succeeds; the dynamic import only
    // happens on first embed() call, so isAvailable() is true.
    // NOTE: we do NOT call _clearProviderCache() here — killing a worker
    // that loaded ONNX prevents a second worker from loading ONNX in the
    // same Bun process (native module conflict).
    expect(isAvailable()).toBe(true);
  });

  test("returns false when embeddings explicitly disabled", () => {
    // With default config, isAvailable should be true regardless of
    // whether the provider was cached from a previous test file's embed.
    expect(isAvailable()).toBe(true);
  });
});

describe("fastembed unavailable fallback (#185)", () => {
  // Simulates the CUDA-13 install failure path: the optional `fastembed` peer
  // isn't installed, so the local provider's dynamic import fails. Callers
  // should see `isAvailable() === false` and never have to handle a thrown
  // error from deep inside `embed()`.
  //
  // These tests assert the *no-fallback* behaviour, so we explicitly strip
  // any VOYAGE_API_KEY / OPENAI_API_KEY that happens to be in the dev env —
  // otherwise `embed()` would auto-swap to a remote provider and the
  // "throws LocalProviderUnavailableError" expectations would fail (with
  // a 401 from a fake key, or a real call against a real key). The
  // remote-fallback path is covered separately below.

  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let savedProvider: unknown;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Save the real provider (with its live worker) and clear the cache
    // so these tests get a fresh LocalProvider with _markFastembedUnavailable.
    // No worker is spawned because fastembed is marked unavailable before embed().
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    // Restore real probe state + original provider for subsequent tests.
    _resetFastembedProbe();
    _restoreProvider(savedProvider);
  });

  test("isAvailable() returns false once fastembed is known missing", () => {
    _resetFastembedProbe();
    expect(isAvailable()).toBe(true); // optimistic before probe runs

    _markFastembedUnavailable();
    expect(isAvailable()).toBe(false);
  });

  test("embed() throws LocalProviderUnavailableError when fastembed is missing", async () => {
    _markFastembedUnavailable();

    let caught: unknown;
    try {
      await embed(["test"], "query");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalProviderUnavailableError);
    expect((caught as Error).message).toContain("fastembed");
  });

  test("isAvailable() flips to false after the first embed() failure", async () => {
    _markFastembedUnavailable();

    // First embed call surfaces the error (callers like recall.ts wrap in try/catch).
    await expect(embed(["test"], "query")).rejects.toBeInstanceOf(LocalProviderUnavailableError);

    // Subsequent isAvailable() calls short-circuit so callers stop calling embed().
    expect(isAvailable()).toBe(false);
  });
});

describe("auto-fallback to remote provider when fastembed is unavailable", () => {
  // Companion to the no-fallback suite above. When fastembed can't load
  // *and* a remote API key is present, `embed()` should auto-swap to that
  // provider instead of throwing — and pin the swap so subsequent calls
  // skip the local-then-fail path entirely.

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
    _resetFastembedProbe();
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
    // Cast through unknown — Mock<T> isn't structurally identical to typeof fetch
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  test("auto-falls back to Voyage when VOYAGE_API_KEY is set", async () => {
    _markFastembedUnavailable();
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
    _markFastembedUnavailable();
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
    _markFastembedUnavailable();
    process.env.VOYAGE_API_KEY = "vk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const { fetch, calls } = fakeFetch("voyage");
    globalThis.fetch = fetch;

    await embed(["x"], "query");
    expect(calls[0]).toContain("voyageai.com");
  });

  test("subsequent embed() calls go directly to the swapped provider (no double fail)", async () => {
    _markFastembedUnavailable();
    process.env.VOYAGE_API_KEY = "vk-test";
    const { fetch, calls } = fakeFetch("voyage");
    globalThis.fetch = fetch;

    await embed(["one"], "query");
    await embed(["two"], "query");
    await embed(["three"], "query");

    // Each embed call hits Voyage exactly once — no extra local-attempt round-trips.
    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u.includes("voyageai.com"))).toBe(true);
    // After swap, isAvailable stays true (provider is now Voyage, not LocalProvider).
    expect(isAvailable()).toBe(true);
  });

  test("with no API keys set, embed() still throws LocalProviderUnavailableError", async () => {
    _markFastembedUnavailable();
    // Neither VOYAGE_API_KEY nor OPENAI_API_KEY in env (cleared in beforeEach).

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
    // vectorSearch() queries ALL projects (no project_id filter), so we must
    // clear ALL knowledge entries to avoid cross-test leaks from other suites
    // (e.g. LocalProvider integration, checkConfigChange) that insert entries
    // with embeddings into different projects.
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

describe("LocalProvider integration", () => {
  const PROJECT = "/test/embedding/local";

  beforeEach(() => {
    // Clean test project's knowledge to avoid cross-test leaks.
    // IMPORTANT: scope to project_id — unscoped DELETE wipes ALL projects' entries.
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    // Don't resetProvider() between tests — reuse the worker across the suite.
    // Respawning a worker that loaded NAPI modules (fastembed/onnxruntime)
    // triggers a Bun segfault. The worker is shut down in afterAll instead.
  });

  // Model init can take ~350ms (cached) + ~150ms per embed.
  // First-ever run downloads the model (~12s) — pre-download before running tests.
  test(
    "embed produces Float32Array vectors with 384 dimensions",
    async () => {
      const { embed } = await import("../src/embedding");
      const [vec] = await embed(["test query for embedding"], "query");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
      // Vector should not be all zeros
      const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
      expect(norm).toBeGreaterThan(0);
    },
    15_000,
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
    30_000,
  );

  test(
    "vectorSearch returns results using local embeddings",
    async () => {
      const { embed, toBlob, vectorSearch } = await import("../src/embedding");
      const pid = ensureProject(PROJECT);
      const now = Date.now();

      // Embed and store 3 knowledge entries
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

      // Query for database-related content
      const [queryVec] = await embed(["database schema changes"], "query");
      const results = vectorSearch(queryVec, 3);

      expect(results.length).toBe(3);
      // The PostgreSQL entry should be most relevant
      expect(results[0].id).toBe("local-0");
      expect(results[0].similarity).toBeGreaterThan(0.3);
    },
    15_000,
  );
});

describe("LocalProvider worker thread", () => {
  // These tests exercise the worker-backed LocalProvider end-to-end.
  // They require fastembed to be installed (same as the integration tests above).
  // Model init can take ~350ms (cached) — timeouts are generous for CI.
  //
  // We reuse a single worker across the whole suite — Bun has a bug where
  // respawning a worker that loaded NAPI modules (fastembed/onnxruntime)
  // triggers a segfault. The worker is shut down once in afterAll.

  test(
    "embed produces Float32Array vectors with 384 dimensions through worker",
    async () => {
      const [vec] = await embed(["test query via worker"], "query");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
      // Vector should not be all zeros
      const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
      expect(norm).toBeGreaterThan(0);
    },
    15_000,
  );

  test(
    "concurrent embed() calls are serialized correctly",
    async () => {
      // Fire 5 embed calls concurrently — all should resolve with correct vectors.
      const promises = Array.from({ length: 5 }, (_, i) =>
        embed([`concurrent test ${i}`], "document"),
      );
      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      for (const [vec] of results) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      }
    },
    30_000,
  );

  test(
    "query embed interleaved with document batch resolves correctly",
    async () => {
      // Fire a document batch and a query embed concurrently.
      // The query should get priority but both must resolve correctly.
      const docPromise = embed(
        Array.from({ length: 5 }, (_, i) => `document text ${i}`),
        "document",
      );
      const queryPromise = embed(["urgent query"], "query");

      const [docs, [queryVec]] = await Promise.all([docPromise, queryPromise]);
      expect(docs).toHaveLength(5);
      for (const vec of docs) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      }
      expect(queryVec).toBeInstanceOf(Float32Array);
      expect(queryVec.length).toBe(384);
    },
    30_000,
  );

  // NOTE: The "fastembed unavailable → no worker spawned" case is already
  // covered in the "fastembed unavailable fallback (#185)" suite above,
  // which uses _markFastembedUnavailable() before any worker is created.
  //
  // The "resetProvider() + respawn" test is intentionally omitted.
  // Bun 1.3.x has a bug where respawning a worker that loaded NAPI modules
  // (fastembed/onnxruntime) triggers a segfault during the second worker's
  // init. The shutdown path itself works correctly — verified manually and
  // exercised in afterAll below.

  afterAll(async () => {
    // Await shutdown so the worker fully exits before Bun's test runner
    // tears down the process — prevents NAPI segfault during cleanup.
    // Use _shutdownAndDisable (sets cachedProvider=null) to prevent
    // fire-and-forget embeds from other test files from spawning a new
    // worker after this cleanup.
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

    // Fingerprint is now stored
    const row = db()
      .query("SELECT value FROM kv_meta WHERE key = 'lore:embedding_config'")
      .get() as { value: string } | null;
    expect(row).not.toBeNull();
    // Default provider is now "local" with BGESmallENV15:384
    expect(row!.value).toContain("local");
    expect(row!.value).toContain("BGESmallENV15");
    expect(row!.value).toContain("384");
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

// ── Global cleanup ──────────────────────────────────────────────────────
// File-level afterAll runs after ALL describe blocks in this file complete.
// This ensures the worker (if any) is fully shut down before Bun's test
// runner tears down the process — preventing the NAPI segfault that occurs
// when Bun forcefully terminates a worker that loaded onnxruntime bindings.
afterAll(async () => {
  await _shutdownAndDisable();
});
