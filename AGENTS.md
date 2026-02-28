<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/opencode-lore) -->
## Long-term Knowledge

### Architecture

<!-- lore:019c8f4f-67c8-7cf4-b93b-c5ec46ed94b6 -->
* **Lore DB uses incremental auto\_vacuum to prevent free-page bloat**: Lore's SQLite DB uses incremental auto\_vacuum (schema version 3 migration) to prevent free-page bloat from deletions. The migration sets PRAGMA auto\_vacuum = INCREMENTAL then VACUUM outside a transaction. temporal\_messages is the primary storage consumer (~51MB); knowledge table is tiny.
<!-- lore:019c94bd-042d-73c0-b850-192d1d62fa68 -->
* **Knowledge entry distribution across projects — worktree sessions create separate project IDs**: Knowledge entries are scoped by project\_id from ensureProject(projectPath). OpenCode worktree sessions (paths like ~/.local/share/opencode/worktree/\<hash>/\<slug>/) each get their own project\_id. A single repo can have multiple project\_ids: one for the real path, separate ones per worktree session. Project-specific entries (cross\_project=0) are invisible across different project\_ids. Cross-project entries (cross\_project=1) are shared globally.
<!-- lore:019c94bd-042b-7215-b0a0-05719fcd39b2 -->
* **LTM injection pipeline: system transform → forSession → formatKnowledge → gradient deduction**: LTM is injected via experimental.chat.system.transform hook. Flow: getLtmBudget() computes ceiling as (contextLimit - outputReserved - overhead) \* ltmFraction (default 10%, configurable 2-30%). forSession() loads project-specific entries unconditionally + cross-project entries scored by term overlap, greedy-packs into budget. formatKnowledge() renders as markdown. setLtmTokens() records consumption so gradient deducts it. Key: LTM goes into output.system (system prompt), not the message array — invisible to tryFit(), counts against overhead budget.
<!-- lore:019c8f8c-47c3-71a2-b5fd-248a2cfeba78 -->
* **Lore temporal pruning runs after distillation and curation on session.idle**: In src/index.ts, the session.idle handler now awaits both backgroundDistill and backgroundCurate (changed from fire-and-forget) before running temporal.prune(). This ordering is critical: pruning must run after both pipelines complete so it never deletes messages that haven't been processed. The prune call is wrapped in try/catch and logs when rows are deleted. Config comes from cfg.pruning.retention (days) and cfg.pruning.maxStorage (MB).
<!-- lore:019c904b-791e-772a-ab2b-93ac892a960c -->
* **buildSection() renders AGENTS.md directly without formatKnowledge**: AGENTS.md export/import architecture: buildSection() iterates DB entries grouped by category, emitting \<!-- lore:UUID --> markers before each bullet, serialized via remark. splitFile() scans ALL\_START\_MARKERS (current + historical marker text) to find every lore section span — self-healing: N duplicate sections collapse to 1 on next export. Adding new marker variants requires only appending to ALL\_START\_MARKERS. Import dedup: curator LLM handles semantic dedup at import time (startup when file changed). For merge conflicts: missing marker = hand-written (curator deduplicates); duplicate UUID = first wins; malformed = hand-written. ltm.create() has a title-based dedup guard (case-insensitive, skipped for explicit IDs from cross-machine import). LLM agents skip AGENTS.md in commits because it looks auto-generated — fixed via system prompt instruction and changing marker text from 'auto-maintained' to 'maintained by the coding agent'.

### Decision

