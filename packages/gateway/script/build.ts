/**
 * Build @loreai/gateway.
 *
 * Two build modes:
 *
 *   1. `bun run script/build.ts` (default)
 *      Produces dist/index.js — publishable ESM bundle for npm.
 *      @loreai/core is external (workspace dep, installed alongside).
 *
 *   2. `bun run script/build.ts --binary`
 *      Produces a standalone Bun binary for GitHub Releases.
 *      Everything is bundled (core, npm deps). Only bun:* stays external.
 *
 *      Uses a two-step build to produce external sourcemaps for Sentry:
 *      1. Bundle TS → single minified JS + external .map (esbuild)
 *      2. Inject debug IDs + swap placeholder UUID → real content-hash UUID
 *      3. Compile JS → native binary per platform (bun build --compile)
 *         (sourcemap is backed up/restored around Bun compile)
 *      4. Upload .map to Sentry for server-side stack trace resolution
 *
 *      Targets are controlled via --target (default: current platform).
 *      Example: bun run script/build.ts --binary --target linux-x64
 *
 *      The --release flag enables gzip compression of the output.
 */
import * as esbuild from "esbuild";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { processBinary } from "binpunch";
import { PLACEHOLDER_DEBUG_ID, injectDebugId } from "./debug-id";
import {
  MODEL_DIR_NAME,
  MODEL_FILES,
} from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));
const distDir = join(packageDir, "dist");

const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

/** Targets we vendor the embedding model for. All supported targets get
 *  the vendored model — transformers.js bundles its own ONNX runtime, so
 *  there are no per-platform native binding issues. */
