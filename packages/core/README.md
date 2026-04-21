# @loreai/core

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

Shared memory engine for [Lore](https://github.com/BYK/opencode-lore) — three-tier storage, distillation, curation, gradient context management, and FTS5-backed recall.

This package is host-agnostic. It doesn't ship a user-facing extension on its own; it's consumed by adapter packages that wire it into a specific coding agent:

- [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) — [OpenCode](https://opencode.ai) plugin
- [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) — [Pi coding-agent](https://github.com/badlogic/pi-mono) extension

## Install

```bash
npm install @loreai/core
# or
bun add @loreai/core
```

You only need to install this directly if you're building a new adapter. End users install one of the host packages above.

## Documentation

Full architecture, benchmarks, and rationale: **[github.com/BYK/opencode-lore](https://github.com/BYK/opencode-lore)**

## License

MIT — see [LICENSE](./LICENSE).
