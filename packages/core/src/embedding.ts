/**
 * Embedding integration for vector search.
 *
 * Supports multiple embedding providers (Voyage AI, OpenAI) behind a common
 * interface. Provides embedding generation, pure-JS cosine similarity, and
 * vector search over the knowledge and distillation tables. All operations
 * are gated behind `search.embeddings.enabled` config + the provider's API
 * key env var — falls back silently to FTS-only when unavailable.
 */

import { db } from "./db";
import { config } from "./config";
import * as log from "./log";

/** Timeout for embedding API fetch calls (ms). Prevents a hanging API from
 *  blocking the recall tool indefinitely. 10s is generous for typical 100-500ms
 *  embedding calls but bounded enough to avoid minutes-long hangs. */
const EMBED_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(texts: string[], inputType: "document" | "query"): Promise<Float32Array[]>;
  readonly maxBatchSize: number;
}

// ---------------------------------------------------------------------------
// Voyage AI provider
// ---------------------------------------------------------------------------

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

class VoyageProvider implements EmbeddingProvider {
  readonly maxBatchSize = 128;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[], inputType: "document" | "query"): Promise<Float32Array[]> {
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage API ${res.status}: ${body}`);
    }

    const json = (await res.json()) as VoyageResponse;
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";

type OpenAIResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

class OpenAIProvider implements EmbeddingProvider {
  readonly maxBatchSize = 2048;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[], _inputType: "document" | "query"): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    // OpenAI supports dimensions parameter for text-embedding-3-* models
    if (this.model.startsWith("text-embedding-3")) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      throw new Error(`OpenAI API ${res.status}: ${responseBody}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ---------------------------------------------------------------------------
// Local provider (fastembed + ONNX Runtime)
// ---------------------------------------------------------------------------

/**
 * Local embedding provider using fastembed (bge-small-en-v1.5 by default).
 *
 * No API key required — runs entirely on-device via ONNX Runtime.
 * Model files are downloaded on first use (~33MB) and cached in
 * `~/.cache/fastembed`. Subsequent inits load from disk in ~350ms.
 *
 * Uses dynamic import so the module is only loaded when the "local"
 * provider is actually selected — avoids startup cost and allows
 * graceful fallback if fastembed is not installed.
 */
class LocalProvider implements EmbeddingProvider {
  readonly maxBatchSize = 256;
  private model: unknown | null = null;
  private initPromise: Promise<unknown> | null = null;
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  private async getModel(): Promise<unknown> {
    if (this.model) return this.model;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { EmbeddingModel, FlagEmbedding } = await import("fastembed");
        // Map config model string to EmbeddingModel enum value.
        // If the configured model matches an enum key, use it; otherwise try
        // the raw string as a model name (CUSTOM model support in fastembed).
        const enumValue = (EmbeddingModel as Record<string, string>)[this.modelName];
        // fastembed's init() has overloaded signatures expecting specific enum
        // members, but we resolve the model dynamically from config. The enum
        // lookup guarantees a valid value at runtime; cast to satisfy the type.
        const m = await FlagEmbedding.init({
          model: enumValue ?? this.modelName,
        } as { model: typeof EmbeddingModel.BGESmallENV15 });
        this.model = m;
        return m;
      })();
    }
    return this.initPromise;
  }

  async embed(texts: string[], inputType: "document" | "query"): Promise<Float32Array[]> {
    const model = (await this.getModel()) as {
      queryEmbed(text: string): Promise<number[]>;
      passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][]>;
    };

    if (inputType === "query" && texts.length === 1) {
      const vec = await model.queryEmbed(texts[0]);
      return [new Float32Array(vec)];
    }

    // passageEmbed returns an async generator of batches
    const results: Float32Array[] = [];
    for await (const batch of model.passageEmbed(texts)) {
      for (const vec of batch) {
        results.push(new Float32Array(vec));
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Default models per provider — used when config doesn't override. */
const PROVIDER_DEFAULTS: Record<string, { model: string; dimensions: number }> = {
  local: { model: "BGESmallENV15", dimensions: 384 },
  voyage: { model: "voyage-code-3", dimensions: 1024 },
  openai: { model: "text-embedding-3-small", dimensions: 1536 },
};

/** Env var name for each provider's API key. */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  voyage: "VOYAGE_API_KEY",
  openai: "OPENAI_API_KEY",
};

function getProviderApiKey(provider: string): string | undefined {
  const envKey = PROVIDER_ENV_KEYS[provider];
  return envKey ? process.env[envKey] : undefined;
}

let cachedProvider: EmbeddingProvider | null | undefined;

function getProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const cfg = config().search.embeddings;
  if (cfg.enabled === false) {
    cachedProvider = null;
    return null;
  }

  const providerName = cfg.provider;
  const model = cfg.model;

  switch (providerName) {
    case "local": {
      try {
        cachedProvider = new LocalProvider(model);
      } catch {
        log.info("local embedding provider unavailable (fastembed not installed)");
        cachedProvider = null;
      }
      break;
    }
    case "voyage": {
      const apiKey = getProviderApiKey(providerName);
      if (!apiKey) {
        cachedProvider = null;
        return null;
      }
      cachedProvider = new VoyageProvider(apiKey, model, cfg.dimensions);
      break;
    }
    case "openai": {
      const apiKey = getProviderApiKey(providerName);
      if (!apiKey) {
        cachedProvider = null;
        return null;
      }
      cachedProvider = new OpenAIProvider(apiKey, model, cfg.dimensions);
      break;
    }
    default:
      log.info(`unknown embedding provider: ${providerName}`);
      cachedProvider = null;
  }

  return cachedProvider;
}

