/**
 * Embedding worker thread — runs ONNX inference via @huggingface/transformers
 * off the main thread.
 *
 * This file is the entry point for a `node:worker_threads` Worker spawned by
 * `LocalProvider` in `embedding.ts`. It owns the transformers.js pipeline
 * and processes embed requests sequentially from a priority queue. Moving
 * inference here keeps the main thread's event loop free — HTTP requests,
 * SSE streams, and session APIs are no longer blocked during embedding.
 *
 * Communication uses `parentPort` message passing with structured clone.
 * Float32Array vectors are sent back directly (Bun preserves identity).
 *
 * The worker applies Nomic's recommended post-processing:
 *   1. Mean pooling (via pipeline option)
 *   2. Layer normalization
 *   3. Matryoshka dimension truncation (if dimensions < full 768)
 *   4. L2 normalization
 *
 * @see embedding-worker-types.ts for the message protocol.
 */

import { parentPort, workerData } from "node:worker_threads";
import type {
  WorkerInbound,
  WorkerOutbound,
  WorkerInitData,
  EmbedRequest,
} from "./embedding-worker-types";

// ---------------------------------------------------------------------------
// workerData
// ---------------------------------------------------------------------------

const { modelId, dimensions, vendorModel } = workerData as WorkerInitData;

// ---------------------------------------------------------------------------
// Model lifecycle — lazy init on first embed request
// ---------------------------------------------------------------------------

/** The transformers.js pipeline instance, typed loosely since the exact
 *  return type depends on the pipeline task. */
type FeatureExtractionPipeline = {
  (texts: string[], options?: Record<string, unknown>): Promise<{
    dims: number[];
    data: Float32Array;
    tolist(): number[][];
  }>;
  dispose?(): Promise<void>;
};

let pipe: FeatureExtractionPipeline | null = null;
let layerNormFn: ((input: unknown, normalized_shape: number[]) => {
  dims: number[];
  data: Float32Array;
  normalize(p: number, dim: number): { tolist(): number[][]; data: Float32Array; dims: number[] };
  slice(...args: unknown[]): { normalize(p: number, dim: number): { tolist(): number[][]; data: Float32Array; dims: number[] } };
}) | null = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;
let initError: string | null = null;

/**
 * Ensure the transformers.js pipeline is loaded. Lazy — first call triggers
 * the dynamic import + pipeline creation, subsequent calls return immediately.
 * On failure, marks the worker as permanently broken and posts `init-error`.
 */
async function ensurePipeline(): Promise<void> {
  if (pipe) return;
  if (initFailed) throw new Error(initError ?? "pipeline init previously failed");

  if (!initPromise) {
    initPromise = (async () => {
      const transformers = await import("@huggingface/transformers");
      const { pipeline, env, layer_norm } = transformers;

      // Configure transformers.js environment
      env.allowRemoteModels = !vendorModel;
      env.allowLocalModels = true;

      if (vendorModel) {
        // Binary mode: point at pre-extracted model files on disk.
        env.localModelPath = vendorModel.localModelPath;
        env.allowRemoteModels = false;
      }

      // Create feature-extraction pipeline with ONNX quantized model.
      // dtype: 'q8' selects the INT8 quantized ONNX variant (model_quantized.onnx)
      // which is ~137MB for Nomic v1.5 vs ~547MB for the full FP32 model.
      //
      // device: "cpu" — in npm mode, transformers.js uses onnxruntime-node
      // (native CPU). In the compiled binary, onnxruntime-node is redirected
      // to onnxruntime-web by the build plugin, which handles "cpu" via its
      // WASM+SIMD backend (API-compatible, ~2x faster on batch workloads).
      pipe = (await pipeline("feature-extraction", modelId, {
        dtype: "q8",
        device: "cpu",
      })) as unknown as FeatureExtractionPipeline;

      layerNormFn = layer_norm as typeof layerNormFn;
    })().catch((err) => {
      initFailed = true;
      initError = err instanceof Error ? err.message : String(err);
      initPromise = null;
      // Notify main thread — all pending + future requests should fail.
      post({ type: "init-error", error: initError });
      throw err;
    });
  }

  await initPromise;
  if (!pipe) throw new Error("pipeline init completed but pipe is null");
}

// ---------------------------------------------------------------------------
// Priority queue — high-priority (recall) jumps ahead of normal (backfill)
// ---------------------------------------------------------------------------

const queue: EmbedRequest[] = [];
let processing = false;

/**
 * Enqueue an embed request. High-priority requests are inserted after any
 * existing high-priority items but before all normal-priority items (FIFO
 * within each priority level). Triggers drain if not already running.
 */
function enqueue(msg: EmbedRequest): void {
  if (msg.priority === "high") {
    // Insert after the last "high" item — keeps FIFO within high priority.
    let insertAt = 0;
    while (insertAt < queue.length && queue[insertAt].priority === "high") {
      insertAt++;
    }
    queue.splice(insertAt, 0, msg);
  } else {
    queue.push(msg);
  }
  drain();
}

/**
 * Process queued requests one at a time. ONNX inference is synchronous
 * inside the NAPI call, so parallelism within the worker buys nothing.
 * The queue gives us a natural point to interleave high-priority requests
 * between normal-priority batches.
 */
async function drain(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const req = queue.shift()!;
    await processEmbed(req);
  }

  processing = false;
}

// ---------------------------------------------------------------------------
// Embed processing
// ---------------------------------------------------------------------------

async function processEmbed(req: EmbedRequest): Promise<void> {
  try {
    await ensurePipeline();

    // Run feature extraction with mean pooling.
    const output = await pipe!(req.texts, { pooling: "mean" });

    // Post-process following Nomic's recipe:
    //   1. Layer normalization over the full hidden dimension
    //   2. Matryoshka truncation to target dimensions
    //   3. L2 normalization
    const fullDim = output.dims[output.dims.length - 1]; // 768 for Nomic v1.5
    const truncate = dimensions < fullDim;

    let normalized: { tolist(): number[][]; data: Float32Array; dims: number[] };
    if (truncate) {
      // layer_norm → slice → L2 normalize
      normalized = layerNormFn!(output, [fullDim])
        .slice(null, [0, dimensions])
        .normalize(2, -1);
    } else {
      // layer_norm → L2 normalize (no truncation)
      normalized = layerNormFn!(output, [fullDim])
        .normalize(2, -1);
    }

    // Extract per-text vectors from the batched tensor.
    const numTexts = req.texts.length;
    const vectors: Float32Array[] = [];
    const dim = truncate ? dimensions : fullDim;

    for (let i = 0; i < numTexts; i++) {
      const start = i * dim;
      const vec = new Float32Array(dim);
      vec.set(normalized.data.subarray(start, start + dim));
      vectors.push(vec);
    }

    post({ type: "result", id: req.id, vectors });
  } catch (err) {
    // Don't re-post init-error — it was already sent in ensurePipeline().
    if (!initFailed) {
      const msg = err instanceof Error ? err.message : String(err);
      post({ type: "error", id: req.id, error: msg });
    }
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function post(msg: WorkerOutbound): void {
  parentPort!.postMessage(msg);
}

parentPort!.on("message", (msg: WorkerInbound) => {
  switch (msg.type) {
    case "embed":
      enqueue(msg);
      break;
    case "shutdown":
      process.exit(0);
      break;
  }
});
