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
import { isVendoredBinary, vendorModelInfo } from "./embedding-vendor";
import type {
  WorkerInbound,
  WorkerOutbound,
  WorkerInitData,
} from "./embedding-worker-types";

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
 * Thrown when `LocalProvider` is requested but `fastembed` cannot be loaded.
 * `fastembed` is an optionalDependency of `@loreai/core`: if its postinstall
 * fails (e.g. CUDA 13 hits the upstream `onnxruntime-node` bug — see #185),
 * the package install still succeeds but local embeddings are disabled.
 * Callers in `recall.ts` / `ltm.ts` / `distillation.ts` already gate on
 * `isAvailable()`, which flips to `false` after this error fires once.
 */
export class LocalProviderUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Local embedding provider unavailable: 'fastembed' is not installed. " +
        "Configure search.embeddings.provider to 'voyage' or 'openai', or " +
        "reinstall with ONNXRUNTIME_NODE_INSTALL_CUDA=skip to retry the optional fastembed install.",
    );
    this.name = "LocalProviderUnavailableError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/** Cache of the fastembed module-load probe.
 *  null = not yet probed; module = imported successfully; false = import failed. */
let fastembedModule: typeof import("fastembed") | null = null;
let fastembedProbed: boolean = false;
let fastembedAvailable: boolean = false;
let fastembedLogged: boolean = false;

/** For tests: reset the fastembed probe cache. */
export function _resetFastembedProbe(): void {
  fastembedModule = null;
  fastembedProbed = false;
  fastembedAvailable = false;
  fastembedLogged = false;
}

/** For tests: simulate fastembed being unresolvable, without mocking the
 *  dynamic import. After this call, `tryLoadFastembed()` short-circuits to
 *  `null` and `isAvailable()` returns false for the local provider. */
export function _markFastembedUnavailable(): void {
  fastembedModule = null;
  fastembedProbed = true;
  fastembedAvailable = false;
  fastembedLogged = true; // suppress the info log in tests
}

/**
 * Probe `fastembed` once. Returns the module on success, `null` on failure.
 * Logs an info-level note exactly once on the first failure so users know
 * how to recover (switch provider, fix the install, or rely on the
 * VOYAGE/OPENAI auto-fallback in `embed()`).
 *
 * In binary mode `import("fastembed")` resolves to the bundle Bun packed
 * at compile time (the binary's wrapper has already preloaded the
 * side-load `libonnxruntime` lib so the addon's dlopen succeeds). In
 * npm mode it goes through standard module resolution and may fail if
 * the optional postinstall didn't run.
 */
async function tryLoadFastembed(): Promise<typeof import("fastembed") | null> {
  if (fastembedProbed) return fastembedAvailable ? fastembedModule : null;
  try {
    const mod = await loadFastembedModule();
    // Re-check after the async boundary: another caller (e.g. a test helper
    // like _markFastembedUnavailable) may have set the probe while we were
    // awaiting. Their decision takes priority — don't overwrite it.
    if (fastembedProbed) return fastembedAvailable ? fastembedModule : null;
    fastembedModule = mod;
    fastembedAvailable = true;
  } catch (err) {
    if (fastembedProbed) return fastembedAvailable ? fastembedModule : null;
    fastembedAvailable = false;
    if (!fastembedLogged) {
      fastembedLogged = true;
      const msg = err instanceof Error ? err.message : String(err);
      // Binary mode: a load failure here is a real bug (everything was
      // bundled at build time). npm mode: the optional dep didn't
      // install — point the user at the standard recovery options.
      const remediation = isVendoredBinary()
        ? "this is a bug in the lore binary; please file an issue. " +
          "Set VOYAGE_API_KEY/OPENAI_API_KEY for automatic remote fallback in the meantime"
        : "set search.embeddings.provider to 'voyage' or 'openai', " +
          "set VOYAGE_API_KEY/OPENAI_API_KEY for automatic remote fallback, " +
          "or reinstall fastembed with ONNXRUNTIME_NODE_INSTALL_CUDA=skip";
      log.info(
        `local embedding provider unavailable (fastembed not installed: ${msg}) — ${remediation}`,
      );
    }
  } finally {
    fastembedProbed = true;
  }
  return fastembedAvailable ? fastembedModule : null;
}

