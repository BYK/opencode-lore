<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/opencode-lore) -->
## Long-term Knowledge

### Architecture

<!-- lore:019c904b-791e-772a-ab2b-93ac892a960c -->
* **buildSection() renders AGENTS.md directly without formatKnowledge**: AGENTS.md export/import: buildSection() iterates DB entries grouped by category, emitting \`\<!-- lore:UUID -->\` markers, serialized via remark. splitFile() scans ALL\_START\_MARKERS (current + historical) — self-healing: N duplicate sections collapse to 1 on next export. Import dedup handled by curator LLM at startup when file changed. Missing marker = hand-written; duplicate UUID = first wins. ltm.create() has title-based dedup guard (case-insensitive, skipped for explicit IDs from cross-machine import). Marker text says 'maintained by the coding agent' (not 'auto-maintained') so LLM agents include it in commits.

<!-- lore:019c94bd-042d-73c0-b850-192d1d62fa68 -->
* **Knowledge entry distribution across projects — worktree sessions create separate project IDs**: Knowledge entries are scoped by project\_id from ensureProject(projectPath). OpenCode worktree sessions (paths like ~/.local/share/opencode/worktree/\<hash>/\<slug>/) each get their own project\_id. A single repo can have multiple project\_ids: one for the real path, separate ones per worktree session. Project-specific entries (cross\_project=0) are invisible across different project\_ids. Cross-project entries (cross\_project=1) are shared globally.

<!-- lore:019c8f4f-67c8-7cf4-b93b-c5ec46ed94b6 -->
* **Lore DB uses incremental auto\_vacuum to prevent free-page bloat**: Lore's SQLite DB uses incremental auto\_vacuum (schema version 3 migration) to prevent free-page bloat from deletions. The migration sets PRAGMA auto\_vacuum = INCREMENTAL then VACUUM outside a transaction. temporal\_messages is the primary storage consumer (~51MB); knowledge table is tiny.

<!-- lore:019c8f8c-47c3-71a2-b5fd-248a2cfeba78 -->
* **Lore temporal pruning runs after distillation and curation on session.idle**: In src/index.ts, session.idle awaits backgroundDistill and backgroundCurate sequentially before running temporal.prune(). Ordering is critical: pruning must not delete unprocessed messages. Pruning defaults: 120-day retention, 1GB max storage (in .lore.json under pruning.retention and pruning.maxStorage). These generous defaults were chosen because the system was new — earlier proposals of 7d/200MB were based on insufficient data.

<!-- lore:019c94bd-042b-7215-b0a0-05719fcd39b2 -->
* **LTM injection pipeline: system transform → forSession → formatKnowledge → gradient deduction**: LTM is injected via experimental.chat.system.transform hook. Flow: getLtmBudget() computes ceiling as (contextLimit - outputReserved - overhead) \* ltmFraction (default 10%, configurable 2-30%). forSession() loads project-specific entries unconditionally + cross-project entries scored by term overlap, greedy-packs into budget. formatKnowledge() renders as markdown. setLtmTokens() records consumption so gradient deducts it. Key: LTM goes into output.system (system prompt), not the message array — invisible to tryFit(), counts against overhead budget.

### Decision

<!-- lore:019c904b-7924-7187-8471-8ad2423b8946 -->
* **Curator prompt scoped to code-relevant knowledge only**: CURATOR\_SYSTEM in src/prompt.ts now explicitly excludes: general ecosystem knowledge available online, business strategy and marketing positioning, product pricing models, third-party tool details not needed for development, and personal contact information. This was added after the curator extracted entries about OpenWork integration strategy (including an email address), Lore Cloud pricing tiers, and AGENTS.md ecosystem facts — none of which help an agent write code. The curatorUser() function also appends guidance to prefer updating existing entries over creating new ones for the same concept, reducing duplicate creation.

### Gotcha

<!-- lore:019c91d6-04af-7334-8374-e8bbf14cb43d -->
* **Calibration used DB message count instead of transformed window count — caused layer 0 false passthrough**: Lore gradient/context bugs: (1) Used DB message count instead of transformed window count — delta ≈ 1 → layer 0 passthrough → overflow. Fix: getLastTransformedCount(). (2) actualInput omitted cache.write — cold-cache ~3 tokens → layer 0. Fix: include cache.write. (3) Trailing pure-text assistant messages cause Anthropic prefill errors. Drop loop must run at ALL layers (layer 0 shares ref with output). Never drop messages with tool parts (hasToolParts) — causes infinite loops. (4) Unregistered projects get zero context management → stuck compaction loops. Recovery: delete messages after last good assistant message.

<!-- lore:019cb171-c0ea-75cf-bf65-b081373f136b -->
* **mt7921e 3dBm tx power on desktop — disable CLC firmware table**: mt7921e/mt7922 PCIe WiFi cards in desktop PCs (no ACPI SAR tables like WRDS/EWRD) get stuck at ~3 dBm tx power because the CLC (Country Location Code) firmware power lookup falls back to a conservative default when no SAR table exists. Fix: set \`options mt7921\_common disable\_clc=1\` in /etc/modprobe.d/mt7921.conf. This lets the regulatory domain ceiling apply (e.g. 23 dBm on 5GHz ch44 in GB). Also set explicit tx power via \`iw dev \<iface> set txpower fixed 2000\` in ExecStartPost since the module param only takes effect on next module load/reboot.

<!-- lore:019cb171-c0fa-74b0-a9a6-847901efa907 -->
* **Pixel phones fail WPA group key rekey during doze — use 86400s interval**: Android Pixel devices in deep doze/sleep fail to respond to WPA group key handshake frames within hostapd's retry window. With wpa\_group\_rekey=3600, the phone gets deauthenticated every hour ('group key handshake failed (RSN) after 4 tries'). Other devices on the same AP complete the rekey fine. Fix: set wpa\_group\_rekey=86400 (24h) instead of 0 (disabled) for security balance. Also apply to Asus router: nvram set wpa\_gtk\_rekey=86400, wl0\_wpa\_gtk\_rekey=86400, wl1\_wpa\_gtk\_rekey=86400.

<!-- lore:019cb3e6-da66-7534-a573-30d2ecadfd53 -->
* **Returning bare promises loses async function from error stack traces**: When an \`async\` function returns another promise without \`await\`, the calling function disappears from error stack traces if the inner promise rejects. A function that drops \`async\` and does \`return someAsyncCall()\` loses its frame entirely. Fix: keep the function \`async\` and use \`return await someAsyncCall()\`. This matters for debugging — the intermediate function name in the stack trace helps locate which code path triggered the failure. ESLint rule \`no-return-await\` is outdated; modern engines optimize \`return await\` in async functions.

<!-- lore:019cb171-c0fe-78a8-a5f8-4ae8e2980a70 -->
* **sudo changes $HOME to /root — hardcode user home in scripts run with sudo**: When running a script with \`sudo\`, \`$HOME\` resolves to \`/root\`, not the invoking user's home. SSH key paths like \`$HOME/.ssh/id\_ed25519\` break. Fix: use \`SUDO\_USER\` env var: \`USER\_HOME=$(eval echo ~${SUDO\_USER:-$USER})\` and reference \`$USER\_HOME/.ssh/id\_ed25519\`. This is a common trap in scripts that need both root privileges (systemctl, writing to /etc) and user-specific resources (SSH keys).

<!-- lore:019c8f4f-67ca-7212-a8c4-8a75b230ceea -->
* **Test DB isolation via LORE\_DB\_PATH and Bun test preload**: Lore test suite uses isolated temp DB via test/setup.ts preload (bunfig.toml). Preload sets LORE\_DB\_PATH to mkdtempSync path before any imports of src/db.ts; afterAll cleans up. src/db.ts checks LORE\_DB\_PATH first. agents-file.test.ts needs beforeEach cleanup for intra-file isolation and TEST\_UUIDS cleanup in afterAll (shared with ltm.test.ts). Individual test files don't need close() calls — preload handles DB lifecycle.

<!-- lore:019cb171-c0f5-741f-96cc-e0862c846202 -->
* **Ubuntu packaged hostapd lacks 802.11r (CONFIG\_IEEE80211R not compiled)**: Ubuntu 24.04 hostapd (2:2.10-21ubuntu0.x) lacks CONFIG\_IEEE80211R. Using \`ieee80211r=1\`, \`mobility\_domain\`, \`FT-PSK\` etc. causes 'unknown configuration item' and fails to start. 802.11k/v directives ARE compiled in. Verify: \`strings /usr/sbin/hostapd | grep ieee80211r\` — absence confirms no FT support. Build from source with CONFIG\_IEEE80211R=y. Note: hostapd has NO config dry-run flag — \`-t\` just adds timestamps to debug output and fully starts the AP. Use grep-based validation for known-bad directives instead.

<!-- lore:019cb286-7c85-7039-aecf-25781892c9da -->
* **Zod v4 .default({}) no longer applies inner field defaults**: Zod v4 changed \`.default()\` to short-circuit: when input is \`undefined\`, it returns the default value directly without parsing it through inner schema defaults. So \`.object({ enabled: z.boolean().default(true) }).default({})\` returns \`{}\` (no \`enabled\` key), not \`{ enabled: true }\`. Fix: provide fully-populated default objects — \`.default({ enabled: true })\`. This affected all nested config sections in src/config.ts during the v3→v4 upgrade. The import \`import { z } from "zod"\` is unchanged — Zod 4's main entry point is the v4 API.

### Pattern

<!-- lore:019cb050-ef48-7cbe-8e58-802f17c34591 -->
* **Lore logging: LORE\_DEBUG gating for info/warn, always-on for errors**: src/log.ts provides three levels: log.info() and log.warn() are suppressed unless LORE\_DEBUG=1 or LORE\_DEBUG=true; log.error() always emits. All write to stderr with \[lore] prefix. This exists because OpenCode TUI renders all stderr as red error text — routine status messages (distillation counts, pruning stats, consolidation) were alarming users. Rule: use log.info() for successful operations and status, log.warn() for non-actionable oddities (e.g. dropping trailing messages), log.error() only in catch blocks for real failures. Never use console.error directly in plugin source files.

<!-- lore:019cb12a-c957-7e24-b3f5-6869f3429d13 -->
* **Lore release process: craft + issue-label publish**: Release flow: (1) Create release/X.Y.Z branch, bump version in package.json, push and merge PR. (2) Trigger release.yml via workflow\_dispatch — uses getsentry/craft to create a GitHub issue titled 'publish: BYK/opencode-lore@X.Y.Z'. (3) Label that issue 'accepted' — triggers publish.yml (on issues:labeled) which runs craft publish with npm OIDC trusted publishing, then closes the issue. Auto-merge on release PRs requires squash merge (merge commits disallowed on this repo). The repo uses a GitHub App token (APP\_ID + APP\_PRIVATE\_KEY) for checkout in both workflows.

<!-- lore:019cb200-0001-7000-8000-000000000001 -->
* **PR workflow for opencode-lore: branch → PR → auto-merge**: All changes (including minor fixes and test-only changes) must go through a branch + PR + auto-merge, never pushed directly to main. Workflow: (1) git checkout -b \<type>/\<slug>, (2) commit, (3) git push -u origin HEAD, (4) gh pr create --title "..." --body "..." --base main, (5) gh pr merge --auto --squash \<PR#>. Branch name conventions follow merged PR history: fix/\<slug>, feat/\<slug>, chore/\<slug>. Auto-merge with squash is required (merge commits disallowed). Never push directly to main even for trivial changes.

### Preference

<!-- lore:019ca190-0001-7000-8000-000000000001 -->
* **Always dry-run before bulk DB deletes**: Never execute bulk DELETE/destructive operations without first running the equivalent SELECT to verify row count and inspect affected rows. A hardcoded timestamp off by one year caused deletion of all 1638 messages + 5927 parts instead of 5 debris rows. Pattern: (1) SELECT with same WHERE, (2) verify count, (3) then DELETE. Applies to any destructive op — DB mutations, git reset, file deletion.

<!-- lore:019ca19d-fc02-7657-b2e9-7764658c01a5 -->
* **Code style**: User prefers no backwards-compat shims — fix callers directly. Prefer explicit error handling over silent failures. Derive thresholds from existing constants rather than hardcoding magic numbers (e.g., use \`raw.length <= COL\_COUNT\` instead of \`n < 10\_000\`). In CI, define shared env vars at workflow level, not per-job.
<!-- End lore-managed section -->
