/**
 * Vendored bge-small registration for the standalone Lore binary.
 *
 * The Bun-compiled `lore` binary uses `bun build --compile` to bundle
 * `fastembed` + `onnxruntime-node` + `@anush008/tokenizers-<platform>`
 * directly into the executable — including the platform-specific
 * `.node` addons which Bun embeds and dlopens from `$bunfs` at runtime.
 *
 * Two pieces don't fit into Bun's automatic bundling and need our help:
 *
 *  1. **Side-load shared libraries**. `onnxruntime_binding.node` does a
 *     runtime `dlopen("libonnxruntime.so.1")` (or the .dylib / .dll
 *     equivalent) for the actual ONNX Runtime computation library. Bun
 *     doesn't follow this kind of dependency. The binary's wrapper
 *     pre-loads these libs via `bun:ffi` *before* fastembed evaluates,
 *     so when the addon's dlopen fires it finds the cached handle.
 *
 *  2. **Model weights + tokenizer**. fastembed downloads from the HF
 *     Hub on first use; we want zero network on first run. The wrapper
 *     embeds the bge-small INT8 files as Bun assets, writes them to a
 *     real disk dir on first run, and sets `globalThis.__LORE_VENDOR_MODEL__`
 *     to that path. This module exposes that registration to the
 *     LocalProvider so it can hand the path to fastembed's CUSTOM-mode
 *     init (`modelAbsoluteDirPath` + `modelName`).
 *
 * In npm-mode usage from `@loreai/opencode` / `@loreai/pi` the global
 * is unset and `vendorModelInfo()` returns `null`, so the LocalProvider
 * falls through to fastembed's default Qdrant repo + cache.
 */

// ---------------------------------------------------------------------------
// Vendor registration (set by the binary wrapper, read here)
// ---------------------------------------------------------------------------

/** What the binary wrapper writes to globalThis after extracting model files. */
export interface VendorRegistration {
  /** Absolute path to the dir containing the bge-small files
   *  (config.json, tokenizer.json, model_quantized.onnx, …). Pass to
   *  fastembed as `modelAbsoluteDirPath` in CUSTOM init. */
  modelAbsoluteDirPath: string;
  /** Filename of the ONNX weights inside that dir. Pass to fastembed
   *  as `modelName` in CUSTOM init. */
  modelName: string;
  /** Target identifier the binary was built for, e.g. "linux-x64".
   *  Diagnostic only — the runtime doesn't branch on it. */
  target: string;
  /** Lore CLI version that produced the binary. Diagnostic only. */
  version: string;
}

const REGISTRATION_KEY = "__LORE_VENDOR_MODEL__";

/** Read the vendor registration written by the binary wrapper, if any. */
function getRegistration(): VendorRegistration | null {
  const g = globalThis as unknown as Record<string, VendorRegistration | undefined>;
  return g[REGISTRATION_KEY] ?? null;
}

/** Test-only: programmatically set/clear the registration to exercise
 *  both binary-mode and npm-mode code paths without spinning up a real
 *  compiled binary. */
export function _setVendorRegistration(reg: VendorRegistration | null): void {
  const g = globalThis as unknown as Record<string, VendorRegistration | undefined>;
  if (reg) g[REGISTRATION_KEY] = reg;
  else delete g[REGISTRATION_KEY];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/** Subset of the registration fastembed needs. Stripped of the
 *  diagnostic fields so the LocalProvider has exactly what it should
 *  hand to `FlagEmbedding.init`. */
export interface VendorModelInfo {
  modelAbsoluteDirPath: string;
  modelName: string;
}

/**
 * Resolve the bundled-model arguments for fastembed CUSTOM init. Returns
 * `null` when no vendor is registered (npm-mode), so the caller can fall
 * through to fastembed's default cacheDir/HF Hub flow.
 */
export function vendorModelInfo(): VendorModelInfo | null {
  const reg = getRegistration();
  if (!reg) return null;
  return {
    modelAbsoluteDirPath: reg.modelAbsoluteDirPath,
    modelName: reg.modelName,
  };
}

/** True iff this process is running inside a vendored Lore binary. */
export function isVendoredBinary(): boolean {
  return getRegistration() !== null;
}

/** The full registration, for diagnostics (`lore --print-vendor-info`). */
export function vendorRegistration(): VendorRegistration | null {
  return getRegistration();
}
