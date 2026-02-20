# opencode-lore

A memory plugin for OpenCode that gives the assistant persistent long-term memory across coding sessions.

## How it works

Nuum uses a three-tier memory architecture:

1. **Temporal storage** — every message is stored in a local SQLite FTS5 database, searchable on demand via the `recall` tool

2. **Distillation** — when the context window fills up, recent messages are distilled into an observation log (dated, timestamped, priority-tagged entries). Older distillations are recursively merged to prevent unbounded growth.

3. **Long-term knowledge** — a curated knowledge base of facts, patterns, and decisions that matter across projects, maintained by the curator agent.

The gradient context manager decides how much of each tier to include in each turn, calibrating overhead dynamically using real token counts.

## Evaluation

### LongMemEval (General Memory Benchmark)

500-question subset of [LongMemEval](https://github.com/xiaowu0162/LongMemEval), tested in oracle mode (full message history provided). Measures whether lore's memory architecture helps or hurts compared to a baseline with no memory plugin.

| Question type             | Baseline | Lore v1 | Lore v2 |
|---------------------------|----------|---------|---------|
| single-session-user       | 70%      | 94%     | 94%     |
| single-session-preference | 47%      | 87%     | 87%     |
| single-session-assistant  | 91%      | 84%     | 96%     |
| multi-session             | 75%      | 65%     | 85%     |
| knowledge-update          | 83%      | 81%     | 92%     |
| temporal-reasoning        | 63%      | 60%     | 82%     |
| **Overall**               | **72.6%**| **73.8%**| **88.0%** |

Lore v2 improves 15.4pp over baseline. The v1→v2 jump on single-session-assistant (+12pp) and multi-session (+20pp) came from strengthening the observer prompt to capture assistant-generated content (lists, decisions, filenames) rather than just user actions.

### Coding Session Recall (Real Sessions)

15 questions across 3 real coding sessions (lore development, sentry-cli, auth-api). Each question asks about a specific fact from the session — tested against three memory conditions:

- **oracle**: full raw message history in context (upper bound)
- **default**: last ~80k tokens of messages only (standard OpenCode, no plugin)
- **lore**: lore's gradient context (distillations + LTM injection)

| Session    | Oracle | Default | Nuum  |
|------------|--------|---------|-------|
| nuum-dev   | 60%    | 60%     | 60%   |
| sentry-cli | 80%    | 80%     | 80%   |
| auth-api   | 60%    | 40%     | 80%   |
| **Overall**| **60%**| **60%** | **73%** |

Lore beats default by 13 percentage points overall. The advantage is largest on early-session details that fall outside the recent-context window — facts like which PR was being tested, why an endpoint was changed, or what the specific bug root cause was. Default answered "I don't know" on several of these; lore's observation log captured them.

Nuum's limitation: high-level observation summaries can miss fine-grained implementation details. The `recall` tool handles those cases via on-demand full-text search across the raw message archive.

## Installation

### Prerequisites

- OpenCode
- Bun

### Setup

1. Clone this repository

2. Build the plugin:
   ```
   bun run build
   ```

3. Register it in your OpenCode config (usually `~/.config/opencode/config.json`):
   ```json
   {
     "plugins": ["/path/to/opencode-lore/plugin.js"]
   }
   ```

4. Restart OpenCode.

## What gets stored

- **Session observations**: timestamped event log of each conversation — what the user asked, what was done, decisions made, errors found
- **Long-term knowledge**: patterns, gotchas, and architectural decisions curated across sessions
- **Raw messages**: full message history in FTS5-indexed SQLite for the `recall` tool

## The `recall` tool

The assistant gets a `recall` tool that searches across all three tiers. Use it to look up specific past details:

- "Recall what we decided about auth"
- "Recall the error from yesterday's session"
- "Recall my database schema"

## License

MIT
