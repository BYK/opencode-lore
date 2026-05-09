# @loreai/pi

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

[Lore](https://github.com/BYK/loreai)'s memory engine as a [Pi coding-agent](https://github.com/badlogic/pi-mono) extension. Three-tier storage, distillation, curation, gradient context management, and FTS5-backed recall — wired into Pi's extension hooks.

## Install

Add to your `~/.pi/settings.json`:

```json
{
  "packages": [
    "npm:@loreai/pi@latest"
  ]
}
```

Then run `pi install` once. The extension auto-loads on every Pi session.

## Local embeddings (optional)

By default, recall uses `fastembed` (bge-small-en-v1.5, ~33MB) for on-device vector search — no API key required. `fastembed` ships native bindings via `onnxruntime-node`, which has known install issues on some configurations (e.g. CUDA 13 on Linux/x64 — see [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). It's declared as an `optionalDependencies` of `@loreai/core`, so install will succeed regardless: if `fastembed` doesn't build, recall transparently falls back to FTS-only search.

If you want local embeddings on a system where `fastembed`'s postinstall fails, skip the CUDA EP download — the bundled CPU EP is sufficient for `bge-small-en-v1.5`:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip pi install
```

Or configure a hosted provider in `.lore.json`:

```json
{ "search": { "embeddings": { "provider": "voyage" } } }
```

(also supports `"openai"`; reads `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env).

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/opencode-lore/lore.db`:

- **`@loreai/pi`** (you are here) — Pi coding-agent extension
- [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) — [OpenCode](https://opencode.ai) plugin (also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) legacy alias)
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

MIT — see [LICENSE](./LICENSE).