/**
 * Resolve and import the fastembed module.
 *
 * One bare import covers both modes:
 *
 *   - Binary mode: `bun build --compile` resolves "fastembed" against the
 *     per-target staging `node_modules/` at build time and bundles it
 *     (plus its transitive deps and `.node` addons) into the binary. The
 *     side-load `libonnxruntime.so.1` / `.dylib` / `.dll` is preloaded
 *     by the binary's wrapper before this import evaluates, so the
 *     bundled `onnxruntime_binding.node`'s dlopen finds the cached
 *     handle instead of failing with "shared object not found".
 *
 *   - npm mode: standard Node/Bun resolution — works for `@loreai/core`
 *     consumers whose `npm install` cleanly installed the optional dep.
 *     If the postinstall failed (CUDA-13 hosts), the import throws here
 *     and the caller logs + falls back to a remote provider.
 */
async function loadFastembedModule(): Promise<typeof import("fastembed")> {
  return (await import("fastembed")) as typeof import("fastembed");
}

/** True iff the fastembed probe has run and reported the module missing. */
function fastembedKnownUnavailable(): boolean {
  return fastembedProbed && !fastembedAvailable;
}

/**
 * Local embedding provider using fastembed (bge-small-en-v1.5 by default).
 *
 * No API key required — runs entirely on-device via ONNX Runtime.
 * Model files are downloaded on first use (~33MB) and cached in
 * `~/.cache/fastembed`. Subsequent inits load from disk in ~350ms.
 *
 * ONNX inference runs in a dedicated `node:worker_threads` Worker so the
 * main thread's event loop stays free. This class is a thin RPC client —
 * it posts `{ texts, inputType }` to the worker and awaits a reply.
 * The worker owns the `FlagEmbedding` model and processes requests
 * sequentially from a priority queue (recall queries jump ahead of
 * backfill batches).
 *
 * Uses dynamic import so the module is only loaded when the "local"
 * provider is actually selected — avoids startup cost and allows
 * graceful fallback when the optional `fastembed` peer isn't installed
 * (its native onnxruntime-node may fail to build, e.g. on CUDA 13).
 */
class LocalProvider implements EmbeddingProvider {
  // With inference off the main thread, large batches no longer block
  // the event loop. 256 maximises throughput per round-trip to the
  // worker. Backfill callers use a smaller BACKFILL_CHUNK_SIZE to give
  // the worker's priority queue breathing room for recall queries.
  readonly maxBatchSize = 256;

