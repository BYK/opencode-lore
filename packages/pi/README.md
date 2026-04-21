# @loreai/pi

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

[Lore](https://github.com/BYK/opencode-lore)'s memory engine as a [Pi coding-agent](https://github.com/badlogic/pi-mono) extension. Three-tier storage, distillation, curation, gradient context management, and FTS5-backed recall — wired into Pi's extension hooks.

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

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/opencode-lore/lore.db`:

- **`@loreai/pi`** (you are here) — Pi coding-agent extension
- [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) — [OpenCode](https://opencode.ai) plugin
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/opencode-lore](https://github.com/BYK/opencode-lore)**

## License

MIT — see [LICENSE](./LICENSE).
