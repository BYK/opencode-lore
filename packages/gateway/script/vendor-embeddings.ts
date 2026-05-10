/**
 * Prepare the per-target staging tree + shared model cache the binary
 * builder consumes. No tarball production — `bun build --compile` walks
 * the wrapper's imports and bundles fastembed + onnxruntime-node +
 * @anush008/tokenizers-* directly into the binary, so we just need the
 * staging tree to exist on disk for Bun's resolver to walk at compile
 * time.
 *
 * Outputs (side effects only — no stdout product):
 *   - `<repo>/.vendor-build/<target>/` — per-target node_modules, populated
 *     via `bun install --os=<os> --cpu=<cpu>` so each target gets the
 *     right `@anush008/tokenizers-<platform>` and the correct
 *     `onnxruntime-node` native bindings selected at compile time by Bun.
 *   - `<repo>/.vendor-build/.model-cache/bge-small-en-v1.5/` — Xenova INT8
 *     bge-small files, downloaded once. The model is platform-independent
 *     (pure ONNX + JSON), so build.ts embeds the same files into every
 *     per-target binary.
 *
 * **Cross-platform from a single host.** Bun's `--os` and `--cpu` flags
 * filter `optionalDependencies` correctly, so this script runs on any
 * Linux box and produces staging trees for all four supported targets
 * — no GH Actions matrix required. The native `.node` files for
 * `onnxruntime-node` are shipped directly inside its npm package (one
 * fat tarball with binaries for every platform), and `@anush008/tokenizers`
 * resolves to a per-target subpackage which Bun selects via the override
 * flags.
 *
 * **linux-arm64 is unsupported by fastembed.** `@anush008/tokenizers` only
 * ships native packages for `linux-x64-gnu`, `darwin-universal`, and
 * `win32-x64-msvc`. linux-arm64 builds therefore ship without embedded
 * fastembed; users on that platform fall through to the remote-provider
 * auto-fallback (or FTS-only if no API key).
 *
 * Usage:
 *   bun run packages/gateway/script/vendor-embeddings.ts --target <target>
 *
 *   --target  One of: darwin-arm64, linux-x64, windows-x64.
 *             Defaults to the current host. linux-arm64 is rejected.
 *   --all     Prepare staging for all supported targets (ignores --target).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  MODEL_DIR_NAME,
  MODEL_FILE_NAME,
  MODEL_FILES,
  VENDOR_TARGETS,
  sideLoadLibRelPath,
  type VendorTarget as Target,
} from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Targets fastembed can be vendored for. linux-arm64 is excluded —
 *  `@anush008/tokenizers` doesn't publish a native package for that platform
 *  (only linux-x64-gnu, darwin-universal, win32-x64-msvc), so a tarball
 *  produced for it would be missing the tokenizer .node and would fail
 *  at runtime. linux-arm64 binaries ship without an embedded tarball. */
/** Set of targets we support. Aliased for backwards-compat with the
 *  previous local `SUPPORTED_TARGETS` export name. */
const SUPPORTED_TARGETS = VENDOR_TARGETS;
export { VENDOR_TARGETS as SUPPORTED_TARGETS } from "./vendor-paths";
export type { VendorTarget as Target } from "./vendor-paths";

/** Map a target to the Bun install --os/--cpu flag values used to select
 *  the right `optionalDependencies` for `@anush008/tokenizers`. */
function osCpuFor(target: Target): { os: string; cpu: string } {
  const [name, arch] = target.split("-") as [string, string];
  const os =
    name === "darwin" ? "darwin" : name === "windows" ? "win32" : "linux";
  return { os, cpu: arch === "arm64" ? "arm64" : "x64" };
}

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    all: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

function bail(msg: string): never {
  console.error(`✗ vendor-embeddings: ${msg}`);
  process.exit(1);
}

function currentTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
      ? "windows"
      : "linux";
  return `${os}-${arch}`;
}

const requestedTargets: Target[] = (() => {
  if (flags.all) return [...SUPPORTED_TARGETS];
  const t = flags.target ?? currentTarget();
  if (t === "linux-arm64") {
    bail(
      `target "linux-arm64" is unsupported — @anush008/tokenizers does not ` +
        `publish a native package for it. linux-arm64 binaries ship without ` +
        `embedded fastembed and rely on remote-provider fallback at runtime.`,
    );
  }
  if (!SUPPORTED_TARGETS.includes(t as Target)) {
    bail(
      `invalid target "${t}". Valid: ${SUPPORTED_TARGETS.join(", ")} (or pass --all).`,
    );
  }
  return [t as Target];
})();

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

const corePkgPath = join(repoRoot, "packages/core/package.json");
const corePkg = (await Bun.file(corePkgPath).json()) as {
  optionalDependencies?: Record<string, string>;
};
const fastembedVersion = corePkg.optionalDependencies?.fastembed;
if (!fastembedVersion) {
  bail(
    `couldn't read optionalDependencies.fastembed from ${corePkgPath}. ` +
      `Has the version pin moved?`,
  );
}

