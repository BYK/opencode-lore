# @loreai/opencode

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

Three-tier memory architecture for [OpenCode](https://opencode.ai) — distillation, not summarization.

An implementation of [Sanity's Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) memory architecture and [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) system as an OpenCode plugin. Preserves operational intelligence (file paths, error messages, exact decisions) rather than narrative summaries that lose the details agents need to keep working.

## Install

Add to your project's `opencode.json`:

```json
{
  "plugin": [
    "@loreai/opencode"
  ]
}
```

Restart OpenCode and the plugin will be installed automatically.

> This package is also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) (legacy alias). Both names ship identical code at every release — either works.

## Local embeddings (optional)

Recall uses [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search by default — no API key required. The model is downloaded on first use and cached locally.

When installed via npm, local embeddings use the native `onnxruntime-node` backend, which may fail on some configurations (e.g. CUDA 13 on Linux/x64 — [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). When local embeddings aren't available, recall has graceful fallbacks:

1. **Set `VOYAGE_API_KEY` or `OPENAI_API_KEY`** — recall transparently switches to that provider on the first call. Zero config.
2. **Configure `search.embeddings.provider`** to `"voyage"` / `"openai"` in `.lore.json` to skip the local probe entirely.

If none of the above are set and local embeddings aren't available, recall falls back to FTS-only search.

## Local / self-hosted LLM providers

If you use a local LLM server (vllm, llama.cpp, ollama, etc.), set an environment variable so Lore's gateway knows where to forward requests:

```bash
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
```

The URL should be the **server root** — do not include `/v1` (the gateway appends API paths automatically). The naming convention is `LORE_UPSTREAM_<PROVIDER>` where `<PROVIDER>` is the uppercased provider name with hyphens replaced by underscores:

| Provider | Env var |
|----------|---------|
| `vllm` | `LORE_UPSTREAM_VLLM` |
| `llamacpp` | `LORE_UPSTREAM_LLAMACPP` |
| `ollama` | `LORE_UPSTREAM_OLLAMA` |
| `lmstudio` | `LORE_UPSTREAM_LMSTUDIO` |
| `tgi` | `LORE_UPSTREAM_TGI` |
| `litellm` | `LORE_UPSTREAM_LITELLM` |

Cloud providers (Anthropic, OpenAI, etc.) are routed automatically by model name and don't need this.

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/lore/lore.db`:

- **`@loreai/opencode`** (you are here) — OpenCode plugin
- [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) — [Pi coding-agent](https://github.com/badlogic/pi-mono) extension
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

FSL-1.1-Apache-2.0 — see [LICENSE](./LICENSE).
