# opencode-lore

> **Experimental** — This plugin is under active development. APIs, storage format, and behavior may change.

An implementation of [Sanity's Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) memory architecture and [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) system as a plugin for [OpenCode](https://opencode.ai). Both projects pioneered the idea that coding agents need **distillation, not summarization** — preserving operational intelligence (file paths, error messages, exact decisions) rather than narrative summaries that lose the details agents need to keep working. This plugin brings those ideas to OpenCode.

## Why

Coding agents forget. Once a conversation exceeds the context window, earlier decisions, bug fixes, and architectural choices vanish. The default approach — summarize-and-compact — loses exactly the operational details agents need. After a few compaction passes, the agent knows you "discussed authentication" but can't actually continue the work.

## How it works

Lore uses a three-tier memory architecture (following [Nuum's design](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem)):

1. **Temporal storage** — every message is stored in a local SQLite FTS5 database, searchable on demand via the `recall` tool.

2. **Distillation** — messages are incrementally distilled into an observation log (dated, timestamped, priority-tagged entries), following [Mastra's observer/reflector pattern](https://mastra.ai/research/observational-memory). When segments accumulate, older distillations are recursively merged to prevent unbounded growth. The observer prompt is tuned to preserve exact numbers, bug fixes, file paths, and assistant-generated content.

3. **Long-term knowledge** — a curated knowledge base of facts, patterns, decisions, and gotchas that matter across projects, maintained by a background curator agent.

A **gradient context manager** decides how much of each tier to include in each turn, using a 4-layer safety system that calibrates overhead dynamically from real API token counts. This handles the unpredictable context consumption of coding agents (large tool outputs, system prompts, injected instructions) better than a fixed-budget approach.

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

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai)

### Setup

Add `opencode-lore` to the `plugin` array in your project's `opencode.json`:

```json
{
  "plugin": [
    "opencode-lore"
  ]
}
```

Restart OpenCode and the plugin will be installed automatically.

#### Development setup

To use a local clone instead of the published package:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-lore"
  ]
}
```

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
- **Long-term knowledge** — patterns, gotchas, and architectural decisions curated across sessions and projects
- **Raw messages** — full message history in FTS5-indexed SQLite for the `recall` tool

## The `recall` tool

The assistant gets a `recall` tool that searches across stored messages and knowledge. It's used automatically when the distilled context doesn't have enough detail:

- "What did we decide about auth last week?"
- "What was the error from the migration?"
- "What's my database schema convention?"

## Standing on the shoulders of

- [How we solved the agent memory problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) — Simen Svale at Sanity on the Nuum memory architecture: three-tier storage, distillation not summarization, recursive compression. The foundation this plugin is built on.
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory) — the observer/reflector architecture and the switch from structured JSON to timestamped observation logs that made v2 work.
- [Mastra Memory source](https://github.com/mastra-ai/mastra/tree/main/packages/memory) — reference implementation.
- [OpenCode](https://opencode.ai) — the coding agent this plugin extends.

## License

MIT
