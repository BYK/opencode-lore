/**
 * Shared path constants for the embedded-model pipeline. Imported by
 * both `vendor-embeddings.ts` (which produces the model cache) and
 * `build.ts` (which generates the per-target wrapper that embeds those
 * files into the Bun-compiled binary).
 *
 * Putting these in one place avoids drift: a typo in either script's
 * copy of the model filename would silently produce a binary that fails
 * at first use ("model file not found"), and we'd only catch it via a
 * smoke test. One source of truth for both producer and consumer.
 *
 * No runtime side effects — safe to import for path lookup.
 */

/** Targets we build binaries for.
 *  - `darwin-x64` absent: Apple Silicon-only macOS support (Intel Macs
 *    aren't worth the build/test surface). */
export type VendorTarget =
  | "darwin-arm64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

export const VENDOR_TARGETS: VendorTarget[] = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
];

/**
 * HuggingFace model ID for the embedded model.
 * Used by the vendor downloader to fetch from HF Hub.
 */
export const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";

/**
 * Directory name for the model inside localModelPath. Uses the HF model
 * ID directly — transformers.js resolves local paths as
 * `pathJoin(env.localModelPath, modelId, filename)`.
 */
export const MODEL_DIR_NAME = "nomic-ai/nomic-embed-text-v1.5";

/**
 * Filename of the ONNX weights. We use the INT8 quantized variant
 * (~137 MB) to keep the binary lean while maintaining good quality.
 */
export const MODEL_FILE_NAME = "model_quantized.onnx";

/**
 * Files needed by transformers.js to load the model locally.
 * The model must be laid out in HuggingFace repo structure:
 *   <model_dir>/config.json
 *   <model_dir>/tokenizer.json
 *   <model_dir>/tokenizer_config.json
 *   <model_dir>/special_tokens_map.json
 *   <model_dir>/onnx/model_quantized.onnx
 *
 * All required — a missing file fails init at runtime.
 */
export const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  `onnx/${MODEL_FILE_NAME}`,
] as const;