<!-- lore:019c904b-7924-7187-8471-8ad2423b8946 -->
* **Curator prompt scoped to code-relevant knowledge only**: CURATOR\_SYSTEM in src/prompt.ts now explicitly excludes: general ecosystem knowledge available online, business strategy and marketing positioning, product pricing models, third-party tool details not needed for development, and personal contact information. This was added after the curator extracted entries about OpenWork integration strategy (including an email address), Lore Cloud pricing tiers, and AGENTS.md ecosystem facts — none of which help an agent write code. The curatorUser() function also appends guidance to prefer updating existing entries over creating new ones for the same concept, reducing duplicate creation.
<!-- lore:019c8f8c-47c6-7e5a-8e93-7721dc1378dc -->
* **Lore pruning defaults: 120-day retention, 1GB size cap**: User chose 120 days retention (not the originally proposed 7 days) and 1GB max storage (not 200MB). Rationale: the system is new and 7 days/200MB was based on only one week of data from a one-week-old system — not indicative of real growth. The generous defaults preserve recall capability and historical context. Config is in .lore.json under pruning.retention (days) and pruning.maxStorage (MB).
<!-- lore:dd60622e-6cf3-48c7-9715-f44fb054e150 -->
* **Use uuidv7 npm package for knowledge entry IDs**: User chose the \`uuidv7\` npm package (https://npmx.dev/package/uuidv7, by LiosK) over a self-contained ~15 line implementation. The package is RFC 9562 compliant, provides \`uuidv7()\` function that returns standard UUID string format, has a 42-bit counter for sub-millisecond monotonic ordering, and is clean/minimal. Usage: \`import { uuidv7 } from 'uuidv7'; const id = uuidv7();\` replaces \`crypto.randomUUID()\` in \`ltm.ts:31\`. Added as a runtime dependency in package.json.

### Gotcha

<!-- lore:019c91d6-04af-7334-8374-e8bbf14cb43d -->
* **Calibration used DB message count instead of transformed window count — caused layer 0 false passthrough**: Multiple gradient calibration bugs caused context overflow: (1) Calibration used DB message count instead of transformed window count — after compression (e.g. 50 msgs), delta saw ~1 new message → layer 0 passthrough → all raw messages sent → overflow. Fix: use getLastTransformedCount(). (2) actualInput formula omitted cache.write — on cold-cache turns actualInput became ~3 instead of 150K → layer 0 → overflow. Fix: include cache.write in both the formula and calibration guard. (3) Trailing pure-text assistant messages after tryFit cause Anthropic prefill errors. But messages with ANY tool parts must NOT be dropped (SDK converts to tool\_result user-role). Drop predicate: \`hasToolParts\`, not \`hasPendingTool\`. (4) Stats PATCH on message parts was removed — it was write-only dead code causing system-reminder persistence bug. Don't mutate parts you don't own.
<!-- lore:019c91c0-cdf3-71c9-be52-7f6441fb643e -->
* **Lore plugin only protects projects where it's registered in opencode.json**: The lore gradient transform only runs for projects with lore registered in opencode.json (or globally in ~/.config/opencode/). Projects without it get zero context management — messages accumulate until overflow triggers a stuck compaction loop. This caused a 404K-token overflow in a getsentry/cli session with no opencode.json.
<!-- lore:019c91ad-4d47-7afc-90e0-239a9eda57a4 -->
* **Stuck compaction loops leave orphaned user+assistant message pairs in DB**: When OpenCode compaction overflows, it creates paired user+assistant messages per retry (assistant has error.name:'ContextOverflowError', mode:'compaction'). These accumulate and worsen the session. Recovery: find last good assistant message (has tokens, no error), delete all messages after it from both \`message\` and \`part\` tables. Use json\_extract(data, '$.error.name') to identify compaction debris.
<!-- lore:019c8f4f-67ca-7212-a8c4-8a75b230ceea -->
* **Lore test suite uses live DB — no test isolation for db.test.ts**: The lore test suite (test/db.test.ts, test/ltm.test.ts) uses the live DB at ~/.local/share/opencode-lore/lore.db — no LORE\_DB\_PATH override. Test fixtures create entries with 019c9026-\* UUIDs that persist and leak into AGENTS.md exports. Known leaked entries: 'Kubernetes deployment pattern', 'TypeScript strict mode caveat', 'React useState async pitfall', 'Fine entry'. These require periodic manual cleanup from the DB. Fix needed: set LORE\_DB\_PATH to a temp file in tests.

### Pattern

<!-- lore:019c8ae9-2e54-7276-966a-befe699db589 -->
* **Use SDK internal client for HTTP requests in OpenCode plugins**: OpenCode plugins should use \`(ctx.client as any).\_client.patch()\` instead of raw fetch() with ctx.serverUrl. The \_client is the HeyAPI Client with correct base URL and interceptors, avoiding ConnectionRefused in TUI-only mode. Supports path interpolation. Caveat: \_client is private/undocumented. Note: lore's use of this pattern was removed — prefer dedicated endpoints over part mutation.

### Preference

<!-- lore:019ca19d-fc02-7657-b2e9-7764658c01a5 -->
* **Code style**: User prefers no backwards-compat shims — fix callers directly. Prefer explicit error handling over silent failures. Derive thresholds from existing constants rather than hardcoding magic numbers (e.g., use \`raw.length <= COL\_COUNT\` instead of \`n < 10\_000\`). In CI, define shared env vars at workflow level, not per-job.

### Preference

<!-- lore:019ca190-0001-7000-8000-000000000001 -->
* **Always dry-run before bulk DB deletes**: Never execute bulk DELETE/destructive operations without first running the equivalent SELECT to verify row count and inspect affected rows. A hardcoded timestamp off by one year caused deletion of all 1638 messages + 5927 parts instead of 5 debris rows. Pattern: (1) SELECT with same WHERE, (2) verify count, (3) then DELETE. Applies to any destructive op — DB mutations, git reset, file deletion.
<!-- End lore-managed section -->
