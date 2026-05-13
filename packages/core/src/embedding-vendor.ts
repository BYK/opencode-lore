/**
 * Vendored model registration for the standalone Lore binary.
 *
 * The Bun-compiled `lore` binary bundles `@huggingface/transformers`
 * (which includes ONNX Runtime) into the executable. The model weights
 * and tokenizer files (nomic-embed-text-v1.5, INT8 quantized) are
 * embedded as Bun assets and extracted to a cache dir on first run.
 *
 * The binary's wrapper sets `globalThis.__LORE_VENDOR_MODEL__` to the
 * extraction path. This module exposes that registration to the
 * `LocalProvider` so it can configure the transformers.js `env` to
 * load from the local path instead of downloading from HuggingFace Hub.
 *
 * In npm-mode usage from `@loreai/opencode` / `@loreai/pi` the global
 * is unset and `vendorModelInfo()` returns `null`, so transformers.js
 * downloads the model from HF Hub on first use and caches it locally.
 */

// ---------------------------------------------------------------------------
// Vendor registration (set by the binary wrapper, read here)
// ---------------------------------------------------------------------------

/** What the binary wrapper writes to globalThis after extracting model files. */
export interface VendorRegistration {
  /** Absolute path to the dir containing the model files in HF layout
   *  (config.json, tokenizer.json, onnx/model_quantized.onnx, …).
   *  Passed to transformers.js as `env.localModelPath`. */
  localModelPath: string;
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

/** Subset of the registration the LocalProvider needs. */
export interface VendorModelInfo {
  /** Absolute path to the dir containing the model in HF layout.
   *  Set as `env.localModelPath` in the worker thread. */
  localModelPath: string;
}

/**
 * Resolve the vendored model path for transformers.js local loading.
 * Returns `null` when no vendor is registered (npm-mode), so the caller
 * falls through to transformers.js's default HF Hub download + cache.
 */
export function vendorModelInfo(): VendorModelInfo | null {
  const reg = getRegistration();
  if (!reg) return null;
  return {
    localModelPath: reg.localModelPath,
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