console.log(
  `→ vendor-embeddings: targets=${requestedTargets.join(",")} ` +
    `fastembed=${fastembedVersion}`,
);

// Pre-download the bge-small model once. The files are platform-independent
// (.onnx + .json), so the same shared cache seeds every per-target binary
// when build.ts generates the wrapper.
await ensureSharedModelCache();

for (const target of requestedTargets) {
  await prepareStaging(target);
}

// ---------------------------------------------------------------------------
// Shared model cache (bge-small-en-v1.5)
// ---------------------------------------------------------------------------

/**
 * Ensure `<repo>/.vendor-build/.model-cache/<MODEL_DIR_NAME>/` is populated
 * with all files fastembed needs to load the model in CUSTOM mode (no HF
 * Hub fetch at runtime). Returns the absolute path to the parent
 * `model-cache/` dir, which is what the per-target tar step copies into
 * each staging tree.
 *
 * We download from `Xenova/bge-small-en-v1.5` (the HuggingFace mirror that
 * publishes ONNX exports for transformers.js consumers) rather than the
 * `Qdrant/fast-bge-small-en-v1.5` repo fastembed uses by default. Two
 * reasons: Qdrant's repo only ships the FP32 `model_optimized.onnx`
 * (~127 MB), while Xenova's repo additionally publishes a quantized INT8
 * variant (~17 MB); and the Xenova layout is identical to fastembed's
 * CUSTOM-mode expectations (tokenizer.json + config.json + ... at the
 * dir root, model file by name), so no rewriting is needed.
 *
 * No fastembed install required for this — direct fetch() against the
 * HF Hub CDN keeps the build script self-contained.
 */
