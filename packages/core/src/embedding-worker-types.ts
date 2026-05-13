/**
 * Shared message types for the embedding worker thread.
 *
 * The embedding worker (`embedding-worker.ts`) runs ONNX inference via
 * `@huggingface/transformers` in a separate `node:worker_threads` Worker
 * so the main thread's event loop stays free during inference. This file
 * defines the message protocol between the main thread (`LocalProvider`
 * in `embedding.ts`) and the worker.
 *
 * Imported by both sides — keep this file free of runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Main thread → Worker
// ---------------------------------------------------------------------------

/** Request an embedding batch. */
export interface EmbedRequest {
  type: "embed";
  /** Monotonic request ID for correlating responses. */
  id: number;
  /** Texts to embed (already prefixed with task instruction by the caller). */
  texts: string[];
  /** "document" for storage, "query" for search. */
  inputType: "document" | "query";
  /** "high" = recall queries (jump the queue), "normal" = backfill. */
  priority: "high" | "normal";
}

/** Ask the worker to exit cleanly. */
export interface ShutdownRequest {
  type: "shutdown";
}

export type WorkerInbound = EmbedRequest | ShutdownRequest;

// ---------------------------------------------------------------------------
// Worker → Main thread
// ---------------------------------------------------------------------------

/** Embedding result — vectors are Float32Array[], sent via structured clone. */
export interface EmbedResult {
  type: "result";
  /** Matches the request ID. */
  id: number;
  /** One Float32Array per input text. Sent via structured clone
   *  (Bun preserves Float32Array identity across threads). */
  vectors: Float32Array[];
}

/** A single embed request failed (ONNX error, etc.). */
export interface EmbedError {
  type: "error";
  /** Matches the request ID. */
  id: number;
  /** Human-readable error message. */
  error: string;
}

/** Model initialization failed inside the worker. All pending and future
 *  requests should be rejected — the worker is unusable. */
export interface InitError {
  type: "init-error";
  /** Human-readable error message. */
  error: string;
}

export type WorkerOutbound = EmbedResult | EmbedError | InitError;

// ---------------------------------------------------------------------------
// workerData contract
// ---------------------------------------------------------------------------

/** Passed to the worker via `workerData` at construction time. */
export interface WorkerInitData {
  /** HuggingFace model ID, e.g. "nomic-ai/nomic-embed-text-v1.5". */
  modelId: string;
  /** Target embedding dimensions. For Nomic v1.5 with Matryoshka,
   *  this controls how many leading dims to keep (64–768). */
  dimensions: number;
  /** Vendored model info for binary mode, or null for npm mode.
   *  In binary mode, model files are pre-extracted to a local dir
   *  and we point transformers.js at that path instead of downloading
   *  from HuggingFace Hub. */
  vendorModel: {
    /** Absolute path to the dir containing model files
     *  (config.json, tokenizer.json, onnx/model_quantized.onnx, …). */
    localModelPath: string;
  } | null;
}
