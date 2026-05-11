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
  copyFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  readFileSync,
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
  MODEL_FILE_NAME,
  MODEL_FILES,
  sideLoadLibBasename,
  sideLoadLibRelPath,
  type VendorTarget,
} from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));
const distDir = join(packageDir, "dist");

const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

/** Targets we vendor fastembed for. darwin-x64 is intentionally absent —
 *  see packages/gateway/script/vendor-paths.ts for the reason. Binaries
 *  for unvendored targets ship without embedded fastembed and rely on the
 *  auto-fallback to a remote provider at runtime. */
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
    /** Skip embedding fastembed even for targets that support it.
     *  Produces a smaller binary (~120 MB lighter) but local embeddings
     *  won't work out-of-the-box; users must set a remote API key.
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
  // No-op: the npm package is built by `bun run bundle` (script/bundle.ts)
  // which produces the self-contained CJS bundle (dist/index.cjs + dist/bin.cjs).
  // This function exists only so `bun run build` (workspace-wide) doesn't fail.
  console.log("⏭ @loreai/gateway: use `bun run bundle` for npm build");
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
 * Prepare the per-target vendor staging tree (a real `node_modules/`
 * tree on disk that Bun's bundler walks at compile time) and the shared
 * model cache. Auto-runs `vendor-embeddings.ts` if either is missing.
 * Returns the absolute path to the staging dir, or `null` if vendoring
 * is disabled / unsupported for this target.
 */
