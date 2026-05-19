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

By default, recall uses [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search — no API key required. The model is downloaded on first use and cached locally.

When installed via npm, local embeddings use the native `onnxruntime-node` backend, which may fail on some configurations (e.g. CUDA 13 on Linux/x64 — see [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). When local embeddings aren't available, recall has graceful fallbacks:

1. **Auto-fallback to a hosted provider** — set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your env. The first `embed()` call detects the missing local provider and swaps over for the rest of the process. No config changes needed.
2. **Pin a hosted provider explicitly** in `.lore.json`:

   ```json
   { "search": { "embeddings": { "provider": "voyage" } } }
   ```

   (also supports `"openai"`; reads `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env).

If none apply, recall transparently falls back to FTS-only search.

## Local / self-hosted LLM providers

If you use a local LLM server (vllm, llama.cpp, ollama, etc.), set an environment variable so Lore's gateway knows where to forward requests:

```bash
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
```

The naming convention is `LORE_UPSTREAM_<PROVIDER>` where `<PROVIDER>` is the uppercased Pi provider name with hyphens replaced by underscores. Cloud providers (Anthropic, OpenAI, etc.) are routed automatically by model name and don't need this.

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/lore/lore.db`:

- **`@loreai/pi`** (you are here) — Pi coding-agent extension
- [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) — [OpenCode](https://opencode.ai) plugin (also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) legacy alias)
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

FSL-1.1-Apache-2.0 — see [LICENSE](./LICENSE).
