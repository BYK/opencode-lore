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

### Vector embeddings

Recall uses [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search — no API key required.

- **Binary mode** (standalone `lore` binary): Uses WASM backend (`onnxruntime-web`). Works on all platforms without native dependencies.
- **npm mode** (`npm install @loreai/gateway`): Uses native backend (`onnxruntime-node`). May fail on some configurations (e.g. CUDA 13 on Linux/x64 — [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)).

When local embeddings aren't available, recall has graceful fallbacks:

1. **Remote auto-fallback** — set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your env. The first `embed()` call detects the missing local provider and swaps over for the rest of the process. Voyage wins ties.
2. **FTS-only** — if no remote keys are set and local embeddings fail, recall uses SQLite FTS5 full-text search. Still functional, just without vector similarity ranking.

To pin a specific provider, set `search.embeddings.provider` in `.lore.json`:

```json
{ "search": { "embeddings": { "provider": "voyage" } } }
```

(also supports `"openai"`; reads `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env).

## Documentation

Full architecture, benchmarks, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

FSL-1.1-Apache-2.0 — see [LICENSE](./LICENSE).