/** Reset cached provider — called when config changes. */
export function resetProvider(): void {
  cachedProvider = undefined;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Returns true if embedding is available.
 *  Active when the configured provider's API key is set, unless explicitly
 *  disabled via `search.embeddings.enabled: false` in .lore.json. */
export function isAvailable(): boolean {
  return getProvider() !== null;
}

// ---------------------------------------------------------------------------
// Public embed API
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for the given texts using the configured provider.
 *
 * @param texts     Array of texts to embed
 * @param inputType "document" for storage, "query" for search
 * @returns         Float32Array per input text
 * @throws          On API errors or missing provider
 */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<Float32Array[]> {
  const provider = getProvider();
  if (!provider) throw new Error("No embedding provider available");
  return provider.embed(texts, inputType);
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure JS)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two Float32Array vectors.
 * Returns -1.0 to 1.0 where 1.0 = identical direction.
 * Returns 0 if either vector is zero-length.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// BLOB conversion
// ---------------------------------------------------------------------------

/** Convert Float32Array to Buffer for SQLite BLOB storage. */
export function toBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Convert SQLite BLOB (Buffer/Uint8Array) back to Float32Array. */
export function fromBlob(blob: Buffer | Uint8Array): Float32Array {
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Vector search — knowledge
// ---------------------------------------------------------------------------

type VectorHit = { id: string; similarity: number };

/**
 * Search all knowledge entries with embeddings by cosine similarity.
 * Returns top-k entries sorted by similarity descending.
 * Pure brute-force — fine for <100 entries (microseconds).
 */
export function vectorSearch(
  queryEmbedding: Float32Array,
  limit = 10,
): VectorHit[] {
  const rows = db()
    .query("SELECT id, embedding FROM knowledge WHERE embedding IS NOT NULL AND confidence > 0.2")
    .all() as Array<{ id: string; embedding: Buffer }>;

  const scored: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    scored.push({ id: row.id, similarity: sim });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Vector search — distillations
// ---------------------------------------------------------------------------

/**
 * Search non-archived distillations with embeddings by cosine similarity.
 * Returns top-k entries sorted by similarity descending.
 * Pure brute-force — fine for ~50 entries.
 */
export function vectorSearchDistillations(
  queryEmbedding: Float32Array,
  limit = 10,
): VectorHit[] {
  const rows = db()
    .query(
      "SELECT id, embedding FROM distillations WHERE embedding IS NOT NULL AND archived = 0",
    )
    .all() as Array<{ id: string; embedding: Buffer }>;

  const scored: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    scored.push({ id: row.id, similarity: sim });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Fire-and-forget embedding
// ---------------------------------------------------------------------------

/**
 * Embed a knowledge entry and store the result in the DB.
 * Fire-and-forget — errors are logged, never thrown.
 * The entry remains usable via FTS even if embedding fails.
 */
export function embedKnowledgeEntry(
  id: string,
  title: string,
  content: string,
): void {
  const text = `${title}\n${content}`;
  embed([text], "document")
    .then(([vec]) => {
      db()
        .query("UPDATE knowledge SET embedding = ? WHERE id = ?")
        .run(toBlob(vec), id);
    })
    .catch((err) => {
      log.info("embedding failed for knowledge entry", id, ":", err);
    });
}

/**
 * Embed a distillation and store the result in the DB.
 * Fire-and-forget — errors are logged, never thrown.
 * The distillation remains searchable via FTS even if embedding fails.
 */
export function embedDistillation(
  id: string,
  observations: string,
): void {
  embed([observations], "document")
    .then(([vec]) => {
      db()
        .query("UPDATE distillations SET embedding = ? WHERE id = ?")
        .run(toBlob(vec), id);
    })
    .catch((err) => {
      log.info("embedding failed for distillation", id, ":", err);
    });
}

// ---------------------------------------------------------------------------
// Config change detection
// ---------------------------------------------------------------------------

/**
 * Build a config fingerprint from provider + model + dimensions.
 * Used to detect when the embedding config changes (provider swap, model swap,
 * dimension change) so we can clear stale embeddings and re-embed.
 */
function configFingerprint(): string {
  const cfg = config().search.embeddings;
  return `${cfg.provider}:${cfg.model}:${cfg.dimensions}`;
}

const EMBEDDING_CONFIG_KEY = "lore:embedding_config";

/**
 * Check if embedding config has changed since the last backfill.
 * If so, clear all existing embeddings (they're incompatible) and
 * update the stored fingerprint.
 *
 * Returns true if embeddings were cleared (full re-embed needed).
 */
export function checkConfigChange(): boolean {
  // Read stored fingerprint from kv_meta
  const stored = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(EMBEDDING_CONFIG_KEY) as { value: string } | null;

  const current = configFingerprint();

  if (stored && stored.value === current) return false;

  // Config changed (or first run) — clear all embeddings in both tables
  if (stored) {
    const knowledgeCount = db()
      .query("SELECT COUNT(*) as n FROM knowledge WHERE embedding IS NOT NULL")
      .get() as { n: number };
    const distillCount = db()
      .query("SELECT COUNT(*) as n FROM distillations WHERE embedding IS NOT NULL")
      .get() as { n: number };
    const total = knowledgeCount.n + distillCount.n;
    if (total > 0) {
      db().query("UPDATE knowledge SET embedding = NULL").run();
      db().query("UPDATE distillations SET embedding = NULL").run();
      log.info(
        `embedding config changed (${stored.value} → ${current}), cleared ${total} stale embeddings`,
      );
    }
  }

  // Store new fingerprint
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(EMBEDDING_CONFIG_KEY, current, current);

  return true;
}

// ---------------------------------------------------------------------------
// Startup backfill — single entry point for all hosts
// ---------------------------------------------------------------------------

/**
 * Run all embedding backfills and log coverage stats.
 *
 * This is the canonical entry point that every host adapter (OpenCode, Pi,
 * future ACP) should call once during init. It:
 *   1. Detects config changes (provider swap) and clears stale embeddings
 *   2. Backfills knowledge entries missing embeddings
 *   3. Backfills non-archived distillations missing embeddings
 *   4. Logs a one-line coverage summary to stderr (always visible, not gated)
 *
 * Fire-and-forget: callers should `.catch()` — embedding failures must not
 * block plugin initialization.
 */
export async function runStartupBackfill(): Promise<void> {
  if (!isAvailable()) return;

  const knowledgeEmbedded = await backfillEmbeddings();
  const distillationEmbedded = await backfillDistillationEmbeddings();

  // Coverage stats — always log to stderr so the problem is visible.
  const kTotal = (
    db()
      .query("SELECT COUNT(*) as n FROM knowledge WHERE confidence > 0.2")
      .get() as { n: number }
  ).n;
  const kWithEmb = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM knowledge WHERE embedding IS NOT NULL AND confidence > 0.2",
      )
      .get() as { n: number }
  ).n;
  const dTotal = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM distillations WHERE archived = 0 AND observations != ''",
      )
      .get() as { n: number }
  ).n;
  const dWithEmb = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM distillations WHERE embedding IS NOT NULL AND archived = 0",
      )
      .get() as { n: number }
  ).n;

  const parts: string[] = [];
  if (knowledgeEmbedded > 0 || distillationEmbedded > 0) {
    parts.push(`backfilled ${knowledgeEmbedded} knowledge + ${distillationEmbedded} distillations`);
  }
  parts.push(
    `coverage: knowledge ${kWithEmb}/${kTotal}, distillations ${dWithEmb}/${dTotal}`,
  );
  log.info(`embedding startup: ${parts.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Backfill — knowledge
// ---------------------------------------------------------------------------

/**
 * Embed all knowledge entries that are missing embeddings.
 * Called by `runStartupBackfill()`.
 * Also handles config changes: if provider/model/dimensions changed, clears
 * stale embeddings first, then re-embeds all entries.
 * Returns the number of entries embedded.
 */
export async function backfillEmbeddings(): Promise<number> {
  // Detect config changes and clear stale embeddings
  checkConfigChange();

  const provider = getProvider();
  if (!provider) return 0;

  const rows = db()
    .query("SELECT id, title, content FROM knowledge WHERE embedding IS NULL AND confidence > 0.2")
    .all() as Array<{ id: string; title: string; content: string }>;

  if (!rows.length) return 0;

  const batchSize = provider.maxBatchSize;
  let embedded = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const texts = batch.map((r) => `${r.title}\n${r.content}`);

    try {
      const vectors = await embed(texts, "document");
      const update = db().prepare(
        "UPDATE knowledge SET embedding = ? WHERE id = ?",
      );

      for (let j = 0; j < batch.length; j++) {
        update.run(toBlob(vectors[j]), batch[j].id);
        embedded++;
      }
    } catch (err) {
      log.info(`embedding backfill batch ${i}-${i + batch.length} failed:`, err);
    }
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} knowledge entries`);
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Backfill — distillations
// ---------------------------------------------------------------------------

/**
 * Embed all non-archived distillations that are missing embeddings.
 * Called on startup alongside knowledge backfill.
 * Returns the number of distillations embedded.
 */
export async function backfillDistillationEmbeddings(): Promise<number> {
  const provider = getProvider();
  if (!provider) return 0;

  const rows = db()
    .query(
      "SELECT id, observations FROM distillations WHERE embedding IS NULL AND archived = 0 AND observations != ''",
    )
    .all() as Array<{ id: string; observations: string }>;

  if (!rows.length) return 0;

  const batchSize = provider.maxBatchSize;
  let embedded = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const texts = batch.map((r) => r.observations);

    try {
      const vectors = await embed(texts, "document");
      const update = db().prepare(
        "UPDATE distillations SET embedding = ? WHERE id = ?",
      );

      for (let j = 0; j < batch.length; j++) {
        update.run(toBlob(vectors[j]), batch[j].id);
        embedded++;
      }
    } catch (err) {
      log.info(`distillation embedding backfill batch ${i}-${i + batch.length} failed:`, err);
    }
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} distillations`);
  }
  return embedded;
}
