# Lore

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

An implementation of [Sanity's Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) memory architecture and [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) system for coding agents. Both projects pioneered the idea that coding agents need **distillation, not summarization** — preserving operational intelligence (file paths, error messages, exact decisions) rather than narrative summaries that lose the details agents need to keep working.

Lore is published as three packages, all sharing the same SQLite database at `~/.local/share/opencode-lore/lore.db`:

| Package | For | Install |
|---|---|---|
| [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) | [OpenCode](https://opencode.ai) plugin | Add to `opencode.json` `plugin` array |
| [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) | [Pi coding-agent](https://github.com/badlogic/pi-mono) extension | `pi install npm:@loreai/pi` |
| [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) | Shared memory engine | Dependency of the host packages above |

The OpenCode plugin is also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) (legacy alias). Both names contain identical code at every release — use whichever you prefer.

Because all three share the same database, switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Why

Coding agents forget. Once a conversation exceeds the context window, earlier decisions, bug fixes, and architectural choices vanish. The default approach — summarize-and-compact — loses exactly the operational details agents need. After a few compaction passes, the agent knows you "discussed authentication" but can't actually continue the work.

## How it works

Lore uses a three-tier memory architecture (following [Nuum's design](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem)):

1. **Temporal storage** — every message is stored in a local SQLite FTS5 database, searchable on demand via the `recall` tool.

2. **Distillation** — messages are incrementally distilled into an observation log (dated, timestamped, priority-tagged entries), following [Mastra's observer/reflector pattern](https://mastra.ai/research/observational-memory). When segments accumulate, older distillations are consolidated into structured context documents optimized for diverse downstream queries (current state, key decisions, technical changes, timeline) — a [context-distillation objective](https://arxiv.org/abs/2501.17390) that generalizes better than flat summarization. Consolidated entries are archived rather than deleted, preserving a searchable detail layer for the `recall` tool. The observer prompt is tuned to preserve exact numbers, bug fixes, file paths, and assistant-generated content.

3. **Long-term knowledge** — a curated knowledge base of facts, patterns, decisions, and gotchas that matter across projects, maintained by a background curator agent.

A **gradient context manager** decides how much of each tier to include in each turn, using a 4-layer safety system that calibrates overhead dynamically from real API token counts. When tool outputs are stripped for compression, [loss-annotated metadata](https://arxiv.org/abs/2602.16284) preserves key signals (tool name, size, error presence, file paths) so the model can make informed decisions about whether to recall the full content. This handles the unpredictable context consumption of coding agents (large tool outputs, system prompts, injected instructions) better than a fixed-budget approach.

## Benchmarks

> Scores below are on Claude Sonnet 4 (claude-sonnet-4-6). Results may vary with other models.

### Coding session recall

20 questions across 2 real coding sessions (113K and 353K tokens), targeting specific facts at varying depths. Default mode simulates OpenCode's actual behavior: compaction of early messages + 80K-token tail window. Lore mode uses on-the-fly distillation + the `recall` tool for searching raw message history.

**Accuracy:**

| Mode    | Score     | Accuracy   |
|---------|-----------|------------|
| Default | 10/20     | 50.0%      |
| Lore    | **17/20** | **85.0%**  |

**By question depth** (where in the session the answer lives):

| Depth        | Default  | Lore        | Gap     |
|--------------|----------|-------------|---------|
| Early detail | 1/7      | **6/7**     | +71pp   |
| Mid detail   | 3/5      | **5/5**     | +40pp   |
| Late detail  | 6/7      | 6/7         | tied    |

Early and mid details — specific numbers, file paths, design decisions, error messages — are what compaction loses and distillation preserves. Late details are in both modes' context windows, so they tie.

**Cost:**

| Metric             | Default    | Lore       | Factor       |
|--------------------|------------|------------|--------------|
| Avg input/question | 126K tok   | 50K tok    | 2.5x less    |
| Total cost         | $8.14      | $1.87      | 4.4x cheaper |
| Cost/correct       | $0.81      | **$0.11**  | 7.4x cheaper |

Lore's distilled context is smaller and more cacheable than raw tail windows, making it both more accurate and cheaper per correct answer.

**Distillation compression:**

| Session            | Messages | Tokens | Distilled to     | Compression |
|--------------------|----------|--------|------------------|-------------|
| cli-sentry-issue   | 318      | 113K   | ~6K tokens       | 19x         |
| cli-nightly        | 898      | 353K   | ~19K tokens      | 19x         |

The eval is self-contained and reproducible: session transcripts are stored as JSON files with no database dependency. See [`eval/`](eval/) for the harness and data.

## How we got here

This plugin was built in a few intense sessions. Some highlights:

**v1 — structured distillation.** The initial version used Nuum's `{ narrative, facts }` JSON format. It worked well for single-session preference recall (+40pp over baseline) but *regressed* on multi-session and temporal reasoning — the structured format was too rigid and lost temporal context.

**Markdown injection.** Property-based testing with fast-check revealed that user-generated content in facts (code fences, heading markers, thematic breaks) could break the markdown structure of the injected context, confusing the model.

**v2 — observation logs.** Switching to Mastra's observer/reflector architecture with plain-text timestamped observation logs was the breakthrough. The key insight: dated event logs preserve temporal relationships that structured JSON destroys.

**Prompt refinements.** The push from 80% to 93.3% on the initial coding recall eval came from two observer prompt additions: "EXACT NUMBERS — NEVER APPROXIMATE" (the observer was rounding counts) and "BUG FIXES — ALWAYS RECORD" (early-session fixes were being compressed away during reflection).

**v3 — gradient fixes, caching, and proper eval.** A month of fixes (per-session gradient state, current-turn protection, cache.write calibration, prefix caching, LTM relevance scoring) shipped alongside a new self-contained eval harness. The old coding eval used DB-resident sessions that degraded over time as temporal pruning deleted messages. The new eval extracts full session transcripts into portable JSON files, distills on the fly with the current production prompt, seeds the DB for recall tool access, and compares against OpenCode's actual compaction behavior. This moved the coding eval from 15 questions on degraded data to 20 questions on clean 113K-353K token sessions — and confirmed the +35pp accuracy gap and 7x cost efficiency advantage.

**v4 — research-informed compaction improvements.** Three changes informed by the KV cache compression literature ([Zweiger et al. 2025](https://arxiv.org/abs/2602.16284), [Eyuboglu et al. 2025](https://arxiv.org/abs/2501.17390)): (1) *Loss-annotated tool stripping* — when tool outputs are compressed away at higher gradient layers, the replacement now includes metadata (tool name, line count, error presence, file paths) instead of a static placeholder, helping the model decide whether to recall the full content. (2) *Context-distillation meta-distillation* — the reflector prompt was restructured to produce a working context document with sections for current state, key decisions, technical changes, and timeline, rather than a flat re-organized event log — an objective that generalizes better to diverse downstream queries. (3) *Multi-resolution composable distillations* — gen-0 observations are now archived instead of deleted during meta-distillation, preserving a searchable detail layer for the recall tool while the compressed gen-1 serves as the in-context summary.

## Installation

### OpenCode

Add `@loreai/opencode` to the `plugin` array in your project's `opencode.json`:

```json
{
  "plugin": [
    "@loreai/opencode"
  ]
}
```

Restart OpenCode and the plugin will be installed automatically. The legacy name `opencode-lore` still works if you have an existing setup.

### Pi

Pi discovers extensions via your `~/.pi/settings.json`:

```json
{
  "packages": [
    "npm:@loreai/pi@latest"
  ]
}
```

Then run `pi install` once. The extension auto-loads on every Pi session.

### Development setup

To use a local clone instead of the published packages:

- **OpenCode**: `{ "plugin": ["file:///absolute/path/to/opencode-lore"] }`
- **Pi**: symlink the built package into `~/.pi/agent/extensions/`, or add a local path to `~/.pi/settings.json` `packages`

Contributors editing prompts in `packages/core/src/prompt.ts` or the
user-facing system prompt injection in `packages/opencode/src/index.ts` /
`packages/pi/src/index.ts` should follow the review bar in
[`docs/PROMPT_CHANGES.md`](docs/PROMPT_CHANGES.md).

## Configuration

Create a `.lore.json` file in your project root to customize behavior. All fields are optional — defaults are shown below:

```jsonc
{
  // Disable long-term knowledge entirely. Temporal storage, distillation,
  // gradient context management, and the recall tool (for conversation search)
  // remain active. Only the curator, knowledge injection, and AGENTS.md sync
  // are turned off.
  "knowledge": { "enabled": true },

  // Tune the curator that extracts knowledge from conversations.
  "curator": {
    "enabled": true,        // set false to stop extracting knowledge entries
    "onIdle": true,         // run curation when a session goes idle
    "afterTurns": 10,       // run curation after N user turns
    "maxEntries": 25        // consolidate when entries exceed this count
  },

  // AGENTS.md export/import — the universal agents file format.
  "agentsFile": {
    "enabled": true,        // set false to disable AGENTS.md sync
    "path": "AGENTS.md"     // change to e.g. "CLAUDE.md" or ".cursor/rules/lore.md"
  },

  // Context budget fractions (of usable context window).
  "budget": {
    "distilled": 0.25,      // distilled history prefix
    "raw": 0.4,             // recent raw messages
    "output": 0.25,         // reserved for model output
    "ltm": 0.10             // long-term knowledge in system prompt (2-30%)
  },

  // Distillation thresholds.
  "distillation": {
    "minMessages": 8,       // min undistilled messages before distilling
    "maxSegment": 50        // max messages per distillation chunk
  },

  // Temporal message pruning.
  "pruning": {
    "retention": 120,       // days to keep distilled messages
    "maxStorage": 1024      // max storage in MB before emergency pruning
  },

  // Include cross-project knowledge entries. Default: true.
  "crossProject": true
}
```

### Disabling long-term knowledge

If you prefer to manage context manually and only want conversation search capabilities, set:

```json
{
  "knowledge": { "enabled": false }
}
```

This disables:
- **Knowledge extraction** — the curator won't extract patterns, decisions, or gotchas from conversations
- **Knowledge injection** — no knowledge entries are added to the system prompt
- **AGENTS.md sync** — no import/export of the agents file

This keeps active:
- **Temporal storage** — all messages are still stored and searchable
- **Distillation** — conversations are still distilled for context management
- **Gradient context manager** — context window is still managed automatically
- **The `recall` tool** — the agent can still search conversation history and distillations (knowledge search is skipped)

## What to expect

Once Lore is active, you should notice several changes:

- **Higher cache reuse** — Lore keeps your context stable across turns, so the provider cache hits more often. You'll see higher cache read rates and lower costs.
- **No more compactions** — Lore disables the built-in compaction system and replaces it with incremental distillation. Your context never gets wiped and rebuilt from a lossy summary.
- **Steady context usage around 70–80%** — the gradient context manager dynamically balances distilled history, raw messages, and knowledge to keep you in the sweet spot — enough room for the model to work, but no wasted context.
- **Agent doesn't degrade in long sessions** — instead of getting progressively dumber as compaction loses details, the agent stays sharp because distillation preserves the operational facts that matter.
- **Better recall across and within sessions** — the agent remembers specific details from earlier in the conversation and from previous sessions, including file paths, decisions, error messages, and why things were done a certain way.
- **Automatic `AGENTS.md` export** — Lore periodically exports curated knowledge to an `AGENTS.md` file in your repo. This is the [universal format](https://agenticaistandard.org/) read by 16+ AI coding tools (Codex, Jules, Cursor, Copilot, Windsurf, and more), so the knowledge benefits every tool — not just OpenCode.

## What gets stored

All data lives locally in `~/.local/share/opencode-lore/lore.db`:

- **Session observations** — timestamped event log of each conversation: what was asked, what was done, decisions made, errors found
- **Long-term knowledge** — patterns, gotchas, and architectural decisions curated across sessions and projects. Entries can reference each other with `[[entry-id]]` wiki links, forming a navigable knowledge graph. Dead references are automatically cleaned up when entries are deleted or consolidated.
- **Raw messages** — full message history in FTS5-indexed SQLite for the `recall` tool

## The `recall` tool

The assistant gets a `recall` tool that searches across stored messages and knowledge. It's used automatically when the distilled context doesn't have enough detail:

- "What did we decide about auth last week?"
- "What was the error from the migration?"
- "What's my database schema convention?"

## lat.md compatibility

If your project uses [lat.md](https://github.com/1st1/lat.md) to maintain a knowledge graph, Lore automatically indexes the `lat.md/` directory and includes its sections in recall results. No configuration needed — if the directory exists, Lore parses the markdown files, extracts sections, and ranks them alongside its own knowledge entries using BM25 + RRF fusion.

This means the `recall` tool searches both:
- Lore's LLM-curated memory (distillations, knowledge entries, raw messages)
- lat.md's human-authored design documentation (architecture, specs, decisions)

lat.md sections also participate in LTM injection — the most relevant sections for the current session are included in the system prompt alongside Lore's own knowledge entries, ranked by session-context relevance.

Lore re-scans the `lat.md/` directory periodically (on session idle), so changes made by the agent or by hand are picked up automatically.

## Standing on the shoulders of

- [How we solved the agent memory problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) — Simen Svale at Sanity on the Nuum memory architecture: three-tier storage, distillation not summarization, recursive compression. The foundation this plugin is built on.
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory) — the observer/reflector architecture and the switch from structured JSON to timestamped observation logs that made v2 work.
- [Mastra Memory source](https://github.com/mastra-ai/mastra/tree/main/packages/memory) — reference implementation.
- [Fast KV Compaction via Attention Matching](https://arxiv.org/abs/2602.16284) — Adam Zweiger, Xinghong Fu, Han Guo, Yoon Kim on preserving attention mass when compressing KV caches. Inspired the loss-annotated tool stripping approach: when content is removed during compression, preserving metadata about what was lost helps the model compensate — analogous to the per-token scalar bias β that preserves attention mass when token count is reduced.
- [Cartridges: Compact Representations of Context for LLMs](https://arxiv.org/abs/2501.17390) — Simran Arora, Sabri Eyuboglu, Michael Zhang, Aman Timalsina, Silas Alberti, Dylan Judd, Christopher Ré on offline compressed context representations. Two key ideas adopted: (1) the context-distillation objective for meta-distillation — optimizing compressed context for downstream query-answering rather than faithful summarization, following the Self-Study finding that memorization objectives don't generalize; (2) composable multi-resolution distillations — archiving detailed observations instead of deleting them during consolidation, preserving a searchable detail layer beneath the compressed summary.
- [OpenCode](https://opencode.ai) — the coding agent this plugin extends.

## License

MIT
