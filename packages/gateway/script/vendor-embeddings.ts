/**
 * Download and cache the embedding model files for binary builds.
 *
 * @huggingface/transformers bundles its own ONNX Runtime, so we don't need
 * per-target staging trees with platform-specific native bindings. We just
 * need the model files (config, tokenizer, ONNX weights) in HuggingFace
 * repo layout.
 *
 * Outputs (side effects only — no stdout product):
 *   - `<repo>/.vendor-build/.model-cache/<MODEL_DIR_NAME>/` — model files
 *     in HF layout, downloaded once from HuggingFace Hub. Platform-independent
 *     (pure ONNX + JSON), so build.ts embeds the same files into every
 *     per-target binary.
 *
 * Usage:
 *   bun run packages/gateway/script/vendor-embeddings.ts
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_DIR_NAME,
  MODEL_ID,
  MODEL_FILES,
} from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));

console.log(`→ vendor-embeddings: model=${MODEL_ID}`);

await ensureSharedModelCache();

// ---------------------------------------------------------------------------
// Shared model cache (nomic-embed-text-v1.5)
// ---------------------------------------------------------------------------

/**
 * Ensure `<repo>/.vendor-build/.model-cache/<MODEL_DIR_NAME>/` is populated
 * with all files transformers.js needs to load the model locally.
 *
 * We download from `nomic-ai/nomic-embed-text-v1.5` on HuggingFace Hub.
 * The INT8 quantized ONNX model is ~137 MB; config + tokenizer files are
 * a few hundred KB total.
 *
 * Layout matches the HF repo structure that transformers.js expects:
 *   <model_dir>/config.json
 *   <model_dir>/tokenizer.json
 *   <model_dir>/tokenizer_config.json
 *   <model_dir>/special_tokens_map.json
 *   <model_dir>/onnx/model_quantized.onnx
 */
async function ensureSharedModelCache(): Promise<string> {
  const sharedCache = join(repoRoot, ".vendor-build", ".model-cache");
  const modelDir = join(sharedCache, MODEL_DIR_NAME);

  const allPresent = MODEL_FILES.every((f) => existsSync(join(modelDir, f)));
  if (allPresent) {
    console.log(`✓ shared model cache hit at ${relative(repoRoot, modelDir)}/`);
    return sharedCache;
  }

  console.log(`→ downloading ${MODEL_ID} (INT8 quantized, ~137 MB)`);
  // Create dirs including onnx/ subdir
  mkdirSync(join(modelDir, "onnx"), { recursive: true });

  const baseUrl = `https://huggingface.co/${MODEL_ID}/resolve/main`;

  for (const filePath of MODEL_FILES) {
    const url = `${baseUrl}/${filePath}`;
    const dest = join(modelDir, filePath);

    console.log(`  ↓ ${filePath}`);
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`✗ download failed: ${url} → HTTP ${r.status} ${r.statusText}`);
      process.exit(1);
    }
    writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
  }

  const sizeMb = dirSizeBytes(modelDir) / 1024 / 1024;
  console.log(
    `✓ model cached at ${relative(repoRoot, modelDir)}/ (${sizeMb.toFixed(1)} MB)`,
  );
  return sharedCache;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size;
  }
  return total;
}
