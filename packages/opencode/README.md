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

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/opencode-lore/lore.db`:

- **`@loreai/opencode`** (you are here) — OpenCode plugin
- [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) — [Pi coding-agent](https://github.com/badlogic/pi-mono) extension
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

MIT — see [LICENSE](./LICENSE).
