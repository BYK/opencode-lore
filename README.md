# opencode-lore

> **Experimental** — This plugin is under active development. APIs, storage format, and behavior may change.

A memory plugin for [OpenCode](https://opencode.ai) that gives the assistant persistent long-term memory across coding sessions. Instead of losing context when the conversation grows beyond the model's window, lore distills what happened into a searchable observation log and curated knowledge base.

## Why

Coding agents forget. Once a conversation exceeds the context window, earlier decisions, bug fixes, and architectural choices vanish. The default approach — summarize-and-compact — loses exactly the operational details agents need: file paths, error messages, commit hashes, the *reason* behind a decision. After a few compaction passes, the agent knows you "discussed authentication" but can't actually continue the work.

Lore takes a different approach: **distillation, not summarization**. It extracts timestamped observations with priority tags, preserves exact numbers and code references, and maintains a curated knowledge base that persists across sessions.

## How it works

Lore uses a three-tier memory architecture:

1. **Temporal storage** — every message is stored in a local SQLite FTS5 database, searchable on demand via the `recall` tool.

2. **Distillation** — messages are incrementally distilled into an observation log (dated, timestamped, priority-tagged entries). When segments accumulate, older distillations are recursively merged to prevent unbounded growth. The observer prompt is tuned to preserve exact numbers, bug fixes, file paths, and assistant-generated content.

3. **Long-term knowledge** — a curated knowledge base of facts, patterns, decisions, and gotchas that matter across projects, maintained by a background curator agent.

A **gradient context manager** decides how much of each tier to include in each turn, using a 4-layer safety system that calibrates overhead dynamically from real API token counts. This handles the unpredictable context consumption of coding agents (large tool outputs, system prompts, injected instructions) better than a fixed-budget approach.

## Benchmarks

> Scores below are on Claude Sonnet 4 (claude-sonnet-4-6). Results may vary with other models.

### General memory recall

500-question evaluation using the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark (ICLR 2025), tested in oracle mode (full message history provided as conversation context).

| Category                  | No plugin | Lore    |
|---------------------------|-----------|---------|
| Single-session (user)     | 71.9%     | 93.8%   |
| Single-session (prefs)    | 46.7%     | 86.7%   |
| Single-session (assistant)| 91.1%     | 96.4%   |
| Multi-session             | 76.9%     | 85.1%   |
| Knowledge updates         | 84.7%     | 93.1%   |
| Temporal reasoning        | 64.6%     | 81.9%   |
| Abstention                | 53.3%     | 86.7%   |
| **Overall**               | **72.6%** | **88.0%** |

### Coding session recall

15 questions across 3 real coding sessions, each asking about a specific fact from the conversation. Compared against OpenCode's default behavior (last ~80K tokens of context).

| Metric         | Default | Lore         |
|----------------|---------|--------------|
| Score          | 10/15   | **14/15**    |
| Accuracy       | 66.7%   | **93.3%**    |

Lore's advantage is largest on early/mid-session details that fall outside the recent-context window — facts like which PR was being tested, why an endpoint was changed, how many rows were updated, or what a specific bug's root cause was. The `recall` tool covers gaps where the distilled observations lack fine-grained detail.

## How we got here

This plugin was built in a few intense sessions. Some highlights from the journey:

**v1 — structured distillation.** The initial version used a `{ narrative, facts }` JSON format. It worked well for single-session preference recall (+40pp over baseline) but *regressed* on multi-session and temporal reasoning — the structured format was too rigid and lost temporal context.

**Markdown injection.** Property-based testing with fast-check revealed that user-generated content in facts (code fences, heading markers, thematic breaks) could break the markdown structure of the injected context, confusing the model.

**The splice fix.** A critical bug: OpenCode's plugin system passes message arrays by reference, but lore was *reassigning* the array (`output.messages = newArray`) instead of *mutating* it in place. The caller never saw the transform. Fix: `output.messages.splice(0, output.messages.length, ...result)`. This single line made the gradient context manager actually work.

**v2 — observation logs.** Inspired by Mastra's observer/reflector architecture, we switched to plain-text timestamped observation logs with priority tags. This was the breakthrough — LongMemEval jumped from 73.8% to 88.0%. The key insight: dated event logs preserve temporal relationships that structured JSON destroys.

**Prompt refinements.** The final push from 80% to 93.3% on coding recall came from two observer prompt additions: "EXACT NUMBERS — NEVER APPROXIMATE" (the observer was rounding counts) and "BUG FIXES — ALWAYS RECORD" (early-session fixes were being compressed away during reflection).

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)

### Setup

1. Clone this repository

2. Add the plugin to your OpenCode plugins directory (`~/.config/opencode/plugins/lore.ts`):
   ```ts
   export { LorePlugin as default } from "opencode-lore";
   ```

3. Add the dependency to `~/.config/opencode/package.json`:
   ```json
   {
     "dependencies": {
       "opencode-lore": "file:/path/to/opencode-lore"
     }
   }
   ```

4. Install and restart OpenCode:
   ```
   cd ~/.config/opencode && bun install
   ```

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

## References

- [How we solved the agent memory problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) — Sanity's blog post on their Nuum memory system for Miriad, which articulated the "distillation, not summarization" philosophy that shaped this project
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory) — the observer/reflector architecture that inspired lore's v2 distillation approach
- [Mastra Memory source](https://github.com/mastra-ai/mastra/tree/main/packages/memory) — reference implementation
- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813) — the evaluation benchmark (ICLR 2025)
- [OpenCode](https://opencode.ai) — the coding agent this plugin extends

## License

MIT
