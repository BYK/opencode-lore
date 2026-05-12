<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

For long-term knowledge entries managed by [lore](https://github.com/BYK/loreai) (gotchas, patterns, decisions, architecture), see [`.lore.md`](.lore.md) in the project root.
<!-- End lore-managed section -->

# Project Overview

Lore is a **three-tier memory architecture** for AI coding agents. It intercepts LLM API calls (as a transparent proxy or native plugin), distills conversation history into compressed summaries, and extracts long-term knowledge entries that persist across sessions.

**Runtime:** Bun (development/tests) and Node.js >= 22.5 (production npm bundles).
**Language:** TypeScript (monorepo with `bun workspaces`).
**Database:** SQLite with WAL mode, FTS5 full-text search. Stored at `~/.local/share/lore/lore.db`.

## Monorepo Structure

| Package | Path | Purpose |
|---|---|---|
| `@loreai/core` | `packages/core/` | Shared memory engine — DB, distillation, knowledge (LTM), recall, gradient context management, prompts |
| `@loreai/gateway` | `packages/gateway/` | Transparent LLM proxy + CLI tool (`lore`) — intercepts API calls, manages context, serves web dashboard |
| `@loreai/opencode` | `packages/opencode/` | OpenCode plugin adapter — hooks into OpenCode's lifecycle via `@opencode-ai/plugin` |
| `@loreai/pi` | `packages/pi/` | Pi coding-agent extension adapter |

`@loreai/core` is the dependency that both `gateway` and `opencode` (and `pi`) consume. The gateway bundles core into a single CJS file via esbuild; the opencode package ships raw TS.

## CLI (`lore` / `lore-gateway`)

Binary entry: `packages/gateway/src/cli/bin.ts` -> `packages/gateway/src/cli/main.ts` (`_cli()`)

| Command | Handler | Description |
|---|---|---|
| `run` (default) | `cli/run.ts` | Start gateway + auto-detect and launch AI agent |
| `start` | `cli/start.ts` | Start gateway server (without launching an agent) |
| `data` | `cli/data.ts` | Inspect/manage stored data (`list`, `show`, `clear`, `delete`, `merge`, `recover`) |
| `recall` | `cli/recall-cmd.ts` | Search project memory from terminal |
| `upgrade` | `cli/upgrade.ts` | Self-update the binary |

Agent auto-detection (`cli/agents.ts`): scans `$PATH` for Claude Code, Codex, Pi, OpenCode and sets env vars (e.g. `ANTHROPIC_BASE_URL`) to route them through the proxy.

## Three-Tier Memory Architecture

### Tier 1: Temporal Storage (`packages/core/src/temporal.ts`)
- `store()`: converts message parts to text, stores in `temporal_messages` table with FTS5 indexing
- Messages tagged with `distilled=0/1` flag
- Chunk separator: `\x1f` (ASCII Unit Separator)

### Tier 2: Distillation (`packages/core/src/distillation.ts`)
- `run()`: main entry, called on idle or when urgent
- Flow: `resetOrphans()` -> get undistilled messages -> `detectSegments()` (split by time gaps / token limits, max 16K tokens/segment) -> `distillSegment()` (LLM observer prompt) -> store as gen-0 distillation
- When gen-0 count exceeds threshold (20): `metaDistill()` consolidates into gen-1+ meta-distillation
- Gen-0 segments are archived (searchable via recall) but excluded from in-context prefix

### Tier 3: Gradient Context Manager (`packages/core/src/gradient.ts`)
- `transform()`: called on every message transform
- 4-layer system: Layer 0 (full passthrough) -> Layer 1 (distilled prefix + compressed raw) -> Layer 2 (aggressive tool-output stripping) -> Layer 3 (emergency compression)
- Dynamically calibrates from real API token counts; cost-aware caps based on model pricing

## Knowledge (LTM) System

### Entry structure (`packages/core/src/ltm.ts`)
Categories: `decision`, `pattern`, `preference`, `architecture`, `gotcha`
Fields: `id` (UUIDv7), `project_id`, `category`, `title`, `content` (max 1200 chars), `confidence` (0.0-1.0), `cross_project`

### Creation paths
1. **LLM Curator** (`packages/core/src/curator.ts`): triggered periodically, sends conversation + existing entries to LLM, returns create/update/delete ops
2. **Pattern Extraction** (`packages/core/src/pattern-extract.ts`): regex-based (no LLM), detects decision/preference patterns after each distillation
3. **File Import** (`packages/core/src/agents-file.ts`): parses `.lore.md` with `<!-- lore:UUID -->` markers, upserts into DB
4. **Consolidation** (`curator.ts` `consolidate()`): when entry count exceeds `maxEntries` (25), LLM merges/trims entries

### Key functions in `ltm.ts`
- `create()` / `update()` / `remove()` — CRUD with dedup guard
- `forSession()` — relevance-ranked, budget-capped entries for system prompt injection
- `search()` / `searchScored()` — FTS5 BM25 search with LIKE fallback

## `.lore.md` Format

```markdown
<!-- Managed by lore (https://github.com/BYK/loreai) — manual edits are imported on next session. -->

## Long-term Knowledge

### Category

<!-- lore:019e18ec-e328-76c4-9c3c-09dbe8d51c6c -->
* **Entry Title**: Entry content text.
```

- Entries sorted alphabetically by title within each category (for deterministic, merge-friendly output)
- Export: `exportLoreFile()` in `agents-file.ts` — builds from DB, skips write if content hash unchanged
- Import: `importLoreFile()` — parses markdown, upserts entries (known UUID + changed content -> update; unknown UUID -> create)
- Change detection: `shouldImportLoreFile()` — fast mtime check, then content hash comparison

### AGENTS.md integration
`exportToFile()` writes the lore pointer section between markers. `splitFile()` preserves everything outside markers. Manual content added outside the markers (like this section) is safe.

## Key Files Quick Reference

| Area | Key files |
|---|---|
| Database & schema | `packages/core/src/db.ts` |
| Knowledge CRUD | `packages/core/src/ltm.ts` |
| Distillation | `packages/core/src/distillation.ts` |
| Context management | `packages/core/src/gradient.ts` (largest file, ~1950 lines) |
| Recall/search | `packages/core/src/recall.ts`, `packages/core/src/search.ts` |
| LLM prompts | `packages/core/src/prompt.ts` |
| File sync | `packages/core/src/agents-file.ts` |
| Curator | `packages/core/src/curator.ts` |
| Configuration | `packages/core/src/config.ts` (loads `.lore.json`) |
| Gateway server | `packages/gateway/src/server.ts` |
| Compaction intercept | `packages/gateway/src/compaction.ts` |
| LLM proxy pipeline | `packages/gateway/src/pipeline.ts` |
| CLI commands | `packages/gateway/src/cli/` |
| OpenCode hooks | `packages/opencode/src/index.ts` |

## Data Flow

```
User conversation
    |
    v
temporal.store() ---------------------> temporal_messages (SQLite + FTS5)
    |                                          |
    v                                          v
distillation.run() --> LLM (observer) --> distillations table (gen-0)
    |                                          |
    v                                          v
metaDistill() ---------> LLM (reflector) -> distillations table (gen-1+)
    |                                        gen-0 archived (not deleted)
    v
curator.run() ----------> LLM (curator) --> knowledge table (create/update/delete)
    |                                          |
    v                                          v
exportLoreFile() --------------------------> .lore.md (project root)
exportToFile() ----------------------------> AGENTS.md (pointer to .lore.md)
    |
    v
On next session: importLoreFile() <-------- .lore.md (if changed by user/git)
    |
    v
forSession() + formatKnowledge() ----------> System prompt injection
recall tool (searchRecall) ----------------> Tool response to agent
```

## Build & Test

```bash
bun install          # install all workspace dependencies
bun test             # run all tests (uses bunfig.toml preload for test DB isolation)
bun run typecheck    # typecheck all packages
bun run build        # build all packages (esbuild bundles)
```

- Tests use a temporary SQLite DB (via `packages/core/test/setup.ts` preload) — never the production DB
- Gateway build: `packages/gateway/script/build.ts` produces CJS bundle; `script/bundle.ts` creates standalone binary
- Core build: `packages/core/script/build.ts` produces Node.js-compatible CJS output
