# Lore

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

**Stop re-explaining your project to your AI.** Your AI forgets decisions, loses file paths, and undoes its own work. Lore fixes this automatically — no context files to maintain, no workflow changes.

Lore is a transparent LLM proxy that adds three-tier memory to any AI coding agent. Context management and long-term memory aren't separate problems — they're one continuous pipeline. Distillation feeds the gradient context manager, which feeds the knowledge curator, which feeds `.lore.md`, and with Lore Cloud *(coming soon)*, your team.

Built on [Sanity's Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) memory architecture and [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) research. The core idea: coding agents need **distillation, not summarization** — preserving file paths, error messages, and exact decisions rather than narrative summaries that lose the details agents need to keep working.

Published as [`@loreai/gateway`](https://www.npmjs.com/package/@loreai/gateway) (standalone proxy), [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) (OpenCode plugin), [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) (Pi extension), and [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) (shared engine).

## Why

Coding agents forget. Once a conversation exceeds the context window, earlier decisions, bug fixes, and architectural choices vanish. The default approach — summarize-and-compact — loses exactly the operational details agents need. After a few compaction passes, the agent knows you "discussed authentication" but can't actually continue the work.

The manual alternative is writing context files by hand — key technical learnings, decision rationales, session handoff notes. It works ([O'Reilly Radar](https://www.oreilly.com/radar/why-doesnt-anyone-teach-developers-about-context-management/) has a thorough guide), but it's a second full-time job. One project tracked 49 technical learnings manually, each with "What, Why, When, Where" — and every one had to be maintained or the AI would refactor deliberate decisions away.

Other tools try to solve this in halves. Memory-only tools store past conversations but don't manage the context window — your AI still gets compacted mid-session. Context-only tools compress history but nothing is learned from the compression — start a new session and you're back to zero.

Lore treats context management and memory as the same problem. Distillation, knowledge curation, cross-session recall, and `.lore.md` export — all in one pipeline. You keep coding. Lore keeps the context.

## What to expect

Once Lore is active, you should notice:

- **No more compactions** — Lore replaces compaction with incremental distillation. Your context never gets wiped and rebuilt from a lossy summary.
- **Infinite sessions at lower cost** — the gradient context manager keeps sessions running indefinitely without degradation. Background work runs at up to 50% off via batch APIs on supported providers, using cheaper models (A/B tested for quality parity). Predictive cache warming avoids expensive cache rebuilds.
- **Decisions stick** — the curator preserves the "why" behind every choice. A future session won't "helpfully" refactor your workaround back to the broken approach.
- **Your AI learns from experience** — patterns, gotchas, and architectural decisions are automatically curated across sessions and exported to `.lore.md`. Project-specific knowledge and global preferences follow you everywhere.
- **Free on-device vector search** — Nomic Embed v1.5 runs locally with zero API cost. Hybrid architecture fuses vector similarity with BM25 keyword search and LLM-powered query expansion for best-of-both-worlds recall.
- **Works with any provider** — `lore run` auto-detects Claude Code, OpenCode, Pi, and Codex. Cursor, Copilot, Windsurf, and any other Anthropic/OpenAI-compatible tool work by pointing their base URL at the gateway. Switch providers freely; your memory stays.*
- **Import your history** — Lore imports conversations from Claude Code, Codex, Aider, Cline, Continue, OpenCode, and Pi, extracting knowledge from your existing sessions so your AI starts with context from day one.
- **Team knowledge with Lore Cloud** — shared memory across your team, managed centrally. *(Coming soon.)*

<sub>* Any provider accessible via an OpenAI or Anthropic-compatible API.</sub>

## Quick start

### Gateway (works with any AI client)

```bash
# Install and start
curl -fsSL https://withlore.ai/install | bash
lore run
```

`lore run` starts the gateway and auto-detects your AI agent (Claude Code, OpenCode, Pi, Codex), configuring everything automatically.

Or run directly: `npx @loreai/gateway`

### OpenCode plugin

Add `@loreai/opencode` to the `plugin` array in your project's `opencode.json`:

```json
{
  "plugin": [
    "@loreai/opencode"
  ]
}
```

Restart OpenCode and the plugin will be installed automatically. The legacy name `opencode-lore` still works if you have an existing setup.

### Pi extension

Pi discovers extensions via your `~/.pi/settings.json`:

```json
{
  "packages": [
    "npm:@loreai/pi@latest"
  ]
}
```

Then run `pi install` once. The extension auto-loads on every Pi session.

All three share the same SQLite database at `~/.local/share/lore/lore.db` — switching between tools on the same project preserves everything.

## How it works

Lore uses a three-tier memory architecture (following [Nuum's design](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem)):

1. **Temporal storage** — every message is stored in a local SQLite FTS5 database, searchable on demand via the `recall` tool.

2. **Distillation** — messages are incrementally distilled into an observation log (dated, timestamped, priority-tagged entries), following [Mastra's observer/reflector pattern](https://mastra.ai/research/observational-memory). When segments accumulate, older distillations are consolidated into structured context documents optimized for diverse downstream queries (current state, key decisions, technical changes, timeline) — a [context-distillation objective](https://arxiv.org/abs/2501.17390) that generalizes better than flat summarization. Consolidated entries are archived rather than deleted, preserving a searchable detail layer for the `recall` tool.

3. **Long-term knowledge** — a curated knowledge base of facts, patterns, decisions, and gotchas that matter across sessions and projects, maintained by a background curator agent. Entries are confidence-ranked: unconditional directives (1.0) always surface, mild preferences (0.6) only when budget allows. Project-specific knowledge stays scoped; global preferences (coding style, review habits, tooling choices) follow you across all projects.

A **gradient context manager** decides how much of each tier to include in each turn, using a 4-layer safety system that calibrates overhead dynamically from real API token counts. When tool outputs are stripped for compression, [loss-annotated metadata](https://arxiv.org/abs/2602.16284) preserves key signals (tool name, size, error presence, file paths) so the model can make informed decisions about whether to recall the full content.

### Cost efficiency

Lore is designed to cost less than the default approach, not more:

- **Up to 50% off background work** — distillation, curation, and query expansion run via batch APIs (Anthropic Messages Batches, OpenAI Batch) at half price when available
- **Cheaper worker models** — background work automatically uses cheaper models (e.g., Sonnet instead of Opus), A/B tested for quality parity
- **Predictive cache warming** — survival analysis predicts when you'll return and sends $0.01 keepalive requests to prevent $0.70+ cache rebuilds
- **3-block system prompt caching** — stable preferences cached for 1 hour at 10x cheaper reads; dynamic context rides the 5-minute conversation cache
- **No compaction cache busts** — compaction destroys the entire prompt cache on every trigger. Lore's gradient compression eliminates compaction entirely
- **Content deduplication** — duplicate file reads and tool outputs are detected and deduplicated automatically, saving thousands of tokens per session

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

The eval is self-contained and reproducible: session transcripts are stored as JSON files with no database dependency.

## The `recall` tool

The assistant gets a `recall` tool that searches across stored messages, distillations, and knowledge using hybrid vector + FTS5 BM25 search with LLM-powered query expansion. It's used automatically when the distilled context doesn't have enough detail:

- "What did we decide about auth last week?"
- "What was the error from the migration?"
- "What's my database schema convention?"

Search results are ranked using Reciprocal Rank Fusion across multiple sources: knowledge entries, distillation observations, temporal messages, recency-biased temporal, cross-project knowledge, and lat.md sections.

## Configuration

Create a `.lore.json` file in your project root to customize behavior. All fields are optional — defaults are shown below:

```jsonc
{
  // Disable long-term knowledge entirely. Temporal storage, distillation,
  // gradient context management, and the recall tool (for conversation search)
  // remain active. Only the curator, knowledge injection, and .lore.md sync
  // are turned off.
  "knowledge": { "enabled": true },

  // Tune the curator that extracts knowledge from conversations.
  "curator": {
    "enabled": true,        // set false to stop extracting knowledge entries
    "onIdle": true,         // run curation when a session goes idle
    "afterTurns": 3,        // run curation after N user turns
    "maxEntries": 25        // consolidate when entries exceed this count
  },

  // Knowledge file export/import. Defaults to AGENTS.md (the universal format
  // read by 16+ AI tools). Set path to ".lore.md" for a dedicated Lore file.
  "agentsFile": {
    "enabled": true,        // set false to disable knowledge file sync
    "path": "AGENTS.md"     // or ".lore.md", "CLAUDE.md", ".cursor/rules/lore.md"
  },

  // Context budget fractions (of usable context window).
  "budget": {
    "distilled": 0.25,      // distilled history prefix
    "raw": 0.4,             // recent raw messages
    "output": 0.25,         // reserved for model output
    "ltm": 0.05             // long-term knowledge in system prompt (2-30%)
  },

  // Distillation thresholds.
  "distillation": {
    "minMessages": 5,          // min undistilled messages before distilling
    "minSegmentTokens": 64,    // min tokens per segment (below = skip/absorb)
    "maxSegmentTokens": 16384  // max tokens per distillation segment
  },

  // Temporal message pruning.
  "pruning": {
    "retention": 120,       // days to keep distilled messages
    "maxStorage": 1024      // max storage in MB before emergency pruning
  },

  // Include cross-project knowledge entries. Default: false.
  "crossProject": false
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
- **Knowledge file sync** — no import/export of AGENTS.md / .lore.md

This keeps active:
- **Temporal storage** — all messages are still stored and searchable
- **Distillation** — conversations are still distilled for context management
- **Gradient context manager** — context window is still managed automatically
- **The `recall` tool** — the agent can still search conversation history and distillations (knowledge search is skipped)

## What gets stored

All data lives locally in `~/.local/share/lore/lore.db`:

- **Session observations** — timestamped event log of each conversation: what was asked, what was done, decisions made, errors found
- **Long-term knowledge** — patterns, gotchas, and architectural decisions curated across sessions and projects. Entries can reference each other with `[[entry-id]]` wiki links, forming a navigable knowledge graph. Dead references are automatically cleaned up when entries are deleted or consolidated.
- **Raw messages** — full message history in FTS5-indexed SQLite for the `recall` tool
- **Embeddings** — on-device vector embeddings (Nomic Embed v1.5) for semantic search, stored alongside the entries they represent

## CLI tools

Lore includes a CLI for inspecting and managing stored data. These commands work **without the gateway running** — they access the SQLite database directly.

### `lore data` — Data management

```bash
# List all tracked projects
lore data list projects

# List knowledge, sessions, or distillations for the current project
lore data list knowledge
lore data list sessions
lore data list distillations --project /path/to/project

# Show full detail for an entry (supports partial ID prefix)
lore data show knowledge abc12345
lore data show session abc12345-6789
lore data show distillation abc12345

# Clear all data for a project (regenerates .lore.md)
lore data clear --project .

# Clear specific data types
lore data clear --project . --knowledge
lore data clear --project . --temporal
lore data clear --project . --distillations

# Nuclear option: wipe the entire database
lore data clear --all

# Delete a single entry
lore data delete knowledge abc12345
lore data delete session abc12345-6789
```

All destructive commands prompt for confirmation. Use `--yes` to skip (for scripts). Use `--json` on any list/show command for machine-readable output.

> **Starting fresh in a project?** Run `lore data clear --project .` to wipe all stored memories for the current directory. This regenerates `.lore.md` — commit the change to prevent old knowledge from being re-imported from git history.

### `lore recall` — Search from the terminal

```bash
# Search project memory
lore recall "error handling patterns"

# Search with options
lore recall "auth decision" --scope knowledge --limit 5
lore recall "migration error" --project /path/to/project --json
```

### `lore import` — Import conversation history

```bash
# Auto-detect and import conversations from all supported agents
lore import

# Supported: Claude Code, Codex, Aider, Cline, Continue, OpenCode, Pi
```

Extracts knowledge from your existing sessions so Lore starts with context from day one. Idempotent — safe to run multiple times.

### Web dashboard

When the gateway is running, visit **http://localhost:3207/ui** for a web-based dashboard that lets you:

- Browse all projects, their knowledge entries, sessions, and distillations
- View full detail for any entry
- Search across all data sources (uses the same recall engine)
- Delete entries or clear project data

The dashboard is server-rendered HTML with no external dependencies — it works in any browser, including terminal browsers.

## lat.md compatibility

If your project uses [lat.md](https://github.com/1st1/lat.md) to maintain a knowledge graph, Lore automatically indexes the `lat.md/` directory and includes its sections in recall results. No configuration needed — if the directory exists, Lore parses the markdown files, extracts sections, and ranks them alongside its own knowledge entries using BM25 + RRF fusion.

This means the `recall` tool searches both:
- Lore's LLM-curated memory (distillations, knowledge entries, raw messages)
- lat.md's human-authored design documentation (architecture, specs, decisions)

lat.md sections also participate in LTM injection — the most relevant sections for the current session are included in the system prompt alongside Lore's own knowledge entries, ranked by session-context relevance.

Lore re-scans the `lat.md/` directory periodically (on session idle), so changes made by the agent or by hand are picked up automatically.

## Eval results

At 400K tokens (realistic coding session length), Lore significantly outperforms the standard tail-window approach across both context retention and preference recall:

### Context retention (400K tokens)

| What's tested | Lore | Tail-window | Compaction | Lore vs TW |
|---|---|---|---|---|
| Easy (late-session details) | **5.0**/5 | 4.7/5 | 4.7/5 | +6% |
| Medium (mid-session details) | **4.1**/5 | 1.3/5 | 3.9/5 | +215% |
| Hard (early-session details) | **4.8**/5 | 1.4/5 | 4.1/5 | +243% |
| **Average across context** | **4.6**/5 | 2.6/5 | 4.1/5 | **+77%** |

*Lore scores are averaged across multiple runs at 400K tokens. Tail-window and compaction baselines are from a prior eval run with the same scenarios. Tail-window drops early-session details entirely; Lore's distillation + recall preserves them — including decision alternatives, exact error messages, and debugging hypotheses.*

### Preference recall (400K tokens)

| What's tested | Lore | Tail-window | Delta |
|---|---|---|---|
| Explicit preferences ("always use const") | **4.96**/5 | 3.40/5 | +46% |
| Implicit behavioral patterns | **4.83**/5 | 2.97/5 | +63% |
| Preference evolution (user switches tools) | **5.00**/5 | 3.67/5 | +36% |
| **Average across preferences** | **4.92**/5 | 3.34/5 | **+47%** |

*Scored by LLM-as-judge on a 1–5 scale. Tail-window baseline: last 80K tokens of raw conversation (the default behavior without Lore). Evaluated at 400K tokens — the point where context management actually matters.*

**What this means:** after 400K tokens of conversation, the standard approach loses early-session details entirely and forgets a third of your stated preferences. Lore's distillation + recall preserves both — averaging 4.6/5 on context retention where tail-window averages 2.6/5.

The eval suite (16 scenarios, 130+ questions, 5 dimensions) is open source in `packages/core/eval/`. Run it yourself:

```bash
bun packages/core/eval/run.ts --mode live --inflate 400000
```

**Cost:** Lore's memory layer runs at minimal additional cost — background distillation and curation use batch APIs (50% off on supported providers) and cheaper models. Local on-device embeddings (Nomic Embed v1.5) mean zero API cost for vector search. Predictive cache warming reduces expensive cache rebuilds.

## How we got here

**v1 — structured distillation.** The initial version used Nuum's `{ narrative, facts }` JSON format. It worked well for single-session preference recall but *regressed* on multi-session and temporal reasoning — the structured format was too rigid and lost temporal context.

**v2 — observation logs.** Switching to Mastra's observer/reflector architecture with plain-text timestamped observation logs was the breakthrough. Dated event logs preserve temporal relationships that structured JSON destroys.

**v3 — gradient context + proper eval.** Per-session gradient state, current-turn protection, cache calibration, prefix caching, LTM relevance scoring, and a self-contained eval harness. The eval extracts full session transcripts into portable JSON, distills on the fly, and compares against tail-window and compaction baselines.

**v4 — research-informed compression.** Three changes from the KV cache compression literature ([Zweiger et al. 2025](https://arxiv.org/abs/2602.16284), [Eyuboglu et al. 2025](https://arxiv.org/abs/2501.17390)): (1) *Loss-annotated tool stripping* with metadata instead of static placeholders. (2) *Context-distillation meta-distillation* producing working context documents instead of flat event logs. (3) *Multi-resolution composable distillations* — archived gen-0 observations for recall alongside compressed gen-1 for in-context summary.

**v5 — behavioral pattern detection + 400K eval.** Vector similarity-based pattern echo detection, action tagging in distillation, cross-session pattern clustering, assertion pinning for long sessions, and a scenario inflator for realistic 400K-token evaluation. This is what closed the preference gap from +15% to +47% over tail-window.

**v6 — recall quality + distillation transparency.** Uniform citation format `(d:xxx, t:xxx)` with compression metadata, session-affinity boosting, knowledge downweighting when session content exists, scripted eval replay (zero API calls during replay), amnesia mode, multi-pass compaction baseline. Context retention eval shows +77% over tail-window at 400K tokens (4.6/5 vs 2.6/5) — up from +50% in v5.

## Development setup

To use a local clone instead of the published packages:

- **OpenCode**: `{ "plugin": ["file:///absolute/path/to/opencode-lore"] }`
- **Pi**: symlink the built package into `~/.pi/agent/extensions/`, or add a local path to `~/.pi/settings.json` `packages`

Contributors editing prompts in `packages/core/src/prompt.ts` or the
user-facing system prompt injection in `packages/opencode/src/index.ts` /
`packages/pi/src/index.ts` should follow the review bar in
[`docs/PROMPT_CHANGES.md`](docs/PROMPT_CHANGES.md).

## Standing on the shoulders of

- [How we solved the agent memory problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) — Simen Svale at Sanity on the Nuum memory architecture: three-tier storage, distillation not summarization, recursive compression. The foundation this project is built on.
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory) — the observer/reflector architecture and the switch from structured JSON to timestamped observation logs that made v2 work.
- [Mastra Memory source](https://github.com/mastra-ai/mastra/tree/main/packages/memory) — reference implementation.
- [Fast KV Compaction via Attention Matching](https://arxiv.org/abs/2602.16284) — Adam Zweiger, Xinghong Fu, Han Guo, Yoon Kim on preserving attention mass when compressing KV caches. Inspired the loss-annotated tool stripping approach.
- [Cartridges: Compact Representations of Context for LLMs](https://arxiv.org/abs/2501.17390) — Simran Arora, Sabri Eyuboglu, Michael Zhang et al. on offline compressed context representations. Key ideas adopted: context-distillation objective for meta-distillation, and composable multi-resolution distillations.
- [Why Doesn't Anyone Teach Developers About Context Management?](https://www.oreilly.com/radar/why-doesnt-anyone-teach-developers-about-context-management/) — Andrew Stellman at O'Reilly Radar on why context management is the most important undiscussed skill in AI development. The manual practices described are what Lore automates.
- [OpenCode](https://opencode.ai) — one of the AI coding agents Lore integrates with natively.

## License

FSL-1.1-Apache-2.0
