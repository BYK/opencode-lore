/**
 * Shared path constants for the embedded-fastembed pipeline. Imported by
 * both `vendor-embeddings.ts` (which produces the staging tree + model
 * cache) and `build.ts` (which generates the per-target wrapper that
 * embeds those files into the Bun-compiled binary).
 *
 * Putting these in one place avoids drift: a typo in either script's
 * copy of the model filename would silently produce a binary that fails
 * at first use ("model file not found"), and we'd only catch it via a
 * smoke test. One source of truth for both producer and consumer.
 *
 * No runtime side effects — safe to import for path lookup.
 */

/** Targets we vendor fastembed for.
 *  - `linux-arm64` absent: `@anush008/tokenizers` has no native pkg.
 *  - `darwin-x64` absent: Apple Silicon-only macOS support (Intel Macs
 *    aren't worth the build/test surface). */
export type VendorTarget =
  | "darwin-arm64"
  | "linux-x64"
  | "windows-x64";

export const VENDOR_TARGETS: VendorTarget[] = [
  "darwin-arm64",
  "linux-x64",
  "windows-x64",
];

/**
 * Subdir name fastembed expects when given `modelAbsoluteDirPath` in
 * CUSTOM init. We keep the layout intentionally minimal — just the
 * model files at the root of this dir, no `fast-` prefix. Mirrored at
 * `packages/core/src/embedding-vendor.ts` (set on globalThis from the
 * binary wrapper).
 */
export const MODEL_DIR_NAME = "bge-small-en-v1.5";

/**
 * Filename of the ONNX weights inside `MODEL_DIR_NAME`. We use the INT8
 * quantized variant from Xenova's HF mirror to keep the binary lean —
 * ~1e-4 absolute cosine-similarity drift vs. FP32, far below the noise
 * floor of any retrieval ranking.
 */
export const MODEL_FILE_NAME = "model_quantized.onnx";

/**
 * Files fastembed reads in CUSTOM mode. All required — a missing file
 * fails init at runtime with a clear "X file not found" error. The
 * vendor downloader produces exactly this set; the wrapper embeds and
 * extracts exactly this set.
 */
export const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  MODEL_FILE_NAME,
] as const;

/**
 * Per-target relative path (from a per-target staging dir) of the
 * dynamic library `onnxruntime_binding.node` dlopens at runtime.
 * onnxruntime-node 1.21 ships native bindings under
 * `bin/napi-v3/<platform>/<arch>/`; the companion shared library lives
 * in the same dir. Linux uses `.so.1`; macOS uses `.1.21.0.dylib`;
 * Windows uses `.dll`. CPU-only inference doesn't need the providers
 * shared lib, so we ship just the core library.
 *
 * Bun's `--compile` embeds .node addons but doesn't follow their
 * dlopen dependencies — the binary wrapper embeds this lib separately
 * and pre-loads it via `bun:ffi.dlopen` so the addon's runtime dlopen
 * finds the cached handle.
 */
export function sideLoadLibRelPath(target: VendorTarget): string {
  const base = "node_modules/onnxruntime-node/bin/napi-v3";
  switch (target) {
    case "linux-x64":
      return `${base}/linux/x64/libonnxruntime.so.1`;
    case "darwin-arm64":
      return `${base}/darwin/arm64/libonnxruntime.1.21.0.dylib`;
    case "windows-x64":
      return `${base}/win32/x64/onnxruntime.dll`;
    default: {
      // Exhaustive — TS makes us update this when adding a target.
      const _: never = target;
      throw new Error(`no side-load lib mapping for target ${_}`);
    }
  }
}

/** Basename of the side-load lib for a given target. The wrapper writes
 *  this name when materialising the lib to disk — the .so/.dylib/.dll
 *  filename is what the addon's dlopen looks for, so it must match. */
export function sideLoadLibBasename(target: VendorTarget): string {
  const rel = sideLoadLibRelPath(target);
  return rel.slice(rel.lastIndexOf("/") + 1);
}
