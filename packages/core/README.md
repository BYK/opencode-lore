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

`fastembed` is declared as an `optionalDependencies` because its native `onnxruntime-node` bindings can fail to build on some hosts (e.g. CUDA 13 on Linux/x64 — [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). Install always succeeds; if the optional install fails, recall falls back to FTS-only and the configured `voyage`/`openai` providers continue to work. To force a local-embeddings install on a CUDA-13 host, run with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` — the bundled CPU EP is sufficient for `bge-small-en-v1.5`.

## Documentation

Full architecture, benchmarks, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

MIT — see [LICENSE](./LICENSE).
