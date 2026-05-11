/**
 * Embedding worker thread — runs fastembed/ONNX inference off the main thread.
 *
 * This file is the entry point for a `node:worker_threads` Worker spawned by
 * `LocalProvider` in `embedding.ts`. It owns the `FlagEmbedding` ONNX model
 * and processes embed requests sequentially from a priority queue. Moving
 * inference here keeps the main thread's event loop free — HTTP requests,
 * SSE streams, and session APIs are no longer blocked during embedding.
 *
 * Communication uses `parentPort` message passing with structured clone.
 * Float32Array vectors are sent back directly (Bun preserves identity).
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

const { modelName, vendorModel } = workerData as WorkerInitData;

// ---------------------------------------------------------------------------
// Model lifecycle — lazy init on first embed request
// ---------------------------------------------------------------------------

/** The fastembed model, typed to the subset of methods we use. */
type FastembedModel = {
  queryEmbed(text: string): Promise<number[]>;
  passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][]>;
};

let model: FastembedModel | null = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;
let initError: string | null = null;

/**
 * Ensure the fastembed model is loaded. Lazy — first call triggers the
 * dynamic import + FlagEmbedding.init(), subsequent calls return immediately.
 * On failure, marks the worker as permanently broken and posts `init-error`.
 */
async function ensureModel(): Promise<FastembedModel> {
  if (model) return model;
  if (initFailed) throw new Error(initError ?? "fastembed init previously failed");

  if (!initPromise) {
    initPromise = (async () => {
      const fastembed = await import("fastembed");
      const { EmbeddingModel, FlagEmbedding } = fastembed;

      let m: unknown;
      if (vendorModel) {
        // Binary mode: use pre-extracted model files.
        m = await FlagEmbedding.init({
          model: EmbeddingModel.CUSTOM,
          modelAbsoluteDirPath: vendorModel.modelAbsoluteDirPath,
          modelName: vendorModel.modelName,
        });
      } else {
        // npm mode: resolve model name against fastembed's enum.
        const enumValue = (EmbeddingModel as Record<string, string>)[modelName];
        m = await FlagEmbedding.init({
          model: enumValue ?? modelName,
        } as { model: typeof EmbeddingModel.BGESmallENV15 });
      }
      model = m as FastembedModel;
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
  if (!model) throw new Error("model init completed but model is null");
  return model;
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
    const m = await ensureModel();

    let vectors: Float32Array[];

    if (req.inputType === "query" && req.texts.length === 1) {
      // Single query — use queryEmbed for better quality.
      const vec = await m.queryEmbed(req.texts[0]);
      vectors = [new Float32Array(vec)];
    } else {
      // Batch document embedding via async generator.
      vectors = [];
      for await (const batch of m.passageEmbed(req.texts)) {
        for (const vec of batch) {
          vectors.push(new Float32Array(vec));
        }
      }
    }

    post({ type: "result", id: req.id, vectors });
  } catch (err) {
    // Don't re-post init-error — it was already sent in ensureModel().
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
