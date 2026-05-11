# Changelog
## 0.17.0

### New Features ✨

#### Gateway

- 3-tier session identification via client headers by @BYK in [#203](https://github.com/BYK/loreai/pull/203)
- Vendor fastembed for linux-arm64 binaries by @BYK in [#200](https://github.com/BYK/loreai/pull/200)
- Pin worker cch to known version/seed and re-sign conversation turns by @BYK in [#199](https://github.com/BYK/loreai/pull/199)
- Direct-bundle fastembed via bun --compile by @BYK in [#197](https://github.com/BYK/loreai/pull/197)

#### Other

- (cch) Add 2.1.138 seed, version fallback, and automated extraction pipeline by @BYK in [#212](https://github.com/BYK/loreai/pull/212)
- (ui) Add markdown rendering to web dashboard by @BYK in [#217](https://github.com/BYK/loreai/pull/217)
- Persist live session cost data (warmup, TTL, batch savings) across restarts by @BYK in [50685ede](https://github.com/BYK/loreai/commit/50685ede4a3a91a073ef17a089ccc49ba4720512)
- Add column sorting and filtering to web UI tables by @BYK in [#233](https://github.com/BYK/loreai/pull/233)
- Reduce distillation overhead with meta-distill separation, sliding expansion guard, and batch tracking by @BYK in [#229](https://github.com/BYK/loreai/pull/229)
- Improve project naming from git remote and add project delete/rename by @BYK in [#224](https://github.com/BYK/loreai/pull/224)
- Cost intelligence dashboard with per-session tracking and historical backdating by @BYK in [#222](https://github.com/BYK/loreai/pull/222)
- Speculative cache warming with survival analysis and user controls by @BYK in [#214](https://github.com/BYK/loreai/pull/214)
- Token-based distillation segmentation, √N budget, and expansion guard by @BYK in [#213](https://github.com/BYK/loreai/pull/213)
- Dynamic max_tokens sizing for workers and conversation passthrough by @BYK in [#211](https://github.com/BYK/loreai/pull/211)
- Prevent Claude Code auto-compaction with defense-in-depth by @BYK in [#210](https://github.com/BYK/loreai/pull/210)
- Identify projects by git remote to unify worktrees and clones by @BYK in [#208](https://github.com/BYK/loreai/pull/208)
- Data management CLI, recall command, web dashboard, and multi-host binding by @BYK in [#201](https://github.com/BYK/loreai/pull/201)
- Provider-aware worker model selection with multi-provider pricing by @BYK in [#186](https://github.com/BYK/loreai/pull/186)
- Cost-aware worker model, accurate cache pricing, and human-friendly invalidation reasons by @BYK in [#182](https://github.com/BYK/loreai/pull/182)
- Cost-aware cache optimization to reduce opus-4-6 write costs by @BYK in [#181](https://github.com/BYK/loreai/pull/181)

### Bug Fixes 🐛

#### Gateway

- Normalize cc_version suffix and max_tokens in cache analytics by @BYK in [#209](https://github.com/BYK/loreai/pull/209)
- Compute cch billing hash for worker requests using bearer tokens by @BYK in [#193](https://github.com/BYK/loreai/pull/193)
- Catch port-in-use errors and memoize gateway init (LOREAI-GATEWAY-2) by @BYK in [#191](https://github.com/BYK/loreai/pull/191)
- Suppress verbose startup banner in embedded mode by @BYK in [#190](https://github.com/BYK/loreai/pull/190)

#### Other

- (core) Make fastembed optional to survive CUDA 13 install failures by @BYK in [#192](https://github.com/BYK/loreai/pull/192)
- Prevent compaction summary leaking as subagent task_result to parent session by @BYK in [#236](https://github.com/BYK/loreai/pull/236)
- Increase flaky perf test threshold from 1s to 2s by @BYK in [#235](https://github.com/BYK/loreai/pull/235)
- Recover missing call_type column on distillations table by @BYK in [#232](https://github.com/BYK/loreai/pull/232)
- Update historical estimates note to reflect batch API tracking by @BYK in [357bd93c](https://github.com/BYK/loreai/commit/357bd93c83f97bad925828489eab1525175923d1)
- Remap @sentry/bun to @sentry/node in CJS npm bundle by @BYK in [#231](https://github.com/BYK/loreai/pull/231)
- Guard against test runs polluting the production database by @BYK in [#230](https://github.com/BYK/loreai/pull/230)
- Improve search quality with progressive FTS relaxation, temporal vector search, and UI overhaul by @BYK in [#228](https://github.com/BYK/loreai/pull/228)
- Binary smoke tests on macOS/Windows — isMainThread re-entry for worker thread by @BYK in [#227](https://github.com/BYK/loreai/pull/227)
- Scope test DELETE to project, add cache invalidation and recovery CLI by @BYK in [#226](https://github.com/BYK/loreai/pull/226)
- Use valid JSON placeholder in max_tokens normalization (LOREAI-GATEWAY-5) by @BYK in [#223](https://github.com/BYK/loreai/pull/223)
- Remove handleOverflowRecovery to stop race with built-in compaction by @BYK in [#220](https://github.com/BYK/loreai/pull/220)
- Worker calls falling back to stale Sonnet 4 instead of Sonnet 4.6 by @BYK in [#218](https://github.com/BYK/loreai/pull/218)
- Prevent subagent turns from polluting parent session's temporal history by @BYK in [#216](https://github.com/BYK/loreai/pull/216)
- Isolate subagent turns from parent session's dynamic max_tokens EMA by @BYK in [#215](https://github.com/BYK/loreai/pull/215)
- Per-session urgentDistillation and layer 1 distillation trigger by @BYK in [#204](https://github.com/BYK/loreai/pull/204)
- Per-session cch + split retry budget + unblock fastembed backfill by @BYK in [#195](https://github.com/BYK/loreai/pull/195)
- Increase Bun.serve idleTimeout for LLM streaming responses by @BYK in [#189](https://github.com/BYK/loreai/pull/189)
- Handle client disconnect in streaming pipeline (LOREAI-GATEWAY-3) by @BYK in [#188](https://github.com/BYK/loreai/pull/188)
- Normalize Claude CLI cch= hash in cache analytics by @BYK in [#187](https://github.com/BYK/loreai/pull/187)
- Use claude-sonnet-4-6 for worker model default (same price, latest version) by @BYK in [06353151](https://github.com/BYK/loreai/commit/0635315124d07b23cc128954231131cdc51ac2fc)
- Prevent ReadableStream controller double-close in streaming pipeline by @BYK in [#183](https://github.com/BYK/loreai/pull/183)

### Documentation 📚

- Add codebase overview to AGENTS.md to eliminate redundant explore runs by @BYK in [#234](https://github.com/BYK/loreai/pull/234)

### Internal Changes 🔧

- Strip Pi plugin to gateway-only mode by @BYK in [#238](https://github.com/BYK/loreai/pull/238)
- Strip OpenCode plugin to gateway-only mode by @BYK in [#237](https://github.com/BYK/loreai/pull/237)
- Move fastembed ONNX inference to worker thread (#196) by @BYK in [#225](https://github.com/BYK/loreai/pull/225)
- Skip redundant .lore.md import/export via mtime + content hash cache by @BYK in [#219](https://github.com/BYK/loreai/pull/219)
- Drop darwin-x64 (Intel macOS) target by @BYK in [#198](https://github.com/BYK/loreai/pull/198)

### Other

- debug: verify worker file exists before compile by @BYK in [25bd12fd](https://github.com/BYK/loreai/commit/25bd12fda775d2fa05c6e4736616ddb6fcc0c364)
- debug: log compile command to diagnose CI binary smoke test failure by @BYK in [c954862c](https://github.com/BYK/loreai/commit/c954862cc5c5aea63937828c2bc907fa5baa7935)

## 0.16.0

### New Features ✨

- (gateway) Add SENTRY_ENABLED toggle and environment tagging by @BYK in [#178](https://github.com/BYK/loreai/pull/178)
- Simplify worker model to session model, use live models.dev pricing by @BYK in [#179](https://github.com/BYK/loreai/pull/179)

## 0.15.0

### New Features ✨

#### Compact

- Anchor /compact on prior summary via SDK live read by @BYK in [#100](https://github.com/BYK/loreai/pull/100)
- Adopt upstream SUMMARY_TEMPLATE for /compact prompt by @BYK in [#92](https://github.com/BYK/loreai/pull/92)

#### Distill

- Anchor meta-distillation on prior summary; loadForSession excludes archived by @BYK in [#101](https://github.com/BYK/loreai/pull/101)
- Truncate oversized tool outputs in distillation input by @BYK in [#94](https://github.com/BYK/loreai/pull/94)

#### Gateway

- Debug ID source maps + zero runtime dependencies by @BYK in [#171](https://github.com/BYK/loreai/pull/171)
- Background version check with upgrade nag by @BYK in [#168](https://github.com/BYK/loreai/pull/168)
- Implement delta-based self-upgrade system by @BYK in [#166](https://github.com/BYK/loreai/pull/166)
- Show env vars and agent integration info on lore start by @BYK in [#165](https://github.com/BYK/loreai/pull/165)
- CLI skeleton with npm bundle, binary build, and CI smoke tests by @BYK in [#159](https://github.com/BYK/loreai/pull/159)
- Ground-truth cache analytics with request body prefix diff by @BYK in [#155](https://github.com/BYK/loreai/pull/155)
- Worker model discovery via /v1/models API + models.dev pricing by @BYK in [#142](https://github.com/BYK/loreai/pull/142)
- Transparent recall tool interception by @BYK in [#139](https://github.com/BYK/loreai/pull/139)
- Per-session auth isolation + OAuth Bearer support by @BYK in [#135](https://github.com/BYK/loreai/pull/135)
- Replace content markers with fingerprint-based session tracking by @BYK in [#125](https://github.com/BYK/loreai/pull/125)

#### Gradient

- Range-aware file read deduplication by @BYK in [#120](https://github.com/BYK/loreai/pull/120)
- Token-budget tail sizing in layer 4 by @BYK in [#104](https://github.com/BYK/loreai/pull/104)
- Cold-cache idle-resume cache refresh by @BYK in [#95](https://github.com/BYK/loreai/pull/95)

#### Worker Model

- Prefer non-reasoning models and disable thinking on worker calls by @BYK in [#122](https://github.com/BYK/loreai/pull/122)
- Wire up dynamic model selection on session idle by @BYK in [#118](https://github.com/BYK/loreai/pull/118)

#### Other

- (db) Persist r_compression and c_norm on distillations (schema v12) by @BYK in [#116](https://github.com/BYK/loreai/pull/116)
- (pi) @loreai/pi extension — Lore memory for Pi coding-agent by @BYK in [#78](https://github.com/BYK/loreai/pull/78)
- (recovery) Media-aware overflow recovery preserves user intent by @BYK in [#99](https://github.com/BYK/loreai/pull/99)
- (website) Add landing page by @sylncnr in [#152](https://github.com/BYK/loreai/pull/152)
- Sentry observability with AI monitoring, metadata table, and cost metrics by @BYK in [#176](https://github.com/BYK/loreai/pull/176)
- Wire structured logs and error capture to Sentry in prod builds by @BYK in [#170](https://github.com/BYK/loreai/pull/170)
- Web install script and updated landing page by @BYK in [#163](https://github.com/BYK/loreai/pull/163)
- Layered cache breakpoints and LTM content-diff pinning by @BYK in [#157](https://github.com/BYK/loreai/pull/157)
- Emit '[Searching memory...]' indicator for Case 2 (mixed tools) by @BYK in [6ef1b7b0](https://github.com/BYK/loreai/commit/6ef1b7b0a8cbcbd4accc952ccb3477fa6f47775d)
- Local embeddings, exact keyword boost, and pattern extraction by @BYK in [#136](https://github.com/BYK/loreai/pull/136)
- Batch queue for Anthropic Message Batches API (50% worker cost savings) by @BYK in [#134](https://github.com/BYK/loreai/pull/134)
- Context health diagnostics — C_norm, R_compression, time-gap segmentation, recall recency by @BYK in [#113](https://github.com/BYK/loreai/pull/113)
- Cost reduction — layer-0 cap, worker model, tighter defaults by @BYK in [#105](https://github.com/BYK/loreai/pull/105)

### Bug Fixes 🐛

#### Ci

- Use non-hidden placeholder for release-patches artifact by @BYK in [ac910438](https://github.com/BYK/loreai/commit/ac91043841c984d7f2f753237fcfb344ec9023dc)
- Use non-hidden placeholder for release-patches artifact by @BYK in [ea2cdf02](https://github.com/BYK/loreai/commit/ea2cdf023c128cb5a872aa1844f35d0915699022)
- Always upload release-patches artifact on release branches by @BYK in [9bf811fa](https://github.com/BYK/loreai/commit/9bf811fad0fcf7b3a0356e45cf9ef24ead353466)
- Always upload release-patches artifact on release branches by @BYK in [3131210c](https://github.com/BYK/loreai/commit/3131210c36b8e9fd7fb26949d74a23edb25082a6)
- Include @loreai/gateway in pack and publish targets by @BYK in [0b8a2213](https://github.com/BYK/loreai/commit/0b8a221390891a7d683dd6e3bc924d0f357ac10d)

#### Db

- Use os.homedir() for cross-platform data directory resolution by @BYK in [#131](https://github.com/BYK/loreai/pull/131)
- Recover missing kv_meta from partial migration failure by @BYK in [#114](https://github.com/BYK/loreai/pull/114)
- Prevent singleton poisoning when migrate() throws by @BYK in [#111](https://github.com/BYK/loreai/pull/111)

#### Gateway

- Align npm package with sentry-cli pattern by @BYK in [b190738a](https://github.com/BYK/loreai/commit/b190738a8ddec006dd0e6946b68d57e43fc1947b)
- Don't wipe dist-bin/ between cross-platform binary builds by @BYK in [a6d4db7f](https://github.com/BYK/loreai/commit/a6d4db7fd06d2efdcc06be2d694083e830557beb)
- Add worker retry with backoff and batch API circuit breaker by @BYK in [#164](https://github.com/BYK/loreai/pull/164)
- Suppress agent detection noise in embedded server mode by @BYK in [#161](https://github.com/BYK/loreai/pull/161)
- Preserve thinking block signature through Lore format round-trip by @BYK in [#162](https://github.com/BYK/loreai/pull/162)
- Cache analytics JSON path missing array index for first element by @BYK in [#156](https://github.com/BYK/loreai/pull/156)

#### Gradient

- Deterministic timestamps in sanitizeToolParts by @BYK in [#124](https://github.com/BYK/loreai/pull/124)
- Protect active tool-call chains from output stripping by @BYK in [#109](https://github.com/BYK/loreai/pull/109)

#### Opencode

- Robust context-overflow detection with upstream regex list by @BYK in [#93](https://github.com/BYK/loreai/pull/93)
- Hoist ltmSessionCache to avoid TDZ on startup by @BYK in [#77](https://github.com/BYK/loreai/pull/77)

#### Release

- Include gateway in bump-version.sh for Craft publish by @BYK in [8db81083](https://github.com/BYK/loreai/commit/8db8108387e1eea706c56866cb9312f80a02ed4d)
- Patch bun.lock workspace versions during bump by @BYK in [#88](https://github.com/BYK/loreai/pull/88)
- Custom bump script to work around npm workspace:* incompatibility by @BYK in [#83](https://github.com/BYK/loreai/pull/83)

#### Other

- (cache) Remove idle-handler LTM cache invalidation to preserve warm prefix by @BYK in [#160](https://github.com/BYK/loreai/pull/160)
- (distill) Wrap metaDistill store+archive in a transaction by @BYK in [#103](https://github.com/BYK/loreai/pull/103)
- (pi) Add pi.extensions manifest and externalize pi ecosystem deps by @BYK in [#90](https://github.com/BYK/loreai/pull/90)
- (publish) Add registry-url to setup-node for npm OIDC by @BYK in [#85](https://github.com/BYK/loreai/pull/85)
- Include binary and patch artifacts in Craft release workflow by @BYK in [#172](https://github.com/BYK/loreai/pull/172)
- Pin @huggingface/hub@2.11.0 to avoid broken xetchunk-wasm workspace refs by @BYK in [#150](https://github.com/BYK/loreai/pull/150)
- Resolve all 11 audit vulnerabilities (7 high, 4 moderate) by @BYK in [#149](https://github.com/BYK/loreai/pull/149)
- Resolve typecheck error in content-based fingerprint and increase hysteresis to 15% with high-water mark budget by @BYK in [4e59e007](https://github.com/BYK/loreai/commit/4e59e00776913e9fbe7d604a3746ed7b57ada856)
- Eliminate gradient cache busts with deterministic IDs, offset-from-end pins, and cost-aware cap by @BYK in [13f09ad3](https://github.com/BYK/loreai/commit/13f09ad326f91d5a8b0bdc3f56af166bef4dbfc5)
- Stabilize gradient cache with budget snapshot, hysteresis, and per-session LTM by @BYK in [#144](https://github.com/BYK/loreai/pull/144)
- Type errors in Case 2 integration tests by @BYK in [77eb640e](https://github.com/BYK/loreai/commit/77eb640ec3f7920a462f628d59d42ba3a209db30)
- Deprecated worker models, invalid cache TTL format, and batch error logging by @BYK in [#140](https://github.com/BYK/loreai/pull/140)
- Prevent re-entrant deadlock in event hook (MaxListenersExceeded hang) by @BYK in [#138](https://github.com/BYK/loreai/pull/138)
- Reduce cache-bust cost with idle threshold, sticky layers, bust tracking, and meta-distill gating by @BYK in [#132](https://github.com/BYK/loreai/pull/132)
- CROSS JOIN for FTS5 queries — prevent server freeze on recall by @BYK in [#107](https://github.com/BYK/loreai/pull/107)
- Add root exports trampoline for file:// plugin loading by @BYK in [#73](https://github.com/BYK/loreai/pull/73)

### Documentation 📚

- Update landing page with gateway architecture and waitlist form by @sylncnr in [#153](https://github.com/BYK/loreai/pull/153)
- Add prompt change discipline guide by @BYK in [#97](https://github.com/BYK/loreai/pull/97)
- Per-package README and LICENSE for npm by @BYK in [#80](https://github.com/BYK/loreai/pull/80)

### Internal Changes 🔧

#### Agents Md

- Sync curator entries before release by @BYK in [#82](https://github.com/BYK/loreai/pull/82)
- Monorepo milestone — root trampoline documented by @BYK in [#74](https://github.com/BYK/loreai/pull/74)
- Sync curator-managed knowledge entries by @BYK in [#70](https://github.com/BYK/loreai/pull/70)

#### Core

- Decouple from @opencode-ai/sdk with host-agnostic types and LLMClient by @BYK in [#76](https://github.com/BYK/loreai/pull/76)
- Add esbuild build script for node + bun targets by @BYK in [#75](https://github.com/BYK/loreai/pull/75)
- Abstract SQLite driver behind #db/driver subpath by @BYK in [#72](https://github.com/BYK/loreai/pull/72)

#### Gradient

- Batch distillation consumption at turn boundaries by @BYK in [#123](https://github.com/BYK/loreai/pull/123)
- Pin reasoning preservation across all gradient layers by @BYK in [#96](https://github.com/BYK/loreai/pull/96)

#### Opencode

- Skip duplicated logic when gateway is active by @BYK in [#158](https://github.com/BYK/loreai/pull/158)
- Add upstream-drift contract tests for hook invocation by @BYK in [#102](https://github.com/BYK/loreai/pull/102)

#### Other

- (gateway) Unified recall marker-and-expand strategy by @BYK in [#154](https://github.com/BYK/loreai/pull/154)
- (temporal) Unambiguous chunk terminator in partsToText by @BYK in [#98](https://github.com/BYK/loreai/pull/98)
- Add dist-bin/ to gitignore by @BYK in [#169](https://github.com/BYK/loreai/pull/169)
- Add nightly builds with delta patches and GHCR distribution by @BYK in [#167](https://github.com/BYK/loreai/pull/167)
- Use models.dev unified JSON API for cost data by @BYK in [#143](https://github.com/BYK/loreai/pull/143)
- Case 2 (mixed tools) integration tests for recall interception by @BYK in [#141](https://github.com/BYK/loreai/pull/141)
- Migrate knowledge entries from AGENTS.md to .lore.md by @BYK in [da2a18bb](https://github.com/BYK/loreai/commit/da2a18bb4e4c1200601b57d68ab4e70bbd0b688c)
- Remove gateway observer hooks and dead recorder exports by @BYK in [#130](https://github.com/BYK/loreai/pull/130)
- Remove read-time temporal enrichment from distillation prefix by @BYK in [#129](https://github.com/BYK/loreai/pull/129)
- Update license to FSL-1.1-Apache-2.0 by @BYK in [#126](https://github.com/BYK/loreai/pull/126)
- Update repository URLs to BYK/loreai after rename by @BYK in [#86](https://github.com/BYK/loreai/pull/86)
- Rename opencode-lore to @loreai/opencode with legacy mirror by @BYK in [#81](https://github.com/BYK/loreai/pull/81)
- Multi-package release pipeline for @loreai scope by @BYK in [#79](https://github.com/BYK/loreai/pull/79)
- Split into @loreai/core + opencode-lore monorepo by @BYK in [#71](https://github.com/BYK/loreai/pull/71)

### Other

- release: 0.14.0 by @BYK in [ec0ad773](https://github.com/BYK/loreai/commit/ec0ad773468f7b632f5b21624d8e1f6de8a0c904)
- Create CNAME by @BYK in [a892d4c9](https://github.com/BYK/loreai/commit/a892d4c95d8c41917266c232641e21f861e4d815)
- Delete CNAME by @BYK in [fdff9751](https://github.com/BYK/loreai/commit/fdff975152570cd71dfbfacd4295c7076384f771)
- Create CNAME by @BYK in [3734d0fa](https://github.com/BYK/loreai/commit/3734d0fa534f3b0db39f53ff2d987c62e9c8fd63)
- release: 0.13.4 by @BYK in [ff3d1645](https://github.com/BYK/loreai/commit/ff3d1645c21617fee177b2d02504010b0be197d3)
- release: 0.13.3 by @BYK in [3ee00766](https://github.com/BYK/loreai/commit/3ee007663fa02be76fa45f1f221b00bc66297355)
- release: 0.12.0 by @BYK in [389e73c5](https://github.com/BYK/loreai/commit/389e73c5bdb29c549b5dd7389f3405dccccd182d)
- release: 0.11.1 by @BYK in [43ead9f3](https://github.com/BYK/loreai/commit/43ead9f33427d9673944298b11ae39ccd989665c)
- release: 0.11.0 by @BYK in [cc12aafb](https://github.com/BYK/loreai/commit/cc12aafb2c25b51e9738d4b0da2037391b4efc29)
- release: 0.10.2 by @BYK in [0fe8fbcf](https://github.com/BYK/loreai/commit/0fe8fbcf03f757e519068c86551f14f0940ef5ad)
- release: 0.10.1 by @BYK in [fa8e4704](https://github.com/BYK/loreai/commit/fa8e4704f5a32933e2f92eafe8e8e35f3c206f08)
- release: 0.10.0 by @BYK in [e08f26fb](https://github.com/BYK/loreai/commit/e08f26fb7d34bfe27f4992c406a2f96ff09a6ca8)

## 0.14.0

### New Features ✨

#### Gateway

- Debug ID source maps + zero runtime dependencies by @BYK in [#171](https://github.com/BYK/loreai/pull/171)
- Background version check with upgrade nag by @BYK in [#168](https://github.com/BYK/loreai/pull/168)
- Implement delta-based self-upgrade system by @BYK in [#166](https://github.com/BYK/loreai/pull/166)
- Show env vars and agent integration info on lore start by @BYK in [#165](https://github.com/BYK/loreai/pull/165)
- CLI skeleton with npm bundle, binary build, and CI smoke tests by @BYK in [#159](https://github.com/BYK/loreai/pull/159)
- Ground-truth cache analytics with request body prefix diff by @BYK in [#155](https://github.com/BYK/loreai/pull/155)

#### Other

- (website) Add landing page by @sylncnr in [#152](https://github.com/BYK/loreai/pull/152)
- Wire structured logs and error capture to Sentry in prod builds by @BYK in [#170](https://github.com/BYK/loreai/pull/170)
- Web install script and updated landing page by @BYK in [#163](https://github.com/BYK/loreai/pull/163)
- Layered cache breakpoints and LTM content-diff pinning by @BYK in [#157](https://github.com/BYK/loreai/pull/157)

### Bug Fixes 🐛

#### Gateway

- Add worker retry with backoff and batch API circuit breaker by @BYK in [#164](https://github.com/BYK/loreai/pull/164)
- Suppress agent detection noise in embedded server mode by @BYK in [#161](https://github.com/BYK/loreai/pull/161)
- Preserve thinking block signature through Lore format round-trip by @BYK in [#162](https://github.com/BYK/loreai/pull/162)
- Cache analytics JSON path missing array index for first element by @BYK in [#156](https://github.com/BYK/loreai/pull/156)

#### Other

- (cache) Remove idle-handler LTM cache invalidation to preserve warm prefix by @BYK in [#160](https://github.com/BYK/loreai/pull/160)
- Include binary and patch artifacts in Craft release workflow by @BYK in [#172](https://github.com/BYK/loreai/pull/172)

### Documentation 📚

- Update landing page with gateway architecture and waitlist form by @sylncnr in [#153](https://github.com/BYK/loreai/pull/153)

### Internal Changes 🔧

- (gateway) Unified recall marker-and-expand strategy by @BYK in [#154](https://github.com/BYK/loreai/pull/154)
- (opencode) Skip duplicated logic when gateway is active by @BYK in [#158](https://github.com/BYK/loreai/pull/158)
- Add dist-bin/ to gitignore by @BYK in [#169](https://github.com/BYK/loreai/pull/169)
- Add nightly builds with delta patches and GHCR distribution by @BYK in [#167](https://github.com/BYK/loreai/pull/167)

### Other

- Create CNAME by @BYK in [a653c597](https://github.com/BYK/loreai/commit/a653c597a6c460e3de59b9ee2ac17afee9d3b656)
- Delete CNAME by @BYK in [226d17a9](https://github.com/BYK/loreai/commit/226d17a9de33cff88ad581e5e4ef3cf79aaf272b)
- Create CNAME by @BYK in [b8384c82](https://github.com/BYK/loreai/commit/b8384c82806cf995bb5361143f0c045f5ba477ee)

## 0.13.4

### Bug Fixes 🐛

- Pin @huggingface/hub@2.11.0 to avoid broken xetchunk-wasm workspace refs by @BYK in [#150](https://github.com/BYK/loreai/pull/150)
- Resolve all 11 audit vulnerabilities (7 high, 4 moderate) by @BYK in [#149](https://github.com/BYK/loreai/pull/149)

## 0.13.3

### New Features ✨

#### Gateway

- Worker model discovery via /v1/models API + models.dev pricing by @BYK in [#142](https://github.com/BYK/loreai/pull/142)
- Transparent recall tool interception by @BYK in [#139](https://github.com/BYK/loreai/pull/139)
- Per-session auth isolation + OAuth Bearer support by @BYK in [#135](https://github.com/BYK/loreai/pull/135)
- Replace content markers with fingerprint-based session tracking by @BYK in [#125](https://github.com/BYK/loreai/pull/125)

#### Worker Model

- Prefer non-reasoning models and disable thinking on worker calls by @BYK in [#122](https://github.com/BYK/loreai/pull/122)
- Wire up dynamic model selection on session idle by @BYK in [#118](https://github.com/BYK/loreai/pull/118)

#### Other

- (db) Persist r_compression and c_norm on distillations (schema v12) by @BYK in [#116](https://github.com/BYK/loreai/pull/116)
- (gradient) Range-aware file read deduplication by @BYK in [#120](https://github.com/BYK/loreai/pull/120)
- Emit '[Searching memory...]' indicator for Case 2 (mixed tools) by @BYK in [a5a8e215](https://github.com/BYK/loreai/commit/a5a8e2151d3a25757b6b9ebd65b0fbbb08f78ce6)
- Local embeddings, exact keyword boost, and pattern extraction by @BYK in [#136](https://github.com/BYK/loreai/pull/136)
- Batch queue for Anthropic Message Batches API (50% worker cost savings) by @BYK in [#134](https://github.com/BYK/loreai/pull/134)

### Bug Fixes 🐛

- (ci) Include @loreai/gateway in pack and publish targets by @BYK in [a5c6bc0c](https://github.com/BYK/loreai/commit/a5c6bc0c02c8c94466f8f84afa453c5dce2c5d17)
- (db) Use os.homedir() for cross-platform data directory resolution by @BYK in [#131](https://github.com/BYK/loreai/pull/131)
- (gradient) Deterministic timestamps in sanitizeToolParts by @BYK in [#124](https://github.com/BYK/loreai/pull/124)
- (release) Include gateway in bump-version.sh for Craft publish by @BYK in [eefdb53f](https://github.com/BYK/loreai/commit/eefdb53f9fcd18b6a3c623f61b863b38078e3146)
- Resolve typecheck error in content-based fingerprint and increase hysteresis to 15% with high-water mark budget by @BYK in [c8dcf035](https://github.com/BYK/loreai/commit/c8dcf0354fee7bd052c1e9776a7fac0af5b8501a)
- Eliminate gradient cache busts with deterministic IDs, offset-from-end pins, and cost-aware cap by @BYK in [321accc3](https://github.com/BYK/loreai/commit/321accc32dfdb54a654fe52923fbda2e613d90a0)
- Stabilize gradient cache with budget snapshot, hysteresis, and per-session LTM by @BYK in [#144](https://github.com/BYK/loreai/pull/144)
- Type errors in Case 2 integration tests by @BYK in [4e2282d8](https://github.com/BYK/loreai/commit/4e2282d8c3df5e44a69e97fa870f5bd6b30d18a6)
- Deprecated worker models, invalid cache TTL format, and batch error logging by @BYK in [#140](https://github.com/BYK/loreai/pull/140)
- Prevent re-entrant deadlock in event hook (MaxListenersExceeded hang) by @BYK in [#138](https://github.com/BYK/loreai/pull/138)
- Reduce cache-bust cost with idle threshold, sticky layers, bust tracking, and meta-distill gating by @BYK in [#132](https://github.com/BYK/loreai/pull/132)

### Internal Changes 🔧

- (gradient) Batch distillation consumption at turn boundaries by @BYK in [#123](https://github.com/BYK/loreai/pull/123)
- Use models.dev unified JSON API for cost data by @BYK in [#143](https://github.com/BYK/loreai/pull/143)
- Case 2 (mixed tools) integration tests for recall interception by @BYK in [#141](https://github.com/BYK/loreai/pull/141)
- Migrate knowledge entries from AGENTS.md to .lore.md by @BYK in [107346f1](https://github.com/BYK/loreai/commit/107346f1415bea442f636bb85da84e94c014b37b)
- Remove gateway observer hooks and dead recorder exports by @BYK in [#130](https://github.com/BYK/loreai/pull/130)
- Remove read-time temporal enrichment from distillation prefix by @BYK in [#129](https://github.com/BYK/loreai/pull/129)
- Update license to FSL-1.1-Apache-2.0 by @BYK in [#126](https://github.com/BYK/loreai/pull/126)

## 0.12.0

### New Features ✨

- Context health diagnostics — C_norm, R_compression, time-gap segmentation, recall recency by @BYK in [#113](https://github.com/BYK/loreai/pull/113)

### Bug Fixes 🐛

- (db) Recover missing kv_meta from partial migration failure by @BYK in [#114](https://github.com/BYK/loreai/pull/114)

## 0.11.1

### Bug Fixes 🐛

- (db) Prevent singleton poisoning when migrate() throws by @BYK in [#111](https://github.com/BYK/loreai/pull/111)
- (gradient) Protect active tool-call chains from output stripping by @BYK in [#109](https://github.com/BYK/loreai/pull/109)

## 0.11.0

### New Features ✨

#### Compact

- Anchor /compact on prior summary via SDK live read by @BYK in [#100](https://github.com/BYK/loreai/pull/100)
- Adopt upstream SUMMARY_TEMPLATE for /compact prompt by @BYK in [#92](https://github.com/BYK/loreai/pull/92)

#### Distill

- Anchor meta-distillation on prior summary; loadForSession excludes archived by @BYK in [#101](https://github.com/BYK/loreai/pull/101)
- Truncate oversized tool outputs in distillation input by @BYK in [#94](https://github.com/BYK/loreai/pull/94)

#### Gradient

- Token-budget tail sizing in layer 4 by @BYK in [#104](https://github.com/BYK/loreai/pull/104)
- Cold-cache idle-resume cache refresh by @BYK in [#95](https://github.com/BYK/loreai/pull/95)

#### Other

- (recovery) Media-aware overflow recovery preserves user intent by @BYK in [#99](https://github.com/BYK/loreai/pull/99)
- Cost reduction — layer-0 cap, worker model, tighter defaults by @BYK in [#105](https://github.com/BYK/loreai/pull/105)

### Bug Fixes 🐛

- (distill) Wrap metaDistill store+archive in a transaction by @BYK in [#103](https://github.com/BYK/loreai/pull/103)
- (opencode) Robust context-overflow detection with upstream regex list by @BYK in [#93](https://github.com/BYK/loreai/pull/93)
- CROSS JOIN for FTS5 queries — prevent server freeze on recall by @BYK in [#107](https://github.com/BYK/loreai/pull/107)

### Documentation 📚

- Add prompt change discipline guide by @BYK in [#97](https://github.com/BYK/loreai/pull/97)

### Internal Changes 🔧

- (gradient) Pin reasoning preservation across all gradient layers by @BYK in [#96](https://github.com/BYK/loreai/pull/96)
- (opencode) Add upstream-drift contract tests for hook invocation by @BYK in [#102](https://github.com/BYK/loreai/pull/102)
- (temporal) Unambiguous chunk terminator in partsToText by @BYK in [#98](https://github.com/BYK/loreai/pull/98)

## 0.10.2

### Bug Fixes 🐛

- (pi) Add pi.extensions manifest and externalize pi ecosystem deps by @BYK in [#90](https://github.com/BYK/loreai/pull/90)

## 0.10.1

### Bug Fixes 🐛

- (release) Patch bun.lock workspace versions during bump by @BYK in [#88](https://github.com/BYK/loreai/pull/88)

## 0.10.0

### New Features ✨

- (pi) @loreai/pi extension — Lore memory for Pi coding-agent by @BYK in [#78](https://github.com/BYK/loreai/pull/78)

### Bug Fixes 🐛

- (opencode) Hoist ltmSessionCache to avoid TDZ on startup by @BYK in [#77](https://github.com/BYK/loreai/pull/77)
- (publish) Add registry-url to setup-node for npm OIDC by @BYK in [#85](https://github.com/BYK/loreai/pull/85)
- (release) Custom bump script to work around npm workspace:* incompatibility by @BYK in [#83](https://github.com/BYK/loreai/pull/83)
- Add root exports trampoline for file:// plugin loading by @BYK in [#73](https://github.com/BYK/loreai/pull/73)

### Documentation 📚

- Per-package README and LICENSE for npm by @BYK in [#80](https://github.com/BYK/loreai/pull/80)

### Internal Changes 🔧

#### Agents Md

- Sync curator entries before release by @BYK in [#82](https://github.com/BYK/loreai/pull/82)
- Monorepo milestone — root trampoline documented by @BYK in [#74](https://github.com/BYK/loreai/pull/74)
- Sync curator-managed knowledge entries by @BYK in [#70](https://github.com/BYK/loreai/pull/70)

#### Core

- Decouple from @opencode-ai/sdk with host-agnostic types and LLMClient by @BYK in [#76](https://github.com/BYK/loreai/pull/76)
- Add esbuild build script for node + bun targets by @BYK in [#75](https://github.com/BYK/loreai/pull/75)
- Abstract SQLite driver behind #db/driver subpath by @BYK in [#72](https://github.com/BYK/loreai/pull/72)

#### Other

- Update repository URLs to BYK/loreai after rename by @BYK in [#86](https://github.com/BYK/loreai/pull/86)
- Rename opencode-lore to @loreai/opencode with legacy mirror by @BYK in [#81](https://github.com/BYK/loreai/pull/81)
- Multi-package release pipeline for @loreai scope by @BYK in [#79](https://github.com/BYK/loreai/pull/79)
- Split into @loreai/core + opencode-lore monorepo by @BYK in [#71](https://github.com/BYK/loreai/pull/71)

## 0.9.1

### Bug Fixes 🐛

- Sanitize unpaired Unicode surrogates in recall and temporal storage by @BYK in [#68](https://github.com/BYK/opencode-lore/pull/68)
- Resilient worker prompting with agent-not-found retry by @BYK in [#67](https://github.com/BYK/opencode-lore/pull/67)

## 0.9.0

### New Features ✨

- Lat.md integration, knowledge cross-references, and integrity checking by @BYK in [#65](https://github.com/BYK/opencode-lore/pull/65)

## 0.8.0

### New Features ✨

- Content-aware deduplication pre-pass in gradient transform by @BYK in [#60](https://github.com/BYK/opencode-lore/pull/60)
- Multi-provider embeddings, distillation vector search, and cross-project recall by @BYK in [#58](https://github.com/BYK/opencode-lore/pull/58)

### Bug Fixes 🐛

- Switch publish workflow to Node 24, drop broken npm upgrade step by @BYK in [#62](https://github.com/BYK/opencode-lore/pull/62)
- Lower curation threshold, add per-session tracking, and improve observability by @BYK in [#56](https://github.com/BYK/opencode-lore/pull/56)

## 0.7.1

### Bug Fixes 🐛

- Sanitize pending/running tool parts to prevent orphaned tool_use by @BYK in [#54](https://github.com/BYK/opencode-lore/pull/54)

## 0.7.0

### New Features ✨

- Add Voyage AI embedding search by @BYK in [#50](https://github.com/BYK/opencode-lore/pull/50)
- Add search config surface and LLM query expansion by @BYK in [#49](https://github.com/BYK/opencode-lore/pull/49)
- Replace forSession() scoring with FTS5 BM25 by @BYK in [#48](https://github.com/BYK/opencode-lore/pull/48)
- Add RRF score fusion and rewrite recall tool by @BYK in [#47](https://github.com/BYK/opencode-lore/pull/47)
- Improve FTS5 search foundations by @BYK in [#46](https://github.com/BYK/opencode-lore/pull/46)

### Bug Fixes 🐛

- Catch unhandled exceptions in transform hooks and avoid loading embedding BLOBs by @BYK in [#52](https://github.com/BYK/opencode-lore/pull/52)
- Auto-enable embeddings when VOYAGE_API_KEY is set by @BYK in [#51](https://github.com/BYK/opencode-lore/pull/51)

## 0.6.2

### Bug Fixes 🐛

- Prevent EROFS crash when launched outside a git repo by @BYK in [#43](https://github.com/BYK/opencode-lore/pull/43)
- Cache LTM per session to preserve prompt cache hit rate by @BYK in [#42](https://github.com/BYK/opencode-lore/pull/42)

## 0.6.1

### Bug Fixes 🐛

- Rotate worker sessions after each LLM call and add recall error handling by @BYK in [#38](https://github.com/BYK/opencode-lore/pull/38)

## 0.6.0

### New Features ✨

- Research-informed compaction improvements by @BYK in [#35](https://github.com/BYK/opencode-lore/pull/35)

### Bug Fixes 🐛

- Prevent cross-project knowledge entries from leaking into AGENTS.md by @BYK in [#36](https://github.com/BYK/opencode-lore/pull/36)

## 0.5.3

### Bug Fixes 🐛

- Prevent excessive background LLM requests causing rate limiting and sluggishness by @BYK in [#33](https://github.com/BYK/opencode-lore/pull/33)
- Upgrade zod from v3 to v4 by @BYK in [#32](https://github.com/BYK/opencode-lore/pull/32)
- Drop trailing pure-text assistant messages at layer 0 too by @BYK in [#31](https://github.com/BYK/opencode-lore/pull/31)
- Isolate test suite from live lore DB via LORE_DB_PATH preload by @BYK in [b96cb956](https://github.com/BYK/opencode-lore/commit/b96cb95629cdd8257290e1d36932cc67fbce0a2b)

### Internal Changes 🔧

- Remove leaked test fixture entries from AGENTS.md by @BYK in [54dbae18](https://github.com/BYK/opencode-lore/commit/54dbae1832959aff8f513c23338585ed4b18dec7)

## 0.5.2

### Bug Fixes 🐛

- Make AGENTS.md export merge-friendly with sorted entries and blank line separators by @BYK in [#28](https://github.com/BYK/opencode-lore/pull/28)

### Other

- release: 0.5.2 by @BYK in [#29](https://github.com/BYK/opencode-lore/pull/29)

## 0.5.1

- Suppress informational log messages in TUI mode by @BYK in [#26](https://github.com/BYK/opencode-lore/pull/26)

## 0.5.0

### New Features ✨

- Add knowledge.enabled option to disable LTM system by @BYK in [#23](https://github.com/BYK/opencode-lore/pull/23)

## 0.4.4

### Bug Fixes 🐛

- (gradient) Persist forceMinLayer and auto-recover from context overflow by @BYK in [#21](https://github.com/BYK/opencode-lore/pull/21)

## 0.4.3

### Bug Fixes 🐛

- (gradient) Apply safety multiplier to uncalibrated layer-0 check by @BYK in [452c013a](https://github.com/BYK/opencode-lore/commit/452c013a492c097003142ad0ec34ce09889d0ced)

## 0.4.2

### Bug Fixes 🐛

- (agents-file) Self-heal duplicate lore sections and support old marker variants by @BYK in [aa83eb00](https://github.com/BYK/opencode-lore/commit/aa83eb003a682dff8a4e7415abbb5a07e2f9f189)

### Internal Changes 🔧

- (agents-file) Clean up fixed-UUID entries in afterAll to prevent ltm test collisions by @BYK in [f5c43486](https://github.com/BYK/opencode-lore/commit/f5c4348634b05a25458a1f1b9b135c2e7f5a383b)

## 0.4.1

### Bug Fixes 🐛

- (agents-file) Always commit agents file, soften auto-maintained wording by @BYK in [e5918a65](https://github.com/BYK/opencode-lore/commit/e5918a65da36ec31c7f307786a1561c8e1c296ab)
- (gradient) Use chars/3 estimation and fix calibration to use compressed window estimate by @BYK in [e2287a20](https://github.com/BYK/opencode-lore/commit/e2287a2073ff51691cecf615d4c65b02faac612b)

## 0.4.0

### New Features ✨

- (ltm) Tighten entry budget, add consolidation pass by @BYK in [74728df1](https://github.com/BYK/opencode-lore/commit/74728df154a47529ceee418ddeaf7baf0e5aa38a)

### Internal Changes 🔧

- Use Craft composite action with app token for release by @BYK in [48b7a858](https://github.com/BYK/opencode-lore/commit/48b7a858679ebddc84f6a3b90f3c75dcb0326b39)
- Use Craft reusable workflow for release by @BYK in [2ed8af27](https://github.com/BYK/opencode-lore/commit/2ed8af27ff89f16b76fecc5d5ac9886ec81956d2)

## 0.3.9

### Internal Changes 🔧

- Use Craft github artifact provider and oidc: true for npm target by @BYK in [d0dc35aa](https://github.com/BYK/opencode-lore/commit/d0dc35aacbff2981f994e27932da3a3e9e2c6f3f)
- Use Craft npm target with OIDC, pack tarball on release branches by @BYK in [68e650a4](https://github.com/BYK/opencode-lore/commit/68e650a4f919d856e62c39d52e62135ad92fa643)

## 0.3.7

- No documented changes.

## 0.3.6

### Bug Fixes 🐛

- (ci) Keep registry-url but strip \_authToken for OIDC auto-detection by @BYK in [15085e37](https://github.com/BYK/opencode-lore/commit/15085e37ed2980ca204b1be6050b051125fa6fcc)

## 0.3.5

### Bug Fixes 🐛

- (ci) Remove registry-url from setup-node to let npm use native OIDC by @BYK in [9802054b](https://github.com/BYK/opencode-lore/commit/9802054b92f1f69a67969f25d50bf8bc58389bee)

## 0.3.4

### Bug Fixes 🐛

- (ci) Upgrade npm for OIDC trusted publishing (requires >=11.5.1) by @BYK in [42b2935b](https://github.com/BYK/opencode-lore/commit/42b2935b2da1d57b1c3988c6463e75983d55a9bf)

## 0.3.3

### Bug Fixes 🐛

#### Ci

- Use vars.APP_ID and github.token for failure steps by @BYK in [a6e1adae](https://github.com/BYK/opencode-lore/commit/a6e1adaef2285eaf062c5225c0f345aaf9c8a4d7)
- Stage CHANGELOG.md in preReleaseCommand and use PAT for tag creation by @BYK in [7461fa63](https://github.com/BYK/opencode-lore/commit/7461fa635247d06b321a7ed45ecf1b0468a004be)
- Checkout release branch for CHANGELOG.md and set git identity by @BYK in [30a318e6](https://github.com/BYK/opencode-lore/commit/30a318e68e121635f4ccea7b18ad311c94027240)
- Set artifactProvider to none for github-only target by @BYK in [87dafec1](https://github.com/BYK/opencode-lore/commit/87dafec1b4065ab0a4c81afd585d1d59742bfd1d)
- Wrap preReleaseCommand in bash for env var expansion by @BYK in [2dce6728](https://github.com/BYK/opencode-lore/commit/2dce67289e6705ee59da31edcee4485df0da9633)
- Revert to github-only Craft target with separate npm OIDC publish by @BYK in [a5646f0a](https://github.com/BYK/opencode-lore/commit/a5646f0abf25cd39d3be87153b4ff99c35bae2ef)
- Remove registry-url from setup-node to avoid OIDC interference by @BYK in [4f04d3c7](https://github.com/BYK/opencode-lore/commit/4f04d3c7a62191288c3b26f90963297c0cd491f6)
- Upgrade npm for OIDC trusted publishing (requires >=11.5.1) by @BYK in [ceeccf00](https://github.com/BYK/opencode-lore/commit/ceeccf00d944bc89f8b324bb22148e5eb62793b9)
- Configure artifact provider for npm tarball lookup by @BYK in [697a98cf](https://github.com/BYK/opencode-lore/commit/697a98cf73316ca1e0643df18b3abf3e5636616f)
- Add actions:read permission for artifact download by @BYK in [cc05628c](https://github.com/BYK/opencode-lore/commit/cc05628c504bf6de3ecf2c7938c71dc386c98638)
- Resolve version from Craft output instead of branch name by @BYK in [bd53d77c](https://github.com/BYK/opencode-lore/commit/bd53d77cdaa2e40e852a418a35b23fe6f22be169)
- Add production environment to release job for PAT access by @BYK in [f3a6ebd5](https://github.com/BYK/opencode-lore/commit/f3a6ebd50e28c377d407cfc4d00137cf6ac0a1e7)
- Use PAT for release branch push to trigger CI by @BYK in [b171b8c2](https://github.com/BYK/opencode-lore/commit/b171b8c225a884ea7cac56c36d660b056b8feaa6)
- Use composite action for release to get issues:write permission by @BYK in [8da99bc0](https://github.com/BYK/opencode-lore/commit/8da99bc0036f15d227931f624b27a15d6bcaa58b)
- Use Craft CLI directly instead of composite action by @BYK in [58dc4e87](https://github.com/BYK/opencode-lore/commit/58dc4e874dbca3b0772d5913d1b013e7f2425513)

### Documentation 📚

- Add conventional commits convention to AGENTS.md by @BYK in [3dec8769](https://github.com/BYK/opencode-lore/commit/3dec876938abeb5b65d846ebd428335dc0d7463d)

### Internal Changes 🔧

- Use GitHub App token for release and publish workflows by @BYK in [3b8d87d7](https://github.com/BYK/opencode-lore/commit/3b8d87d7b66209e513b9f26ba279968f93b96b10)
- Upload npm tarball artifact on release branches by @BYK in [9d700397](https://github.com/BYK/opencode-lore/commit/9d700397c22f57b533f4ee44e23b7f16134a14c5)
- Run CI on release branches for Craft status checks by @BYK in [067d1205](https://github.com/BYK/opencode-lore/commit/067d12052ec5689a3cac7807c2336544fc4055a5)
- Use Craft npm target with OIDC trusted publishing by @BYK in [20c1be34](https://github.com/BYK/opencode-lore/commit/20c1be34864604257794df9a7c9cc1f4e27eb992)
- Upgrade to Craft 2.22 reusable workflow with accepted-label publish flow by @BYK in [7261873b](https://github.com/BYK/opencode-lore/commit/7261873b079efa4e3dfa9b56aa8f28d31a8740af)
- Add Craft release workflow with npm trusted publishing by @BYK in [6b0ad08b](https://github.com/BYK/opencode-lore/commit/6b0ad08b67e5fc4deb6065a09136498e2c01a469)