const VENDORED_TARGETS = new Set<string>([
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
]);

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    binary: { type: "boolean", default: false },
    target: { type: "string" },
    release: { type: "boolean", default: false },
    /** Skip embedding the model even for targets that support it.
     *  Produces a smaller binary (~140 MB lighter) but local embeddings
     *  require a network download on first use.
     *  Useful for iteration speed during local dev. */
    "no-vendor": { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

// ---------------------------------------------------------------------------
// Library build (npm publish)
// ---------------------------------------------------------------------------

async function buildLibrary() {
  // Create lightweight dev shims so workspace consumers can resolve
  // the "bun" export condition without running the full `bun run bundle`.
  // Real bundle builds (bundle.ts) wipe dist/ first, so these shims
  // never interfere with production artifacts.
  mkdirSync(distDir, { recursive: true });

  const shims: Array<[string, string]> = [
    ["index.bun.js", 'export * from "../src/index.ts";\n'],
    ["embedding-worker.js", 'export * from "../../core/src/embedding-worker.ts";\n'],
  ];

  for (const [filename, content] of shims) {
    const filePath = join(distDir, filename);
    if (existsSync(filePath)) {
      // Don't overwrite real bundle output (minified, large files).
      const existing = readFileSync(filePath, "utf8");
      if (!existing.startsWith("export *")) {
        console.log(`  ${filename}: skipped (real bundle exists)`);
        continue;
      }
    }
    writeFileSync(filePath, content);
    console.log(`  ${filename}: dev shim created`);
  }

  console.log("✓ @loreai/gateway: dev shims ready (use `bun run bundle` for npm build)");
}

// ---------------------------------------------------------------------------
// Binary build (standalone Bun executable)
// ---------------------------------------------------------------------------

/** Bun compile targets we support. */
const VALID_TARGETS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;

type CompileTarget = (typeof VALID_TARGETS)[number];

function currentTarget(): CompileTarget {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return `${os}-${arch}` as CompileTarget;
}

/**
 * Ensure the shared model cache is populated with the embedding model files.
 * Auto-runs `vendor-embeddings.ts` if missing.
 * Returns the absolute path to the model dir, or `null` if vendoring
 * is disabled / unsupported for this target.
 */
function prepareVendorModelCache(target: CompileTarget): string | null {
  if (flags["no-vendor"]) {
    console.log(`  Vendor: skipped (--no-vendor)`);
    return null;
  }
  if (!VENDORED_TARGETS.has(target)) {
    console.log(
      `  Vendor: skipped (${target} not in vendored targets — ` +
        `runtime downloads model on first use)`,
    );
    return null;
  }

  const sharedModelCache = join(repoRoot, ".vendor-build", ".model-cache");
  const modelDir = join(sharedModelCache, MODEL_DIR_NAME);

  // Required artefacts: every file transformers.js reads from the model
  // dir at runtime. If all are present, skip the vendor run.
  const requiredArtifacts = MODEL_FILES.map((f) => join(modelDir, f));
  if (requiredArtifacts.every((p) => existsSync(p))) {
    console.log(`  Vendor: cache hit — shared model ready`);
    return modelDir;
  }

  // Auto-build. The vendor script downloads the model (~137 MB) and is idempotent.
  console.log(
    `  Vendor: missing model artefacts — running vendor-embeddings.ts`,
  );
  const result = spawnSync(
    "bun",
    [
      "run",
      join(packageDir, "script/vendor-embeddings.ts"),
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.status !== 0) {
    console.error(`✗ vendor-embeddings.ts failed (exit ${result.status})`);
    process.exit(1);
  }
  for (const p of requiredArtifacts) {
    if (!existsSync(p)) {
      console.error(`✗ vendor run succeeded but artefact still missing: ${p}`);
      process.exit(1);
    }
  }
  return modelDir;
}

/**
 * esbuild plugin for binary builds that:
 *
 * 1. Redirects `onnxruntime-node` → `onnxruntime-web` (node entry). The native
 *    backend's `.node` NAPI binaries can't be loaded from Bun's `$bunfs`.
 *    onnxruntime-web's WASM+SIMD backend is API-compatible and actually ~2x
 *    faster on batch embedding workloads due to avoiding N-API overhead.
 *    transformers.js's `IS_NODE_ENV` branch uses it transparently — it populates
 *    `supportedDevices` with `cpu` (which onnxruntime-web handles via WASM).
 *
 * 2. Stubs `sharp` as empty — image processing for vision models, unused for
 *    text embeddings.
 *
 * 3. Resolves `onnxruntime-common` and `onnxruntime-web` from Bun's `.bun/`
 *    store (transitive deps not hoisted to `node_modules/`).
 */
/** Find a package directory inside Bun's `.bun/` store. Prefers stable versions. */
function findBunPackageDir(name: string): string {
  const bunDir = join(repoRoot, "node_modules/.bun");
  const prefix = `${name}@`;
  const entries = readdirSync(bunDir).filter((e) => e.startsWith(prefix));
  if (entries.length === 0) {
    throw new Error(`findBunPackageDir: cannot find ${name} in node_modules/.bun/`);
  }
  const stable = entries.filter((m) => !m.includes("-", prefix.length));
  const pick = (stable.length > 0 ? stable : entries).sort().reverse()[0];
  return join(bunDir, pick, "node_modules", name);
}

/** Find a package's main entry inside Bun's `.bun/` store. Prefers stable versions. */
function findBunPackageEntry(name: string, entryOverride?: string): string {
  const pkgDir = findBunPackageDir(name);
  if (entryOverride) return join(pkgDir, entryOverride);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return join(pkgDir, pkgJson.main || "index.js");
}

function binaryExternalsPlugin(): esbuild.Plugin {

  return {
    name: "binary-externals",
    setup(build) {
      // Stub sharp as an empty module.
      build.onResolve({ filter: /^sharp$/ }, (args) => ({
        path: args.path,
        namespace: "empty-module",
      }));
      build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));

      // Redirect onnxruntime-node → onnxruntime-web's Node.js entry.
      // The WASM runtime is API-compatible with the native one.
      const ortWebNodeEntry = findBunPackageEntry("onnxruntime-web", "dist/ort.node.min.mjs");
      build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({
        path: ortWebNodeEntry,
      }));

      // Resolve transitive deps from .bun/ so esbuild can bundle them.
      for (const pkg of ["onnxruntime-common", "onnxruntime-web"]) {
        const resolved = findBunPackageEntry(pkg);
        build.onResolve({ filter: new RegExp(`^${pkg}$`) }, () => ({
          path: resolved,
        }));
      }

      // Patch transformers.js onnx.js to read wasmPaths from globalThis
      // instead of the CDN URL. The binary wrapper sets
      // __LORE_VENDOR_WASM_PATHS__ = { mjs, wasm } with $bunfs paths
      // before the worker evaluates. transformers.js checks
      // `!ONNX_ENV.wasm.wasmPaths` and falls back to a CDN URL — we
      // replace that fallback with a globalThis read.
      build.onLoad({ filter: /transformers\.node\.mjs$/ }, (args) => {
        let src = readFileSync(args.path, "utf8");
        // The CDN default looks like:
        //   ONNX_ENV.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${env.version}/dist/`;
        // Replace it to prefer __LORE_VENDOR_WASM_PATHS__ when available.
        src = src.replace(
          /ONNX_ENV\.wasm\.wasmPaths\s*=\s*`https:\/\/cdn\.jsdelivr\.net[^`]*`;/,
          "ONNX_ENV.wasm.wasmPaths = globalThis.__LORE_VENDOR_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths;",
        );
        return { contents: src, loader: "js", resolveDir: dirname(args.path) };
      });
    },
  };
}

async function buildBinary() {
  const target = (flags.target ?? currentTarget()) as CompileTarget;

  if (!VALID_TARGETS.includes(target)) {
    console.error(`Invalid target: ${target}`);
    console.error(`Valid targets: ${VALID_TARGETS.join(", ")}`);
    process.exit(1);
  }

  const distBinDir = join(packageDir, "dist-bin");
  mkdirSync(distBinDir, { recursive: true });

  // Step 0: ensure the shared model cache is populated (auto-downloads if
  // missing). May return null when --no-vendor is set.
  const vendorModelDir = prepareVendorModelCache(target);

  // Step 1: esbuild bundle — single ESM file with everything inlined
  const bundlePath = join(distBinDir, "bin.js");
  const mapPath = join(distBinDir, "bin.js.map");

  await esbuild.build({
    entryPoints: [join(packageDir, "src/cli/bin.ts")],
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "node",
    conditions: ["bun"],
    // Bun built-ins stay external. onnxruntime-node and sharp are stubbed
    // as empty modules — transformers.js falls back to the bundled WASM
    // ONNX runtime, and sharp is only used for vision models.
    external: ["bun:*"],
    plugins: [binaryExternalsPlugin()],
    outfile: bundlePath,
    // "linked" produces an external .map file with a //# sourceMappingURL=
    // comment in the JS. This map is uploaded to Sentry (never shipped to users).
    sourcemap: "linked",
    minify: true,
    logLevel: "info",
    legalComments: "none",
    define: {
      LORE_CLI_VERSION: JSON.stringify(pkg.version),
      __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
    },
  });

  console.log(`✓ esbuild bundle: ${bundlePath}`);

  // Step 1b: esbuild the embedding worker as a separate file.
  //
  // In the compiled binary, `new Worker("./embedding-worker.js", ...)`
  // resolves against Bun's virtual $bunfs. Bun only includes files that
  // are explicit entrypoints in `bun build --compile`, so we must:
  //   (a) produce a standalone embedding-worker.js via esbuild (same
  //       externals as the main bundle),
  //   (b) pass it as a second entrypoint to `bun build --compile`.
  //
  // The worker doesn't need Sentry debug IDs or external sourcemaps —
  // it's a leaf file that delegates to @huggingface/transformers.
  const workerSrc = join(repoRoot, "packages/core/src/embedding-worker.ts");
  const workerBundlePath = join(distBinDir, "embedding-worker.js");

  await esbuild.build({
    entryPoints: [workerSrc],
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "node",
    conditions: ["bun"],
    external: ["bun:*"],
    plugins: [binaryExternalsPlugin()],
    outfile: workerBundlePath,
    minify: true,
    logLevel: "info",
    legalComments: "none",
  });

  console.log(`✓ esbuild worker: ${workerBundlePath}`);



  // Step 2: Inject debug IDs into the JS and sourcemap
  // skipSnippet: true — the IIFE snippet breaks ESM (placed before import
  // declarations). The debug ID is instead registered in instrument.ts via
  // the build-time __SENTRY_DEBUG_ID__ constant.
  let debugId: string | undefined;

  try {
    const result = await injectDebugId(bundlePath, mapPath, {
      skipSnippet: true,
    });
    debugId = result.debugId;
    console.log(`✓ Debug ID injected: ${debugId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Debug ID injection failed: ${msg}`);
  }

  // Replace the placeholder UUID with the real debug ID in the JS bundle.
  // Both are 36-char UUIDs so sourcemap character positions stay valid.
  if (debugId) {
    try {
      const content = readFileSync(bundlePath, "utf-8");
      writeFileSync(bundlePath, content.replaceAll(PLACEHOLDER_DEBUG_ID, debugId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Debug ID placeholder replacement failed: ${msg}`);
    }
  }

  // Step 2.5: For vendored targets, generate a wrapper.ts in dist-bin/
  // that:
  //
  //   (a) Materialises the nomic-embed-text-v1.5 model files from Bun
  //       assets to a stable on-disk dir (`~/.lore/embeddings-vendored/
  //       v{ver}-{tgt}/nomic-ai/nomic-embed-text-v1.5/`) —
  //       @huggingface/transformers reads them via ONNX Runtime's native
  //       fs, which can't see Bun's $bunfs.
  //   (b) Sets `globalThis.__LORE_VENDOR_MODEL__` so the LocalProvider
  //       configures transformers.js to load from the local path.
  //   (c) Dynamically imports bin.js so its module body runs after (a-b).
  //
  // The wrapper also handles worker thread routing: when spawned as a
  // worker thread, it runs embedding-worker.js directly.
  //
  // For unvendored targets or --no-vendor, we skip the wrapper and feed
  // bin.js straight to `bun --compile`. transformers.js then downloads
  // the model from HuggingFace Hub on first use.
  let wrapperPath: string | null = null;
  if (vendorModelDir) {
    wrapperPath = join(distBinDir, "wrapper.ts");
    // Model files are imported directly from the shared model cache.
    const modelImports = MODEL_FILES.map(
      (f, i) => `import _model_${i} from ${JSON.stringify(join(vendorModelDir, f))} with { type: "file" };`,
    ).join("\n");
    const modelEntries = MODEL_FILES.map(
      (f, i) => `  [${JSON.stringify(f)}, _model_${i}],`,
    ).join("\n");

    // WASM runtime files from onnxruntime-web. In the compiled binary,
    // onnxruntime-node is redirected to onnxruntime-web (WASM backend).
    // The WASM files are embedded as Bun assets — onnxruntime-web's node
    // entry loads them via readFile(), which can read from Bun's $bunfs.
    const ortWebDistDir = findBunPackageDir("onnxruntime-web") + "/dist";
    const wasmFiles = [
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
    ];
    const wasmImports = wasmFiles.map(
      (f, i) => `import _wasm_${i} from ${JSON.stringify(join(ortWebDistDir, f))} with { type: "file" };`,
    ).join("\n");

    const wrapperSrc = [
      `// AUTO-GENERATED by packages/gateway/script/build.ts. Do not commit.`,
      `// Embeds the nomic-embed-text-v1.5 model files + WASM runtime as Bun`,
      `// assets, materialises model files at process start, and hands off to bin.js.`,
      ``,
      `// --- Static imports (must be top-level in ESM) ---`,
      `import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";`,
      `import { homedir } from "node:os";`,
      `import { join } from "node:path";`,
      `import { isMainThread } from "node:worker_threads";`,
      modelImports,
      wasmImports,
      ``,
      `// --- Worker thread shortcut ---`,
      `// When spawned as a worker thread, run the embedding worker code path`,
      `// directly. This avoids needing a separate worker entrypoint — Bun's`,
      `// --compile silently drops additional entrypoints on macOS and Windows.`,
      `if (!isMainThread) {`,
      `  // Register WASM file paths for the esbuild-bundled worker. The`,
      `  // binaryExternalsPlugin patches transformers.js to read wasmPaths`,
      `  // from this globalThis key instead of the CDN fallback URL.`,
      `  // Bun hashes $bunfs filenames, so we pass exact paths as an object.`,
      `  (globalThis as Record<string, unknown>).__LORE_VENDOR_WASM_PATHS__ = { mjs: _wasm_0, wasm: _wasm_1 };`,
      `  await import("./embedding-worker.js");`,
      `} else {`,
      `  // --- Main thread: materialise vendor assets and hand off ---`,
      ``,
      `  // Race-safe materialisation: write to a per-pid tmp then rename.`,
      `  const materialize = (src: string, dest: string): void => {`,
      `    if (existsSync(dest)) return;`,
      `    const tmp = \`\${dest}.tmp.\${process.pid}\`;`,
      `    writeFileSync(tmp, readFileSync(src));`,
      `    try {`,
      `      renameSync(tmp, dest);`,
      `    } catch {`,
      `      try { unlinkSync(tmp); } catch { /* ignore */ }`,
      `    }`,
      `  };`,
      ``,
      `  const TARGET = ${JSON.stringify(target)};`,
      `  const VERSION = ${JSON.stringify(pkg.version)};`,
      ``,
      `  // (a) Materialise the model files. ONNX Runtime reads these via`,
      `  // native fs, so they must be at a real disk path — Bun's $bunfs`,
      `  // only works for our own JS-side fs calls.`,
      `  // Layout matches HF repo structure that transformers.js expects:`,
      `  //   <modelDir>/config.json`,
      `  //   <modelDir>/tokenizer.json`,
      `  //   <modelDir>/onnx/model_quantized.onnx`,
      `  const vendorRoot = join(homedir(), ".lore", "embeddings-vendored", \`v\${VERSION}-\${TARGET}\`);`,
      `  const modelDir = join(vendorRoot, ${JSON.stringify(MODEL_DIR_NAME)});`,
      `  const modelEntries: Array<[string, string]> = [`,
      modelEntries,
      `  ];`,
      `  for (const [name, src] of modelEntries) {`,
      `    const dest = join(modelDir, name);`,
      `    mkdirSync(join(modelDir, name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ""), { recursive: true });`,
      `    materialize(src, dest);`,
      `  }`,
      ``,
      `  // (b) Register for the LocalProvider.`,
      `  (globalThis as Record<string, unknown>).__LORE_VENDOR_MODEL__ = {`,
      `    localModelPath: vendorRoot,`,
      `    target: TARGET,`,
      `    version: VERSION,`,
      `  };`,
      `  // Register the wrapper's import.meta.url so embedding.ts can spawn`,
      `  // workers using the binary entrypoint itself — the isMainThread guard`,
      `  // above routes worker threads to embedding-worker.js automatically.`,
      `  (globalThis as Record<string, unknown>).__LORE_VENDOR_WORKER_URL__ = import.meta.url;`,
      ``,
      `  // (c) Hand off. Dynamic import so bin.js's module body evaluates`,
      `  // after the registration above (static imports get hoisted).`,
      `  await import("./bin.js");`,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(wrapperPath, wrapperSrc);
    // bin.js, embedding-worker.js, and wrapper.ts are all in distBinDir,
    // so the wrapper's `import("./bin.js")` and `import("./embedding-worker.js")`
    // resolve without any copies.
    console.log(`✓ vendor wrapper: ${wrapperPath}`);
  }

  // Step 3: bun build --compile — produce native binary
  // Rename the esbuild map out of the way before Bun.build — when using
  // sourcemap: "linked", Bun writes its own map to bin.js.map. The esbuild
  // map (which maps back to original TS) is what we upload to Sentry.
  // Bun's embedded map handles runtime Error.stack → esbuild-output mapping
  // automatically, so the two compose: Bun runtime → esbuild positions →
  // original TS (via Sentry's uploaded map).
  const esbuildMapBackup = `${mapPath}.esbuild`;
  renameSync(mapPath, esbuildMapBackup);

  const ext = target.startsWith("windows") ? ".exe" : "";
  const binaryName = `lore-${target}${ext}`;
  const binaryPath = join(distBinDir, binaryName);

  // The compile entry is the wrapper when vendoring (embeds model files
  // as Bun assets), otherwise the esbuild bundle directly (transformers.js
  // downloads the model on first use).
  const compileEntry = wrapperPath ?? bundlePath;
  const externals: string[] = [];

  try {
    const result = await Bun.build({
      entrypoints: [compileEntry],
      compile: {
        target: `bun-${target}` as any,
        outfile: binaryPath,
      },
      sourcemap: "linked",
      external: externals,
    });
    if (!result.success) {
      console.error("Bun compile failed:", result.logs);
      renameSync(esbuildMapBackup, mapPath);
      process.exit(1);
    }
  } catch (e) {
    // Restore the esbuild map even on failure
    renameSync(esbuildMapBackup, mapPath);
    // Wrapper + copied bin.js stay in the staging dir — they're cheap
    // to recreate on the next attempt and helpful for debugging the
    // failure. The staging dir itself is gitignored.
    console.error("Bun compile failed", e);
    process.exit(1);
  }

  // Restore the esbuild sourcemap (Bun.build wrote its own map)
  renameSync(esbuildMapBackup, mapPath);

  // Bun --compile of wrapper.ts also produces wrapper.js.map (its own
  // external map). Delete it — we don't upload it to Sentry.
  if (wrapperPath) {
    try {
      unlinkSync(wrapperPath.replace(/\.ts$/, ".js.map"));
    } catch {
      /* not all Bun versions emit this — ignore if missing */
    }
  }

  console.log(`✓ Bun compile: ${binaryPath}`);

  // Step 4: hole-punch unused ICU data entries so they compress to nearly nothing
  const hpStats = processBinary(binaryPath);
  if (hpStats && hpStats.removedEntries > 0) {
    console.log(
      `✓ hole-punched ${hpStats.removedEntries}/${hpStats.totalEntries} ICU entries`,
    );
  }

  // Step 5: gzip (release builds only)
  if (flags.release) {
    const raw = readFileSync(binaryPath);
    const compressed = gzipSync(raw, { level: 6 });
    const gzPath = `${binaryPath}.gz`;
    writeFileSync(gzPath, compressed);

    const ratio = ((compressed.length / raw.length) * 100).toFixed(1);
    console.log(
      `✓ gzip: ${gzPath} (${(compressed.length / 1024 / 1024).toFixed(1)}MB, ${ratio}% of original)`,
    );
  }

  // Step 6: Upload sourcemap to Sentry
  // The esbuild map (bin.js → original TS) is the one we upload. Bun's
  // embedded map handles the binary → esbuild-output resolution at runtime.
  let uploaded = false;

  if (process.env.SENTRY_AUTH_TOKEN) {
    console.log(`  Uploading sourcemap to Sentry (release: ${pkg.version})...`);
    try {
      execSync(
        [
          "npx", "sentry", "sourcemap", "upload", "dist-bin/",
          "--release", pkg.version,
          "--org", "byk",
          "--project", "loreai-gateway",
          "--url-prefix", "~/dist-bin/",
        ].join(" "),
        { cwd: packageDir, stdio: "inherit" },
      );
      uploaded = true;
      console.log("✓ Sourcemap uploaded to Sentry");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Sourcemap upload failed: ${msg}`);
    }
  } else {
    console.log("  No SENTRY_AUTH_TOKEN — skipping sourcemap upload");
  }

  // Clean up intermediate files (only the binary is the artifact).
  try {
    unlinkSync(bundlePath);
    unlinkSync(workerBundlePath);
    if (uploaded) {
      unlinkSync(mapPath);
      console.log("✓ Sourcemap deleted (uploaded to Sentry)");
    }
    if (wrapperPath) unlinkSync(wrapperPath);
  } catch {
    // Ignore
  }

  console.log(`\n✓ Binary build complete: ${binaryName} (v${pkg.version})`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (flags.binary) {
  await buildBinary();
} else {
  await buildLibrary();
}