  private worker: import("node:worker_threads").Worker | null = null;
  private workerReady = false;
  private workerInitError: string | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }
  >();
  private nextRequestId = 0;
  private initPromise: Promise<void> | null = null;
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  /**
   * Ensure the worker thread is running. Probes fastembed on the main
   * thread first (fast, cached) as a fast-fail gate — the worker is only
   * spawned if the module is known-loadable. Worker startup failure is
   * surfaced as `LocalProviderUnavailableError` to trigger the existing
   * auto-fallback to remote providers.
   */
  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return;
    if (this.workerInitError) throw new LocalProviderUnavailableError(this.workerInitError);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Fast-fail: probe fastembed on the main thread. This is cached
      // after the first call and preserves the existing error flow.
      const fastembed = await tryLoadFastembed();
      if (!fastembed) throw new LocalProviderUnavailableError();

      const { Worker } = await import("node:worker_threads");

      // Resolve the worker script path relative to this module.
      // In dev (Bun running .ts directly): embedding-worker.ts
      // In dist (esbuild bundle): embedding-worker.js
      const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
      const workerUrl = new URL(`./embedding-worker${ext}`, import.meta.url);

      const vendor = vendorModelInfo();
      const workerInitData: WorkerInitData = {
        modelName: this.modelName,
        vendorModel: vendor
          ? { modelAbsoluteDirPath: vendor.modelAbsoluteDirPath, modelName: vendor.modelName }
          : null,
      };

      this.worker = new Worker(workerUrl, { workerData: workerInitData });

      // Don't let the worker prevent process exit.
      this.worker.unref();

      // Wire up response handler.
      this.worker.on("message", (msg: WorkerOutbound) => {
        switch (msg.type) {
          case "result": {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              this.updateWorkerRef();
              pending.resolve(msg.vectors);
            }
            break;
          }
          case "error": {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              this.updateWorkerRef();
              pending.reject(new Error(`Worker embedding failed: ${msg.error}`));
            }
            break;
          }
          case "init-error": {
            // Model init failed inside the worker — surface as
            // LocalProviderUnavailableError on all pending + future requests.
            this.workerInitError = msg.error;
            this.workerReady = false;
            for (const [, p] of this.pendingRequests) {
              p.reject(new LocalProviderUnavailableError(msg.error));
            }
            this.pendingRequests.clear();
            this.updateWorkerRef();
            break;
          }
        }
      });

      // Worker crash / exit — reject all in-flight requests.
      this.worker.on("error", (err: Error) => {
        this.workerInitError = err.message;
        this.workerReady = false;
        for (const [, p] of this.pendingRequests) {
          p.reject(new LocalProviderUnavailableError(err));
        }
        this.pendingRequests.clear();
        this.updateWorkerRef();
      });

      this.worker.on("exit", (code) => {
        if (code !== 0 && !this.workerInitError) {
          this.workerInitError = `embedding worker exited with code ${code}`;
        }
        this.workerReady = false;
        for (const [, p] of this.pendingRequests) {
          p.reject(
            new LocalProviderUnavailableError(this.workerInitError ?? "embedding worker exited"),
          );
        }
        this.pendingRequests.clear();
        this.updateWorkerRef();
      });

      this.workerReady = true;
    })().catch((err) => {
      this.initPromise = null; // allow retry
      throw err;
    });

    return this.initPromise;
  }

  /** Keep the worker ref'd while requests are in flight so the event loop
   *  doesn't exit before responses arrive. When the pending map drains,
   *  unref again so the worker doesn't prevent graceful process exit. */
  private updateWorkerRef(): void {
    if (!this.worker) return;
    if (this.pendingRequests.size > 0) {
      this.worker.ref();
    } else {
      this.worker.unref();
    }
  }

  async embed(texts: string[], inputType: "document" | "query"): Promise<Float32Array[]> {
    await this.ensureWorker();

    const id = this.nextRequestId++;
    // Recall queries (single query-type texts) get high priority so they
    // jump ahead of any queued backfill batches in the worker.
    const priority = inputType === "query" && texts.length === 1 ? "high" : "normal";

    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.updateWorkerRef();
      this.worker!.postMessage({
        type: "embed",
        id,
        texts,
        inputType,
        priority,
      } satisfies WorkerInbound);
    });
  }

  /** Shut down the worker thread. Called by `resetProvider()` on config change.
   *  Sends a shutdown message so the worker calls `process.exit(0)` internally.
   *  We avoid `worker.terminate()` because Bun's forced termination triggers a
   *  NAPI fatal error when tearing down onnxruntime's native bindings.
   *
   *  Returns a promise that resolves once the worker has fully exited. Callers
   *  that need a clean teardown (tests, config change) should await the result.
   *  Fire-and-forget callers (process exit) can ignore it. */
  shutdown(): Promise<void> {
    if (!this.worker) return Promise.resolve();

    const worker = this.worker;
    this.worker = null;
    this.workerReady = false;
    this.workerInitError = null;
    this.initPromise = null;

    // Reject any in-flight requests.
    for (const [, p] of this.pendingRequests) {
      p.reject(new Error("embedding worker shut down"));
    }
    this.pendingRequests.clear();

    return new Promise<void>((resolve) => {
      worker.on("exit", () => resolve());
      worker.postMessage({ type: "shutdown" } satisfies WorkerInbound);
    });
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
      // `fastembed` is an optionalDependency. We construct the provider
      // optimistically here; the import + ONNX init happens lazily in
      // `LocalProvider.getModel()`, which throws `LocalProviderUnavailableError`
      // if the optional dep isn't installed. After that first failure
      // `isAvailable()` short-circuits to false and callers fall back to FTS.
      cachedProvider = new LocalProvider(model);
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

/** Reset cached provider — called when config changes.
 *  Shuts down the worker thread if the current provider is a LocalProvider.
 *  Returns a promise that resolves once any worker has fully exited.
 *  Callers that need clean teardown (tests) should await the result. */
export function resetProvider(): Promise<void> {
  let shutdownPromise: Promise<void> = Promise.resolve();
  if (cachedProvider instanceof LocalProvider) {
    shutdownPromise = cachedProvider.shutdown();
  }
  cachedProvider = undefined;
  remoteFallbackLogged = false;
  return shutdownPromise;
}

/** Shut down the current provider and prevent any new provider from being
 *  created. After this call, `embed()` throws and `isAvailable()` returns
 *  false. Test-only: prevents fire-and-forget embeds (queued by other test
 *  files) from spawning a new worker after cleanup. */
export function _shutdownAndDisable(): Promise<void> {
  let shutdownPromise: Promise<void> = Promise.resolve();
  if (cachedProvider instanceof LocalProvider) {
    shutdownPromise = cachedProvider.shutdown();
  }
  cachedProvider = null; // null (not undefined) → getProvider() returns null, won't create new
  remoteFallbackLogged = false;
  return shutdownPromise;
}

/** Save the current cached provider reference (including the live worker)
 *  and clear the cache so the next `getProvider()` call creates a fresh one.
 *  Returns an opaque token that must be passed to `_restoreProvider()` to
 *  put the original provider back — without this, the worker is orphaned and
 *  a second ONNX load in the same Bun process will crash.
 *
 *  Test-only helper: lets suites temporarily swap in a mock/unavailable
 *  provider without killing the real worker. */
export function _saveAndClearProvider(): unknown {
  const saved = { provider: cachedProvider, remoteFallbackLogged };
  cachedProvider = undefined;
  remoteFallbackLogged = false;
  return saved;
}

/** Restore a provider previously saved by `_saveAndClearProvider()`. Any
 *  provider created between save and restore is discarded (callers must
 *  ensure it's not a LocalProvider with a live worker — those suites only
 *  use `_markFastembedUnavailable()` so no worker is spawned). */
export function _restoreProvider(token: unknown): void {
  const saved = token as { provider: EmbeddingProvider | null | undefined; remoteFallbackLogged: boolean };
  cachedProvider = saved.provider;
  remoteFallbackLogged = saved.remoteFallbackLogged;
}

/** True once we've logged an auto-fallback notice this process — keeps the
 *  one-line warning from spamming on every fire-and-forget embed call. */
let remoteFallbackLogged = false;


/**
 * Build a remote `EmbeddingProvider` from whichever API key is in env.
 * Returns `null` when neither `VOYAGE_API_KEY` nor `OPENAI_API_KEY` is set,
 * which is the signal for callers to fall through to FTS-only behaviour.
 *
 * Voyage wins ties because it's the higher-quality option for code search;
 * users who want OpenAI specifically can pin `search.embeddings.provider`
 * in `.lore.json` and skip the fallback path entirely.
 */
export function pickRemoteFallback(): {
  name: "voyage" | "openai";
  provider: EmbeddingProvider;
} | null {
  if (process.env.VOYAGE_API_KEY) {
    const d = PROVIDER_DEFAULTS.voyage;
    return {
      name: "voyage",
      provider: new VoyageProvider(process.env.VOYAGE_API_KEY, d.model, d.dimensions),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    const d = PROVIDER_DEFAULTS.openai;
    return {
      name: "openai",
      provider: new OpenAIProvider(process.env.OPENAI_API_KEY, d.model, d.dimensions),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Returns true if embedding is available.
 *  Active when the configured provider's API key is set, unless explicitly
 *  disabled via `search.embeddings.enabled: false` in .lore.json.
 *
 *  For the `local` provider, also returns false once we've discovered the
 *  optional `fastembed` peer is missing — callers (recall, ltm, distillation)
 *  use this gate to skip embedding work and fall back to FTS-only search. */
export function isAvailable(): boolean {
  const provider = getProvider();
  if (!provider) return false;
  if (provider instanceof LocalProvider && fastembedKnownUnavailable()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public embed API
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for the given texts using the configured provider.
 *
 * If the configured provider is `local` and `fastembed` turns out to be
 * unavailable at runtime (failed install, vendor extraction blocked, etc.),
 * automatically swap to a remote provider when `VOYAGE_API_KEY` or
 * `OPENAI_API_KEY` is set in env. The swap is permanent for the rest of
 * the process — `cachedProvider` is replaced so subsequent calls skip the
 * local-then-fail path.
 *
 * @param texts     Array of texts to embed
 * @param inputType "document" for storage, "query" for search
 * @returns         Float32Array per input text
 * @throws          On API errors or when no provider (local or remote) is
 *                  available
 */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<Float32Array[]> {
  const provider = getProvider();
  if (!provider) throw new Error("No embedding provider available");

  try {
    return await provider.embed(texts, inputType);
  } catch (err) {
    if (!(err instanceof LocalProviderUnavailableError)) throw err;

    const fallback = pickRemoteFallback();
    if (!fallback) throw err;

    if (!remoteFallbackLogged) {
      remoteFallbackLogged = true;
      log.info(
        `fastembed unavailable; auto-switching to ${fallback.name} ` +
          `(set search.embeddings.provider in .lore.json to silence this)`,
      );
    }

    cachedProvider = fallback.provider;
    return fallback.provider.embed(texts, inputType);
  }
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
 * Delay before the startup backfill begins, so the host's HTTP server has
 * a clear window to answer the first wave of requests (web UI shell load,
 * terminal session-connect handshake) before the embedding worker starts
 * competing for CPU. With inference off the main thread the event loop
 * isn't blocked, but the worker still consumes a CPU core — a short delay
 * avoids contention during the first-connect burst.
 */
const STARTUP_BACKFILL_DELAY_MS = 2_000;

/**
 * Run all embedding backfills and log coverage stats.
 *
 * This is the canonical entry point that every host adapter (OpenCode, Pi,
 * future ACP) should call once during init. It:
 *   1. Waits a short grace period so first-connect HTTP requests can finish
 *   2. Detects config changes (provider swap) and clears stale embeddings
 *   3. Backfills knowledge entries missing embeddings
 *   4. Backfills non-archived distillations missing embeddings
 *   5. Logs a one-line coverage summary to stderr (always visible, not gated)
 *
 * Fire-and-forget: callers should `.catch()` — embedding failures must not
 * block plugin initialization.
 */
export async function runStartupBackfill(): Promise<void> {
  if (!isAvailable()) return;

  // Surface backlog up-front so a slow startup is self-explanatory in logs.
  // Counts use the same predicates the backfill loops use, so the two
  // numbers always match what we're about to do.
  const pendingKnowledge = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM knowledge WHERE embedding IS NULL AND confidence > 0.2",
      )
      .get() as { n: number }
  ).n;
  const pendingDistillations = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM distillations WHERE embedding IS NULL AND archived = 0 AND observations != ''",
      )
      .get() as { n: number }
  ).n;

  if (pendingKnowledge + pendingDistillations > 0) {
    log.info(
      `embedding backfill scheduled: ${pendingKnowledge} knowledge + ` +
        `${pendingDistillations} distillations pending — starting in ` +
        `${STARTUP_BACKFILL_DELAY_MS / 1000}s, batches yield between calls ` +
        `(host stays responsive)`,
    );
    await new Promise<void>((r) => setTimeout(r, STARTUP_BACKFILL_DELAY_MS));
  }

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
 * Chunk size for backfill embed requests. Each chunk becomes a separate
 * message to the embedding worker. Keeping chunks small (32) gives the
 * worker's priority queue natural gaps to interleave high-priority recall
 * queries between backfill batches. The provider's `maxBatchSize` (256)
 * is the upper limit for any single embed call; this is intentionally
 * smaller for backfill-vs-live interleaving.
 */
const BACKFILL_CHUNK_SIZE = 32;

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

  let embedded = 0;

  for (let i = 0; i < rows.length; i += BACKFILL_CHUNK_SIZE) {
    const batch = rows.slice(i, i + BACKFILL_CHUNK_SIZE);
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
    // No yieldToEventLoop() needed — embed() is truly async (worker thread).
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

  let embedded = 0;

  // Progress logging: heartbeat every PROGRESS_INTERVAL embedded so a long
  // backfill (e.g. 1000+ pending after a fastembed reinstall) doesn't look
  // like a silent hang. Without this, only the final tally was logged.
  const PROGRESS_INTERVAL = 256;
  let nextProgressAt = PROGRESS_INTERVAL;

  for (let i = 0; i < rows.length; i += BACKFILL_CHUNK_SIZE) {
    const batch = rows.slice(i, i + BACKFILL_CHUNK_SIZE);
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

    if (embedded >= nextProgressAt) {
      log.info(`embedding distillations: ${embedded}/${rows.length}…`);
      nextProgressAt = embedded + PROGRESS_INTERVAL;
    }
    // No yieldToEventLoop() needed — embed() is truly async (worker thread).
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} distillations`);
  }
  return embedded;
}
