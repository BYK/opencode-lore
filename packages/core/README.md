# @loreai/core

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

Shared memory engine for [Lore](https://github.com/BYK/loreai) — three-tier storage, distillation, curation, gradient context management, and FTS5-backed recall.

This package is host-agnostic. It doesn't ship a user-facing extension on its own; it's consumed by adapter packages that wire it into a specific coding agent:

- [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) — [OpenCode](https://opencode.ai) plugin (also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) legacy alias)
- [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) — [Pi coding-agent](https://github.com/badlogic/pi-mono) extension

## Install

```bash
npm install @loreai/core
# or
bun add @loreai/core
```

You only need to install this directly if you're building a new adapter. End users install one of the host packages above.

### Optional dependency: `fastembed`

`fastembed` is declared as an `optionalDependencies` because its native `onnxruntime-node` bindings can fail to build on some hosts (e.g. CUDA 13 on Linux/x64 — [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). Install always succeeds, and `embed()` resolves a provider in this order:

1. **Vendored** (standalone `lore` binary only) — fastembed and its native bindings are bundled directly into the binary at compile time via `bun build --compile`. The bge-small INT8 model files and the side-load `libonnxruntime` shared library ride along as Bun assets and are materialized to `~/.lore/embeddings-vendored/v{version}-{target}/` on first call. Supported targets: `darwin-arm64`, `linux-arm64`, `linux-x64`, `windows-x64`. (`darwin-x64` is unsupported — Apple Silicon-only.)
2. **npm-installed** — `import("fastembed")` resolves to the user's `node_modules`, including the optional-dep install.
3. **Remote auto-fallback** — when the local probe fails AND `VOYAGE_API_KEY` or `OPENAI_API_KEY` is set, `embed()` swaps to that provider for the rest of the process. Voyage wins ties.
4. **FTS-only** — if none of the above resolve, `recall.runRecall()` and `vectorSearch()` return zero hits and callers continue with full-text search only.

To force the optional install on a CUDA-13 host, run with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` — the bundled CPU EP is sufficient for `bge-small-en-v1.5`.

## Documentation

Full architecture, benchmarks, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

FSL-1.1-Apache-2.0 — see [LICENSE](./LICENSE).