function prepareVendorStaging(target: CompileTarget): string | null {
  if (flags["no-vendor"]) {
    console.log(`  Vendor: skipped (--no-vendor)`);
    return null;
  }
  if (!VENDORED_TARGETS.has(target)) {
    console.log(
      `  Vendor: skipped (${target} unsupported by @anush008/tokenizers — ` +
        `runtime falls back to remote provider)`,
    );
    return null;
  }

  const stagingDir = join(repoRoot, ".vendor-build", target);
  const sharedModelCache = join(repoRoot, ".vendor-build", ".model-cache");
  const sideLoadAbs = join(stagingDir, sideLoadLibRelPath(target as VendorTarget));
  const modelDir = join(sharedModelCache, MODEL_DIR_NAME);

  // Required artefacts are: target's fastembed + native bindings, the
  // target-specific side-load lib, and every file fastembed reads from
  // the model dir at runtime. If all are present, skip the vendor run.
  const requiredArtifacts = [
    join(stagingDir, "node_modules", "fastembed", "package.json"),
    sideLoadAbs,
    ...MODEL_FILES.map((f) => join(modelDir, f)),
  ];
  if (requiredArtifacts.every((p) => existsSync(p))) {
    console.log(`  Vendor: cache hit — ${target} staging + shared model ready`);
    return stagingDir;
  }

  // Auto-build. The vendor script is fast (~3s warm) and idempotent.
  console.log(
    `  Vendor: missing artefacts for ${target} — running vendor-embeddings.ts --target ${target}`,
  );
  const result = spawnSync(
    "bun",
    [
      "run",
      join(packageDir, "script/vendor-embeddings.ts"),
      "--target",
      target,
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
  return stagingDir;
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

  // Step 0: prepare the per-target vendor staging tree (auto-builds if
  // missing). May return null for targets that don't support vendoring
  // or when --no-vendor is set.
  const stagingDir = prepareVendorStaging(target);

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
    // Bun built-ins + native binary packages (fastembed/onnxruntime contain
    // platform-specific .node files that esbuild can't bundle)
    external: ["bun:*", "fastembed", "onnxruntime-*", "@anush008/*"],
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
  //       externals as the main bundle — fastembed is resolved by Bun),
  //   (b) pass it as a second entrypoint to `bun build --compile`.
  //
  // The worker doesn't need Sentry debug IDs or external sourcemaps —
  // it's a small leaf file that delegates to fastembed.
  const workerSrc = join(repoRoot, "packages/core/src/embedding-worker.ts");
  const workerBundlePath = join(distBinDir, "embedding-worker.js");

  await esbuild.build({
    entryPoints: [workerSrc],
    bundle: true,
    format: "esm",
    target: "esnext",
    platform: "node",
    conditions: ["bun"],
    external: ["bun:*", "fastembed", "onnxruntime-*", "@anush008/*"],
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

  // Step 2.5: For vendored targets, generate a wrapper.ts inside the
  // per-target staging dir that:
  //
  //   (a) Pre-loads the side-load `libonnxruntime.so.1` / .dylib / .dll
  //       via `bun:ffi.dlopen` BEFORE fastembed evaluates, so the
  //       bundled `onnxruntime_binding.node`'s runtime dlopen finds the
  //       cached handle in the process's address space.
  //   (b) Materialises the bge-small model files from Bun assets to a
  //       stable on-disk dir (`~/.lore/embeddings-vendored/v{ver}-{tgt}/`)
  //       — fastembed in CUSTOM mode reads them via @anush008/tokenizers
  //       Rust code, which uses raw libc fs and can't see Bun's $bunfs.
  //   (c) Sets `globalThis.__LORE_VENDOR_MODEL__` so the LocalProvider
  //       knows where the model dir is.
  //   (d) Dynamically imports bin.js so its module body runs after (a-c).
  //
  // The wrapper lives IN the staging dir (not dist-bin/) because Bun's
  // bundler resolves bare specifiers like "fastembed" relative to the
  // entry's location — putting wrapper.ts next to the staging's
  // node_modules/ is what gets the per-target native bindings into the
  // bundle. We also copy bin.js into the staging dir so the wrapper's
  // `await import("./bin.js")` resolves cleanly.
  //
  // For unvendored targets (linux-arm64, --no-vendor), we skip the
  // wrapper and feed bin.js straight to `bun --compile`. The runtime
  // then sees no registration, `import("fastembed")` resolves to the
  // bundled module (which is the host platform's, since esbuild ran on
  // this host) — so embed() throws and auto-switches to remote provider.
  let wrapperPath: string | null = null;
  let copiedBinPath: string | null = null;
  if (stagingDir) {
    // (a) Side-load lib: keep the lib at its existing relative path
    //     inside the staging tree so the wrapper imports it directly
    //     from `./node_modules/...` — no copy needed.
    const sideLoadRel = sideLoadLibRelPath(target as VendorTarget);
    const sideLoadBasename = sideLoadLibBasename(target as VendorTarget);

    // (b) Model files: imported directly from the shared, platform-
    //     independent cache via a `../` relative path. Bun's bundler
    //     happily resolves `with { type: "file" }` imports across the
    //     staging boundary, so we don't need to copy the 33 MB model
    //     into each per-target staging dir.

    // (c) bin.js, embedding-worker.js, + sourcemap. We bring the sourcemap
    //     along because Bun's `--sourcemap=linked` references it by sibling
    //     filename; if it can't find bin.js.map next to bin.js the embedded
    //     map is empty.
    copiedBinPath = join(stagingDir, "bin.js");
    copyFileSync(bundlePath, copiedBinPath);
    copyFileSync(mapPath, `${copiedBinPath}.map`);
    copyFileSync(workerBundlePath, join(stagingDir, "embedding-worker.js"));

    // (d) The wrapper itself.
    wrapperPath = join(stagingDir, "wrapper.ts");
    // Path from staging/wrapper.ts to the shared per-version model cache:
    // .vendor-build/<target>/wrapper.ts → .vendor-build/.model-cache/<dir>/<file>.
    const modelImportPrefix = `../.model-cache/${MODEL_DIR_NAME}`;
    const modelImports = MODEL_FILES.map(
      (f, i) => `import _model_${i} from ${JSON.stringify(`${modelImportPrefix}/${f}`)} with { type: "file" };`,
    ).join("\n");
    const modelEntries = MODEL_FILES.map(
      (f, i) => `  [${JSON.stringify(f)}, _model_${i}],`,
    ).join("\n");
    const wrapperSrc = [
      `// AUTO-GENERATED by packages/gateway/script/build.ts. Do not commit.`,
      `// Embeds the side-load onnxruntime lib and bge-small model files`,
      `// as Bun assets, materialises them at process start, and hands off`,
      `// to bin.js. See the (a-d) notes in build.ts for the rationale.`,
      ``,
      `import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";`,
      `import { homedir } from "node:os";`,
      `import { dirname, join } from "node:path";`,
      `import { dlopen, FFIType } from "bun:ffi";`,
      ``,
      `// Race-safe materialisation: write to a per-pid tmp then rename.`,
      `// renameSync is atomic on POSIX (overwrites if dest exists, but we`,
      `// guard with existsSync first), and on Windows it errors EEXIST —`,
      `// we drop our tmp in that case since the other process won.`,
      `function materialize(src: string, dest: string): void {`,
      `  if (existsSync(dest)) return;`,
      `  const tmp = \`\${dest}.tmp.\${process.pid}\`;`,
      `  writeFileSync(tmp, readFileSync(src));`,
      `  try {`,
      `    renameSync(tmp, dest);`,
      `  } catch {`,
      `    // Another process beat us. Drop our tmp.`,
      `    try { unlinkSync(tmp); } catch { /* ignore */ }`,
      `  }`,
      `}`,
      ``,
      `import _libOnnx from "./${sideLoadRel}" with { type: "file" };`,
      modelImports,
      ``,
      `const TARGET = ${JSON.stringify(target)};`,
      `const VERSION = ${JSON.stringify(pkg.version)};`,
      ``,
      `// (a) Materialise the side-load lib next to the binary's per-user`,
      `// data dir, then dlopen it to seat it in the process's address`,
      `// space. Once cached, onnxruntime_binding.node's runtime`,
      `// dlopen("${sideLoadBasename}") finds the same handle.`,
      `const vendorRoot = join(homedir(), ".lore", "embeddings-vendored", \`v\${VERSION}-\${TARGET}\`);`,
      `const libDir = join(vendorRoot, "lib");`,
      `mkdirSync(libDir, { recursive: true });`,
      `const libPath = join(libDir, ${JSON.stringify(sideLoadBasename)});`,
      `materialize(_libOnnx, libPath);`,
      `// OrtGetApiBase is exported by libonnxruntime across all`,
      `// platforms we ship; we don't call it — the symbol entry is just`,
      `// here because bun:ffi rejects an empty symbols set. If`,
      `// onnxruntime ever drops/renames it (or the dylib install_name`,
      `// doesn't match what we wrote), let fastembed's later init`,
      `// produce the user-facing error rather than crashing here.`,
      `try {`,
      `  dlopen(libPath, { OrtGetApiBase: { args: [], returns: FFIType.ptr } });`,
      `} catch {`,
      `  // Lib loaded into address space anyway via a previous dlopen,`,
      `  // or we'll fail downstream with a clearer diagnostic.`,
      `}`,
      ``,
      `// (b) Materialise the model files. fastembed CUSTOM mode reads`,
      `// these from the dir via libc fs (through native code), so they`,
      `// must be at a real disk path — Bun's $bunfs only works for our`,
      `// own JS-side fs calls.`,
      `const modelDir = join(vendorRoot, ${JSON.stringify(MODEL_DIR_NAME)});`,
      `mkdirSync(modelDir, { recursive: true });`,
      `const modelEntries: Array<[string, string]> = [`,
      modelEntries,
      `];`,
      `for (const [name, src] of modelEntries) {`,
      `  materialize(src, join(modelDir, name));`,
      `}`,
      ``,
      `// (c) Register for the LocalProvider.`,
      `(globalThis as Record<string, unknown>).__LORE_VENDOR_MODEL__ = {`,
      `  modelAbsoluteDirPath: modelDir,`,
      `  modelName: ${JSON.stringify(MODEL_FILE_NAME)},`,
      `  target: TARGET,`,
      `  version: VERSION,`,
      `};`,
      ``,
      `// (d) Hand off. Dynamic import so bin.js's module body evaluates`,
      `// after the registration above (static imports get hoisted).`,
      `await import("./bin.js");`,
      ``,
    ].join("\n");
    writeFileSync(wrapperPath, wrapperSrc);
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

  // The compile entry is the wrapper when vendoring (which lives inside
  // the staging dir, so Bun resolves "fastembed" + transitive deps from
  // the per-target node_modules), otherwise the esbuild bundle directly.
  //
  // Vendored targets: no --external flags — we WANT Bun to bundle
  // fastembed + onnxruntime-node + @anush008/tokenizers (including their
  // .node addons) into the binary.
  //
  // Unvendored targets (e.g. linux-arm64): the esbuild bundle (bin.js)
  // contains bare `import("fastembed")` (marked external by esbuild).
  // Without a staging dir's node_modules nearby, Bun can't resolve it.
  // We pass --external so Bun leaves the import as-is; at runtime the
  // dynamic import fails, the try/catch in embedding.ts catches it, and
  // the auto-fallback to a remote provider kicks in.
  const compileEntry = wrapperPath ?? bundlePath;
  // The worker entrypoint must live next to the main entry so Bun bundles
  // it into the binary's $bunfs at the right relative path (the main
  // bundle resolves `./embedding-worker.js` via import.meta.url).
  // For vendored targets it was already copied into the staging dir;
  // for unvendored targets it sits in dist-bin/ alongside bin.js.
  const workerCompileEntry = stagingDir
    ? join(stagingDir, "embedding-worker.js")
    : workerBundlePath;
  const compileArgs = [
    "bun", "build", "--compile",
    "--target", `bun-${target}`,
    // "linked" embeds a sourcemap in the binary. At runtime, Bun's engine
    // auto-resolves Error.stack positions through this embedded map back to
    // the esbuild output's coordinate space.
    "--sourcemap=linked",
    "--outfile", binaryPath,
    // For unvendored targets, keep native embedding packages external so
    // the compile step doesn't fail trying to resolve them from dist-bin/.
    ...(!stagingDir
      ? ["--external", "fastembed", "--external", "onnxruntime-*", "--external", "@anush008/*"]
      : []),
    compileEntry,
    workerCompileEntry,
  ];
  const compileCmd = compileArgs.join(" ");

  try {
    execSync(compileCmd, { stdio: "inherit", cwd: packageDir });
  } catch {
    // Restore the esbuild map even on failure
    renameSync(esbuildMapBackup, mapPath);
    // Wrapper + copied bin.js stay in the staging dir — they're cheap
    // to recreate on the next attempt and helpful for debugging the
    // failure. The staging dir itself is gitignored.
    console.error("Bun compile failed");
    process.exit(1);
  }

  // Restore the esbuild sourcemap (Bun.build wrote its own map)
  renameSync(esbuildMapBackup, mapPath);

  // Bun --compile of wrapper.ts also produces wrapper.js.map (its own
  // external map; same data as the embedded map, named after the entry).
  // We don't want to upload it to Sentry — it has no debug ID matching our
  // app code, just noise in the project's release. Delete it.
  if (wrapperPath) {
    try {
      unlinkSync(`${wrapperPath.replace(/\.ts$/, ".js")}.map`);
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

  // Clean up intermediate files (only the binary is the artifact). The
  // staging dir itself stays in `.vendor-build/<target>/` because
  // re-running compile will reuse the per-target node_modules and the
  // model cache; deleting it would force a re-install on the next run.
  // We do delete the per-build copies of bin.js, embedding-worker.js,
  // and wrapper.ts inside the staging dir though — they're regenerated
  // every run.
  try {
    unlinkSync(bundlePath);
    unlinkSync(workerBundlePath);
    if (uploaded) {
      unlinkSync(mapPath);
      console.log("✓ Sourcemap deleted (uploaded to Sentry)");
    }
    if (wrapperPath) unlinkSync(wrapperPath);
    if (copiedBinPath) {
      unlinkSync(copiedBinPath);
      try { unlinkSync(`${copiedBinPath}.map`); } catch { /* ignore */ }
      try { unlinkSync(join(dirname(copiedBinPath), "embedding-worker.js")); } catch { /* ignore */ }
    }
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