async function ensureSharedModelCache(): Promise<string> {
  const sharedCache = join(repoRoot, ".vendor-build", ".model-cache");
  const modelDir = join(sharedCache, MODEL_DIR_NAME);

  // Files fastembed reads in CUSTOM mode. All required — a missing file
  // fails init at runtime with a clear "X file not found" error, so it's
  // safer to verify the full set here and bail at build time than to
  // ship a half-populated cache. Source of truth: vendor-paths.ts.
  const allPresent = MODEL_FILES.every((f) => existsSync(join(modelDir, f)));
  if (allPresent) {
    console.log(`✓ shared model cache hit at ${relative(repoRoot, sharedCache)}/`);
    return sharedCache;
  }

  console.log(`→ downloading bge-small-en-v1.5 (Xenova INT8, ~17 MB)`);
  mkdirSync(modelDir, { recursive: true });

  const baseUrl =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main";
  // First entry of each pair is the source path on the HF repo (the model
  // file lives under onnx/, the rest at the repo root); second is the
  // destination filename inside our cache dir (flat — no `onnx/` subdir,
  // matching fastembed's CUSTOM-mode expectations).
  const downloads: Array<[srcPath: string, destName: string]> = [
    ["config.json", "config.json"],
    ["tokenizer.json", "tokenizer.json"],
    ["tokenizer_config.json", "tokenizer_config.json"],
    ["special_tokens_map.json", "special_tokens_map.json"],
    [`onnx/${MODEL_FILE_NAME}`, MODEL_FILE_NAME],
  ];

  for (const [srcPath, destName] of downloads) {
    const url = `${baseUrl}/${srcPath}`;
    const dest = join(modelDir, destName);
    const r = await fetch(url);
    if (!r.ok) {
      bail(`download failed: ${url} → HTTP ${r.status} ${r.statusText}`);
    }
    writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
  }

  const sizeMb = dirSizeBytes(modelDir) / 1024 / 1024;
  console.log(
    `✓ model cached at ${relative(repoRoot, sharedCache)}/ (${sizeMb.toFixed(1)} MB)`,
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

// ---------------------------------------------------------------------------
// Per-target staging
// ---------------------------------------------------------------------------

/**
 * Populate `<repo>/.vendor-build/<target>/node_modules/` with a target-
 * platform install of fastembed + transitive deps. Idempotent: if the
 * staging tree is already valid (all sanity checks pass) we leave it
 * alone so repeat builds during local iteration don't re-run `bun
 * install` for every target.
 */
async function prepareStaging(target: Target): Promise<void> {
  const { os, cpu } = osCpuFor(target);

  // Staging dir per target so sequential runs don't step on each other and
  // so an aborted run leaves the previous target's tree intact.
  const stagingDir = join(repoRoot, ".vendor-build", target);

  // Cheap idempotency probe: if the staging tree already exists with the
  // landmarks the sanity-check section verifies, skip the install. Saves
  // 1-2s per target on warm rebuilds. Build-time correctness is still
  // guaranteed by the sanity-check pass below.
  const cacheLandmarks = [
    join(stagingDir, "node_modules", "fastembed", "package.json"),
    join(stagingDir, sideLoadLibRelPath(target)),
  ];
  if (cacheLandmarks.every((p) => existsSync(p))) {
    console.log(
      `✓ [${target}] staging cache hit at ${relative(repoRoot, stagingDir)}/`,
    );
    return;
  }

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  writeFileSync(
    join(stagingDir, "package.json"),
    JSON.stringify(
      {
        name: "lore-vendor-staging",
        version: "0.0.0",
        private: true,
        dependencies: { fastembed: fastembedVersion },
      },
      null,
      2,
    ),
  );

  console.log(`\n→ [${target}] installing into ${relative(repoRoot, stagingDir)}/`);

  // --os and --cpu filter optionalDependencies, so Bun resolves
  // @anush008/tokenizers to the right native subpackage even when the
  // current host is a different platform. Lifecycle scripts run by default
  // (onnxruntime-node ships its native binaries inside the npm package, so
  // its postinstall is a no-op for our purposes — but we don't disable
  // scripts in case future versions change this).
  // ONNXRUNTIME_NODE_INSTALL_CUDA=skip dodges the CUDA-13 postinstall
  // failure (microsoft/onnxruntime#26586) — CPU-only is fine for bge-small.
  const installResult = spawnSync(
    "bun",
    ["install", "--no-save", `--os=${os}`, `--cpu=${cpu}`],
    {
      cwd: stagingDir,
      stdio: "inherit",
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" },
    },
  );

  if (installResult.status !== 0) {
    bail(`[${target}] bun install failed (exit ${installResult.status})`);
  }

  // Sanity check the runtime-required layout.
  const expected = [
    "node_modules/fastembed/package.json",
    "node_modules/onnxruntime-node/package.json",
  ];
  for (const rel of expected) {
    if (!existsSync(join(stagingDir, rel))) {
      bail(
        `[${target}] expected ${rel} after install but it's missing. ` +
          `Did fastembed change its dep tree?`,
      );
    }
  }

  // The @anush008 native subpackage is the per-target piece. Without it the
  // tokenizer fails at runtime — fail loudly here so we catch the issue at
  // build time, not first-user runtime.
  const anushDir = join(stagingDir, "node_modules", "@anush008");
  if (!existsSync(anushDir)) {
    bail(`[${target}] @anush008 dir missing — tokenizer install failed silently?`);
  }
  const native = readdirSync(anushDir).filter((e) =>
    e.startsWith("tokenizers-"),
  );
  if (native.length === 0) {
    bail(
      `[${target}] no @anush008/tokenizers-{platform} subpackage installed. ` +
        `--os=${os} --cpu=${cpu} didn't match a published variant. ` +
        `(Supported: linux-x64-gnu, darwin-universal, win32-x64-msvc.)`,
    );
  }
  console.log(`✓ [${target}] @anush008 platform pkgs: ${native.join(", ")}`);

  // Sanity-check the side-load lib (the dynamic library
  // `onnxruntime_binding.node` dlopens at runtime, e.g.
  // libonnxruntime.so.1 / libonnxruntime.1.21.0.dylib /
  // onnxruntime.dll). Bun's `--compile` embeds .node addons but doesn't
  // follow their dlopen dependencies — build.ts's wrapper embeds and
  // pre-loads this lib separately. The hardcoded names in vendor-
  // paths.ts ride on whatever version of onnxruntime-node `bun install`
  // resolves to, so when a transitive bump changes the layout we want
  // to bail at build time with the actual on-disk filenames in the
  // error so vendor-paths.ts can be updated unambiguously.
  const sideLoadRel = sideLoadLibRelPath(target);
  const sideLoadAbs = join(stagingDir, sideLoadRel);
  if (!existsSync(sideLoadAbs)) {
    const sideLoadDir = join(stagingDir, sideLoadRel.split("/").slice(0, -1).join("/"));
    let dirContents: string;
    try {
      dirContents = readdirSync(sideLoadDir).join(", ") || "(empty)";
    } catch {
      dirContents = "(directory missing — onnxruntime-node bin/napi-v3 layout changed?)";
    }
    bail(
      `[${target}] expected onnxruntime side-load lib at ${sideLoadRel} ` +
        `but it's missing.\n  Files actually in ${sideLoadDir.replace(stagingDir, ".")}: ${dirContents}\n  ` +
        `Update sideLoadLibRelPath() in packages/gateway/script/vendor-paths.ts ` +
        `to match the on-disk filename.`,
    );
  }
  const sideLoadMb = statSync(sideLoadAbs).size / 1024 / 1024;
  console.log(
    `✓ [${target}] side-load lib: ${sideLoadRel} (${sideLoadMb.toFixed(1)} MB)`,
  );

  // The model cache is shared and platform-independent — no copy step
  // here. build.ts reads from `<repo>/.vendor-build/.model-cache/`
  // directly when generating the per-target wrapper.
}
