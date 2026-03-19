<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/opencode-lore) -->
## Long-term Knowledge

### Architecture

<!-- lore:019c904b-791e-772a-ab2b-93ac892a960c -->
* **buildSection() renders AGENTS.md directly without formatKnowledge**: AGENTS.md export/import: buildSection() iterates DB entries grouped by category, emitting \`\<!-- lore:UUID -->\` markers via remark. splitFile() scans ALL\_START\_MARKERS (current + historical) — self-healing: N duplicate sections collapse to 1 on next export. Import dedup handled by curator LLM at startup when file changed. Missing marker = hand-written; duplicate UUID = first wins. ltm.create() has title-based dedup guard (case-insensitive, skipped for explicit IDs from cross-machine import).

<!-- lore:019c94bd-042d-73c0-b850-192d1d62fa68 -->
* **Knowledge entry distribution across projects — worktree sessions create separate project IDs**: Knowledge entries are scoped by project\_id from ensureProject(projectPath). OpenCode worktree sessions (paths like ~/.local/share/opencode/worktree/\<hash>/\<slug>/) each get their own project\_id. A single repo can have multiple project\_ids: one for the real path, separate ones per worktree session. Project-specific entries (cross\_project=0) are invisible across different project\_ids. Cross-project entries (cross\_project=1) are shared globally.

<!-- lore:019c8f4f-67c8-7cf4-b93b-c5ec46ed94b6 -->
* **Lore DB uses incremental auto\_vacuum to prevent free-page bloat**: Lore's SQLite DB uses incremental auto\_vacuum (schema version 3 migration) to prevent free-page bloat from deletions. The migration sets PRAGMA auto\_vacuum = INCREMENTAL then VACUUM outside a transaction. temporal\_messages is the primary storage consumer (~51MB); knowledge table is tiny.

<!-- lore:019c8f8c-47c3-71a2-b5fd-248a2cfeba78 -->
* **Lore temporal pruning runs after distillation and curation on session.idle**: In src/index.ts, session.idle awaits backgroundDistill and backgroundCurate sequentially before running temporal.prune(). Ordering is critical: pruning must not delete unprocessed messages. Pruning defaults: 120-day retention, 1GB max storage (in .lore.json under pruning.retention and pruning.maxStorage). These generous defaults were chosen because the system was new — earlier proposals of 7d/200MB were based on insufficient data.

<!-- lore:019c94bd-042b-7215-b0a0-05719fcd39b2 -->
* **LTM injection pipeline: system transform → forSession → formatKnowledge → gradient deduction**: LTM injected via experimental.chat.system.transform hook. getLtmBudget() computes ceiling as (contextLimit - outputReserved - overhead) \* ltmFraction (default 10%, configurable 2-30%). forSession() loads project-specific entries unconditionally + cross-project entries scored by term overlap, greedy-packs into budget. formatKnowledge() renders as markdown. setLtmTokens() records consumption so gradient deducts it. Key: LTM goes into output.system (system prompt) — invisible to tryFit(), counts against overhead budget.

### Decision

<!-- lore:019c904b-7924-7187-8471-8ad2423b8946 -->
* **Curator prompt scoped to code-relevant knowledge only**: CURATOR\_SYSTEM in src/prompt.ts now explicitly excludes: general ecosystem knowledge available online, business strategy and marketing positioning, product pricing models, third-party tool details not needed for development, and personal contact information. This was added after the curator extracted entries about OpenWork integration strategy (including an email address), Lore Cloud pricing tiers, and AGENTS.md ecosystem facts — none of which help an agent write code. The curatorUser() function also appends guidance to prefer updating existing entries over creating new ones for the same concept, reducing duplicate creation.

### Gotcha

<!-- lore:019c91d6-04af-7334-8374-e8bbf14cb43d -->
* **Calibration used DB message count instead of transformed window count — caused layer 0 false passthrough**: Lore gradient/context bugs: (1) Used DB message count instead of transformed window count — delta ≈ 1 → layer 0 passthrough → overflow. Fix: getLastTransformedCount(). (2) actualInput omitted cache.write — cold-cache ~3 tokens → layer 0. Fix: include cache.write. (3) Trailing pure-text assistant messages cause Anthropic prefill errors. Drop loop must run at ALL layers (layer 0 shares ref with output). Never drop messages with tool parts (hasToolParts) — causes infinite loops. (4) Unregistered projects get zero context management → stuck compaction loops. Recovery: delete messages after last good assistant message.

<!-- lore:019cb615-0b10-7bbc-a7db-50111118c200 -->
* **Lore auto-recovery can infinite-loop without re-entrancy guard**: Three v0.5.2 bugs causing excessive background LLM requests: (1) Auto-recovery loop — session.error handler injected recovery prompt → could overflow again → loop. Fix: recoveringSessions Set as re-entrancy guard. (2) Curator ran every idle — \`onIdle || afterTurns\` short-circuited (onIdle=true). Fix: \`||\` → \`&&\`. Lesson: boolean flag gating numeric threshold needs AND not OR. (3) shouldSkip() fell back to session.list() on unknown sessions. Fix: remove list fallback, cache in activeSessions.

<!-- lore:019c8f4f-67ca-7212-a8c4-8a75b230ceea -->
* **Test DB isolation via LORE\_DB\_PATH and Bun test preload**: Lore test suite uses isolated temp DB via test/setup.ts preload (bunfig.toml). Preload sets LORE\_DB\_PATH to mkdtempSync path before any imports of src/db.ts; afterAll cleans up. src/db.ts checks LORE\_DB\_PATH first. agents-file.test.ts needs beforeEach cleanup for intra-file isolation and TEST\_UUIDS cleanup in afterAll (shared with ltm.test.ts). Individual test files don't need close() calls — preload handles DB lifecycle.

### Pattern

<!-- lore:019cb050-ef48-7cbe-8e58-802f17c34591 -->
* **Lore logging: LORE\_DEBUG gating for info/warn, always-on for errors**: src/log.ts provides three levels: log.info() and log.warn() are suppressed unless LORE\_DEBUG=1 or LORE\_DEBUG=true; log.error() always emits. All write to stderr with \[lore] prefix. This exists because OpenCode TUI renders all stderr as red error text — routine status messages (distillation counts, pruning stats, consolidation) were alarming users. Rule: use log.info() for successful operations and status, log.warn() for non-actionable oddities (e.g. dropping trailing messages), log.error() only in catch blocks for real failures. Never use console.error directly in plugin source files.

<!-- lore:019cb12a-c957-7e24-b3f5-6869f3429d13 -->
* **Lore release process: craft + issue-label publish**: Lore/Craft release pipeline: (1) Trigger release.yml via workflow\_dispatch with version='auto' — craft determines version and creates GitHub issue. Label 'accepted' → publish.yml runs craft publish with npm OIDC. Don't create release branches or bump package.json manually. (2) GitHub App must be installed per-repo. APP\_ID/APP\_PRIVATE\_KEY in \`production\` environment. Symptom: 404 on GET /repos/.../installation. (3) npm OIDC only works for publish — \`npm info\` needs NPM\_TOKEN for private packages.

<!-- lore:019cb200-0001-7000-8000-000000000001 -->
* **PR workflow for opencode-lore: branch → PR → auto-merge**: All changes (including minor fixes and test-only changes) must go through a branch + PR + auto-merge, never pushed directly to main. Workflow: (1) git checkout -b \<type>/\<slug>, (2) commit, (3) git push -u origin HEAD, (4) gh pr create --title "..." --body "..." --base main, (5) gh pr merge --auto --squash \<PR#>. Branch name conventions follow merged PR history: fix/\<slug>, feat/\<slug>, chore/\<slug>. Auto-merge with squash is required (merge commits disallowed). Never push directly to main even for trivial changes.

### Preference

<!-- lore:019ca19d-fc02-7657-b2e9-7764658c01a5 -->
* **Code style**: No backwards-compat shims — fix callers directly. Prefer explicit error handling over silent failures. Derive thresholds from existing constants rather than hardcoding magic numbers. In CI, define shared env vars at workflow level, not per-job. Dry-run before bulk destructive operations (SELECT before DELETE). Prefer \`jq\`/\`sed\`/\`awk\` over \`node -e\` for JSON manipulation in CI scripts.
<!-- End lore-managed section -->
