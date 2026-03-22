/**
 * Voyage AI embedding integration for vector search.
 *
 * Provides embedding generation via Voyage AI's REST API, pure-JS cosine
 * similarity, and vector search over the knowledge table. All operations
 * are gated behind `search.embeddings.enabled` config + `VOYAGE_API_KEY`
 * env var — falls back silently to FTS-only when unavailable.
 */

import { db } from "./db";
import { config } from "./config";
import * as log from "./log";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function getApiKey(): string | undefined {
  return process.env.VOYAGE_API_KEY;
}

/** Returns true if embedding is configured and the API key is present. */
export function isAvailable(): boolean {
  return config().search.embeddings.enabled && !!getApiKey();
}

// ---------------------------------------------------------------------------
// Voyage AI API
// ---------------------------------------------------------------------------

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

/**
 * Call Voyage AI embeddings API.
 *
 * @param texts     Array of texts to embed (max 128 per call)
 * @param inputType "document" for storage, "query" for search
 * @returns         Float32Array per input text
 * @throws          On API errors or missing API key
 */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<Float32Array[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");

  const cfg = config().search.embeddings;

  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: cfg.model,
      input_type: inputType,
      output_dimension: cfg.dimensions,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as VoyageResponse;
  // Sort by index to match input order (API may reorder)
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => new Float32Array(d.embedding));
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
// Vector search
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
      log.info("embedding failed for entry", id, ":", err);
    });
}

// ---------------------------------------------------------------------------
// Config change detection
// ---------------------------------------------------------------------------

/**
 * Build a config fingerprint from model + dimensions.
 * Used to detect when the embedding config changes (model swap, dimension change)
 * so we can clear stale embeddings and re-embed.
 */
function configFingerprint(): string {
  const cfg = config().search.embeddings;
  return `${cfg.model}:${cfg.dimensions}`;
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
  // Read stored fingerprint from schema_version metadata (reuse the table)
  const stored = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(EMBEDDING_CONFIG_KEY) as { value: string } | null;

  const current = configFingerprint();

  if (stored && stored.value === current) return false;

  // Config changed (or first run) — clear all embeddings
  if (stored) {
    const count = db()
      .query("SELECT COUNT(*) as n FROM knowledge WHERE embedding IS NOT NULL")
      .get() as { n: number };
    if (count.n > 0) {
      db().query("UPDATE knowledge SET embedding = NULL").run();
      log.info(
        `embedding config changed (${stored.value} → ${current}), cleared ${count.n} stale embeddings`,
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
// Backfill
// ---------------------------------------------------------------------------

/**
 * Embed all knowledge entries that are missing embeddings.
 * Called on startup when embeddings are first enabled.
 * Also handles config changes: if model/dimensions changed, clears
 * stale embeddings first, then re-embeds all entries.
 * Returns the number of entries embedded.
 */
export async function backfillEmbeddings(): Promise<number> {
  // Detect model/dimension changes and clear stale embeddings
  checkConfigChange();

  const rows = db()
    .query("SELECT id, title, content FROM knowledge WHERE embedding IS NULL AND confidence > 0.2")
    .all() as Array<{ id: string; title: string; content: string }>;

  if (!rows.length) return 0;

  // Batch embed (Voyage supports up to 128 per call)
  const BATCH_SIZE = 128;
  let embedded = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
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
