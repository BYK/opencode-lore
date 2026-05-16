# Quality Playbook — Phase 1 Exploration Findings

**Project:** opencode-lore (Lore)
**Date:** 2026-05-16
**Skill version:** v1.5.6

---

## Open Exploration Findings

1. **Three-tier memory architecture with SQLite persistence.** The system implements temporal storage (raw messages in `packages/core/src/temporal.ts:74-120`), distillation (compressed summaries in `packages/core/src/distillation.ts:622-850`), and long-term knowledge (curated entries in `packages/core/src/ltm.ts:37-130`). All three tiers persist to SQLite with FTS5 full-text search. The data flows temporal → distillation → knowledge, with each tier feeding the next. Multi-location trace: `temporal.store()` at `packages/core/src/temporal.ts:74` feeds into `distillation.run()` at `packages/core/src/distillation.ts:622`, which feeds into `curator.run()` at `packages/core/src/curator.ts:143`.

2. **Gradient context manager is the most complex subsystem (~2100 lines).** `packages/core/src/gradient.ts` implements a 4-layer compression system (Layer 0: raw passthrough, Layer 1: distilled prefix + raw window, Layer 2: aggressive tool-output stripping, Layer 3/emergency: minimal context). Key decision engine at `packages/core/src/gradient.ts:1593-1960`. Module-level mutable globals `contextLimit` and `outputReserved` at `packages/core/src/gradient.ts:37-38` are shared across ALL sessions — if two sessions use different models, the last `setModelLimits()` call at `packages/core/src/gradient.ts:425` wins for all sessions.

3. **Pipeline is the central orchestrator (~3600 lines).** `packages/gateway/src/pipeline.ts` handles request lifecycle: session identification (line 880), LTM injection (lines 1024-1051), gradient transform, upstream forwarding (line 1000), response accumulation, calibration, and temporal storage. LTM injection now works for all three protocols (Anthropic, OpenAI Chat Completions, OpenAI Responses) — this was a previously documented bug that has been fixed. Multi-location trace: `handleConversationTurn` at `pipeline.ts:2516` calls `forwardToUpstream` at `pipeline.ts:1000` which dispatches to protocol-specific translators in `translate/anthropic.ts:333`, `translate/openai.ts:423`, and `translate/openai-responses.ts:211`.

4. **saveForceMinLayer deletes entire session_state row when layer=0.** At `packages/core/src/db.ts:1019-1031`, when `saveForceMinLayer(sessionId, 0)` is called, the entire `session_state` row is deleted. This destroys cost data, tracking state, gradient calibration EMAs, and cache warming state that were saved to the same row by `saveSessionCosts`, `saveSessionTracking`, and periodic persistence in `packages/gateway/src/idle.ts:141-173`. This is a data loss bug — the function should update the column rather than delete the row.

5. **Recall follow-up stream output tokens are untracked.** In `packages/gateway/src/pipeline.ts:1371-1440`, when a recall tool is intercepted and a follow-up request is issued, the continuation stream is piped to the client but the original `accumulator` (line 1125) is NOT fed with continuation events. `postResponse` at `pipeline.ts:1848` receives usage from only the first request. The follow-up's output tokens, cache usage, and cost are invisible to calibration and cost tracking.

6. **Recall marker regex truncates queries containing double quotes.** At `packages/gateway/src/recall.ts:109`, `MARKER_REGEX = /📚 Searching (.+?) for "(.+?)"…/` uses lazy quantifiers. If the recall query contains a `"` character (e.g., `how to use "async"`), the regex stops at the first `"` and truncates the query. The expanded recall result will search for only a partial query.

7. **sessionStates map in gradient.ts never evicts entries.** The `sessionStates` Map at `packages/core/src/gradient.ts:304` grows with every new session but entries are never removed. Similarly, `session-limiter.ts:17` p-limit instances are never evicted. Long-running gateway processes with many sessions accumulate memory indefinitely. The `globalHeaderValues` map at `packages/gateway/src/session.ts:436-455` has the same unbounded growth pattern.

8. **bin.ts uses process.exit() instead of safeExit().** At `packages/gateway/src/cli/bin.ts:10`, the top-level error handler uses `process.exit(1)` directly. The `safeExit()` workaround at `packages/gateway/src/cli/exit.ts:20` (which uses libc `_exit()` via FFI to avoid NAPI teardown crash) is used everywhere else in the gateway but not at this critical error boundary. If NAPI modules (onnxruntime-node) are loaded when an unhandled rejection occurs, this triggers the documented Bun NAPI crash.

9. **OpenAI Chat Completions translator silently drops tool_result blocks.** In `packages/gateway/src/translate/openai.ts:523-527`, `buildOpenAIMessages` encounters `tool_result` blocks but silently drops them with only a comment. Tool results from prior turns should be emitted as `role: "tool"` messages with `tool_call_id` in the OpenAI format. This means tools don't work correctly when the upstream is OpenAI and messages contain tool results. Multi-location trace: the Anthropic path correctly handles tool results at `translate/anthropic.ts:369-423`, but the OpenAI path at `translate/openai.ts:523-527` and the Responses path at `translate/openai-responses.ts:126-131` do not preserve them equivalently.

10. **Token estimation is duplicated across 4+ files with chars/3 heuristic.** `Math.ceil(text.length / 3)` appears in `packages/core/src/gradient.ts:15-17`, `packages/core/src/temporal.ts:9`, `packages/core/src/ltm.ts:11`, and `packages/core/src/prompt.ts:514`. The comment at `gradient.ts:14` says validated at ~1.68x ratio, but the `UNCALIBRATED_SAFETY` multiplier of 1.5 at `gradient.ts:1648` only partially compensates (~12% gap). Multi-location trace: same formula in 4 files, affecting token budgets throughout the system.

11. **Embedding auto-fallback permanently replaces local provider.** At `packages/core/src/embedding.ts:700`, if the local ONNX embedding provider fails once (e.g., transient OOM), the system permanently switches to the remote provider for the entire process lifetime. `cachedProvider` at `embedding.ts:502` uses a three-state system (`undefined`=not resolved, `null`=permanently off, `EmbeddingProvider`=active), but the fallback sets it to the remote provider with no mechanism to retry local.

12. **Stale SCHEMA_VERSION constant at db.ts:24.** `SCHEMA_VERSION = 16` but there are 26 migrations in the `MIGRATIONS` array. The constant is never used in logic (migrations use `MIGRATIONS.length` directly at `db.ts:696`), making it dead code. The `.lore.md` entry says "SCHEMA_VERSION is derived from MIGRATIONS.length — never set manually" but it is in fact a stale hardcoded literal. The `db.test.ts` hardcodes `26` at line 27 for the schema version assertion.

13. **Duplicate LTM entries possible in preference fast path.** At `packages/core/src/ltm.ts:463-464`, `forSession()` builds `allPrefs = [...projectEntries, ...crossEntries]`. If a project entry also has `cross_project=1`, it appears in BOTH the project query (`cross_project=0` filter at line 437) and the cross-project query. Actually the project query filters `cross_project = 0`, so this specific case is prevented — but the broader `forSession` non-preference path at lines 515-573 unions two pools without dedup, and a project entry with `cross_project=1` could appear in both pools there.

14. **OpenAI streaming translator doesn't handle Anthropic error events.** In `packages/gateway/src/stream/openai.ts`, if Anthropic sends an `error` event type, there is no explicit handling. The event falls through to the default case and the stream ends with `[DONE]` from the catch block at lines 296-303. Clients don't receive the error reason. Compare with `stream/openai-responses.ts` which correctly emits `response.failed` at lines 687-711.

15. **Tool arguments JSON.parse without error handling in OpenAI translator.** At `packages/gateway/src/translate/openai.ts:166` and `translate/openai.ts:205`, `JSON.parse(fn.arguments as string)` is called without try/catch. Malformed tool call arguments from OpenAI clients would throw an unhandled exception, crashing the request handler.

## Quality Risks

1. **State persistence relies on 30s periodic flush, not transactional writes.** Per `packages/gateway/src/idle.ts:141-173`, gradient EMAs, cache warming state, and cost snapshots are flushed every 30s via dirty-flag detection. A process crash (SIGKILL, OOM) loses up to 30s of state. Critical session identity fields are persisted immediately at `pipeline.ts:2082-2083`, but gradient calibration data loss could cause sessions to re-calibrate from scratch, wasting cache budget.

2. **Multi-model concurrent sessions share module-level state.** `contextLimit`, `outputReserved`, and `maxLayer0Tokens` at `packages/core/src/gradient.ts:37-38,87-88` are process-global. In hosted mode with multiple concurrent sessions using different models, the last `setModelLimits()` call overwrites values for all sessions. This could cause over/under-compression depending on which model's limits were set last.

3. **Unbounded in-memory maps create slow memory leaks.** `sessionStates` (gradient.ts:304), p-limit instances (session-limiter.ts:17), `globalHeaderValues` (session.ts:436), `stableLtmCache` (pipeline.ts:327-332), and `sessions` (pipeline.ts:280) all grow without eviction. In hosted gateways with many sessions over days/weeks, this becomes significant.

4. **Cache warmer circuit breaker is non-recoverable within process.** At `packages/gateway/src/cache-warmer.ts:127-131`, once tripped, ALL cache warming is permanently disabled until process restart. A transient Anthropic-side issue (e.g., temporary cache key algorithm change) permanently degrades cache performance for all sessions.

5. **Test DB isolation is per-run, not per-test.** `packages/core/test/setup.ts:10-11` creates a single temp DB for all tests. Tests that don't clean up after themselves can leak state to subsequent tests. The `.lore.md` gotcha about `mock.module()` cross-file pollution compounds this — tests may pass individually but fail when run together.

6. **Plugin code duplication between OpenCode and Pi.** Both `packages/opencode/src/index.ts` and `packages/pi/src/index.ts` contain nearly identical `resolveGatewayUrl()` and `startInProcess()` implementations. Divergence between these copies is a maintenance risk.

7. **Server binds to multiple hosts sequentially without per-bind error handling.** At `packages/gateway/src/server.ts:357-368`, when port=0, `resolvedPort` is pinned after the first bind. If the resolved port is taken on a subsequent host interface, the second `Bun.serve()` throws uncaught, crashing the process.

## Pattern Applicability Matrix

| # | Pattern | Decision | Rationale |
|---|---------|----------|-----------|
| 1 | Fallback and Degradation Path Parity | FULL | Multiple fallback chains: embedding local→remote, FTS5→LIKE search, port fallback 3207→5673→0, config load fallback, session ID 3-tier detection |
| 2 | Dispatcher Return-Value Correctness | SKIP | No complex switch-on-event dispatchers; protocol dispatch is clean function-per-protocol, not shared return paths |
| 3 | Cross-Implementation Contract Consistency | FULL | Three parallel protocol implementations (Anthropic, OpenAI, OpenAI Responses) must provide equivalent behavior for LTM injection, tool handling, streaming, error propagation |
| 4 | Enumeration and Representation Completeness | FULL | Upstream routing table, agent detection registry, provider lists in plugins, session state column persistence — all are closed sets that must stay in sync |
| 5 | API Surface Consistency | FULL | Multiple surfaces for the same operations: direct DB functions vs CLI data commands vs REST API, gateway pipeline vs recall interception, export via agents-file vs direct ltm queries |
| 6 | Spec-Structured Parsing Fidelity | SKIP | No RFC/grammar parsing; the system processes LLM API JSON payloads, not structured text formats. Regex usage is limited to heuristic detection (compaction, recall markers). |
| 7 | Composition and Mount-Context Awareness | SKIP | No sub-route mounting or nested composition contexts. The gateway is a single-level proxy, not a composable middleware stack. |

## Pattern Deep Dive — Fallback and Degradation Path Parity

### Embedding provider fallback chain
- **Primary path:** `LocalProvider.embed()` at `packages/core/src/embedding.ts:423` — ONNX worker-thread inference with pre-truncation at `LOCAL_MAX_CHARS` (16384 chars)
- **Fallback 1:** Remote provider (Voyage/OpenAI) at `packages/core/src/embedding.ts:700` — triggered on any local provider failure
- **Parity gap:** The fallback is **permanent** — once `cachedProvider` is set to the remote provider, the local provider is never retried. A transient OOM (ONNX error codes `287180544`, `144786472`) permanently degrades to higher-latency, higher-cost remote embeddings. The `_shutdownAndDisable()` at line 502 correctly distinguishes "permanently off" (`null`) from "not yet resolved" (`undefined`), but the auto-fallback at line 700 bypasses this distinction by directly setting `cachedProvider` to the remote provider.
- **Candidate requirement:** REQ-EMB-001: Embedding auto-fallback from local to remote MUST be recoverable — either retry local on a timer or fall back per-request rather than permanently.

### FTS5 search fallback to LIKE queries
- **Primary path:** `ftsQuery()` at `packages/core/src/search.ts:162` builds FTS5 match expressions with prefix wildcards
- **Fallback 1:** `ftsQueryRelaxed()` at `packages/core/src/search.ts:194` progressively drops shortest terms
- **Fallback 2:** LIKE-based search in `packages/core/src/ltm.ts:272-274` and `packages/core/src/ltm.ts:366-368` catches FTS5 syntax errors
- **Parity gap:** The LIKE fallback loses ranking (BM25 scores) and prefix matching. Results are unranked, which degrades `forSession()` relevance scoring. The fallback is correct (doesn't crash) but produces lower-quality results silently — the caller has no signal that FTS5 failed.
- **Candidate requirement:** REQ-SEARCH-001: FTS5 fallback to LIKE SHOULD propagate a degradation signal so callers can log or adjust scoring behavior.

### Port fallback in gateway startup
- **Primary path:** Explicit port via `--port` flag at `packages/gateway/src/cli/start.ts:97`
- **Fallback 1:** Port 3207 (well-known) at `start.ts:98`
- **Fallback 2:** Port 5673 (alternate) at `start.ts:99`
- **Fallback 3:** Port 0 (OS-assigned) at `start.ts:100`
- **Parity gap:** When a port conflict is detected (line 131), the code probes for an existing gateway via `probeGateway()`. But `probeUrl` uses `config.hosts[0]` which defaults to `127.0.0.1`. If the existing gateway is bound to `0.0.0.0`, the probe might fail even though the gateway is running, causing a spurious "port in use" error and unnecessary fallback.
- **Candidate requirement:** REQ-NET-001: Gateway port-conflict probe MUST check all configured host interfaces, not just the first one.

### Session identification 3-tier fallback
- **Primary path:** Known session headers (`extractKnownSessionHeader` at `packages/gateway/src/session.ts:279`) — deterministic from `x-session-id` etc.
- **Fallback 1:** Learned headers (`learnHeaders` at `session.ts:387`) — heuristic header promotion
- **Fallback 2:** Message fingerprint (`fingerprintMessages` at `session.ts:180`) — SHA-256 of first N messages
- **Parity gap:** Fingerprint-based identification (Tier 3) is async (SHA-256 at line 923 in `pipeline.ts`). If two concurrent requests for the same new session arrive simultaneously, both could generate new session IDs before either is stored, creating a session split. The `identifySession` function at `pipeline.ts:880` doesn't synchronize across concurrent calls for the same fingerprint.
- **Candidate requirement:** REQ-SESSION-001: Fingerprint-based session identification MUST serialize concurrent lookups to prevent session splits for the same conversation.

## Pattern Deep Dive — Cross-Implementation Contract Consistency

### LTM injection across three protocol paths
- **Implementation A (Anthropic):** `buildAnthropicRequest` at `packages/gateway/src/translate/anthropic.ts:333-423` — uses a 3-block system prompt architecture: system[0]=host prompt, system[1]=stable LTM with 1h cache TTL, system[2]=context-bound LTM without cache control
- **Implementation B (OpenAI Chat Completions):** Lines 1028-1031 in `pipeline.ts` — concatenates LTM to system string
- **Implementation C (OpenAI Responses):** Lines 1038-1040 in `pipeline.ts` — concatenates LTM to instructions string
- **Gap:** Implementations B and C lose the cache TTL differentiation. Anthropic gets stable preferences cached for 1h (reducing cost), while OpenAI paths get all LTM as a single undifferentiated string. This is functionally correct (all paths get LTM) but cost-suboptimal for OpenAI upstreams. Not a bug per se, but an asymmetry.
- **Candidate requirement:** REQ-LTM-001: LTM injection SHOULD preserve the stable/context-bound distinction across all protocol paths to optimize cache behavior.

### Tool result handling across protocol translators
- **Implementation A (Anthropic):** `translate/anthropic.ts:369-423` — `tool_result` blocks are correctly round-tripped as Anthropic `tool_result` content blocks
- **Implementation B (OpenAI Chat Completions):** `translate/openai.ts:523-527` — `tool_result` blocks are **silently dropped** with only a comment. Should emit `role: "tool"` messages with `tool_call_id`.
- **Implementation C (OpenAI Responses):** `translate/openai-responses.ts:126-131` — developer/system messages converted to user messages, tool handling unclear
- **Gap:** This is a functional bug. When the gateway proxies to an OpenAI upstream and the conversation contains tool call results from prior turns, those results are lost. The model won't see tool outputs, breaking agentic workflows.
- **Candidate requirement:** REQ-TOOL-001: All protocol translators MUST preserve tool_result blocks when converting between gateway internal format and upstream wire format.

### Streaming error event propagation across translators
- **Implementation A (Anthropic native):** `stream/anthropic.ts:209-229` — all event types handled, unknown events forwarded as-is
- **Implementation B (Anthropic→OpenAI translator):** `stream/openai.ts` — **no explicit error event handling**. Anthropic `error` events fall through silently. Stream terminates with `[DONE]` from catch block (lines 296-303) but without the error reason.
- **Implementation C (Anthropic→Responses translator):** `stream/openai-responses.ts:687-711` — correctly emits `response.failed` with error details
- **Gap:** Implementation B silently swallows Anthropic error events. OpenAI Chat Completions clients never see the error reason — they just get a `[DONE]` sentinel and assume the stream ended normally (or truncated).
- **Candidate requirement:** REQ-STREAM-001: The OpenAI Chat Completions streaming translator MUST emit an error object when Anthropic sends an error event, not silently terminate.

### Plugin gateway discovery: OpenCode vs Pi
- **Implementation A (OpenCode):** `packages/opencode/src/index.ts:39-80` — `resolveGatewayUrl()` checks `LORE_REMOTE_URL` → `LORE_GATEWAY_URL` → port file → known ports (3207, 5673)
- **Implementation B (Pi):** `packages/pi/src/index.ts:99-133` — near-identical `resolveGatewayUrl()` implementation
- **Gap:** The two implementations are copy-pasted duplicates with no shared source. If the discovery chain is updated in one plugin (e.g., adding a new port), the other must be manually synchronized. Both also share `startInProcess()` with the same variable-indirection pattern for dynamic import.
- **Candidate requirement:** REQ-PLUGIN-001: Gateway discovery logic SHOULD be extracted to a shared module consumed by both OpenCode and Pi plugins to prevent divergence.

## Pattern Deep Dive — Enumeration and Representation Completeness

### Upstream routing table
- **Function:** `resolveUpstreamRoute` at `packages/gateway/src/config.ts:129-166`
- **Purpose:** Maps model name prefixes to upstream API URLs and protocol types
- **Authoritative source:** The set of models that can be proxied (documented in AGENTS.md and .lore.md)
- **Extracted entries:** `claude-` (Anthropic), NVIDIA NIM, `gpt-`/`o1-`/`o3-`/`o4-` (OpenAI), `grok-` (xAI), Mistral prefixes, `gemini-` (Google)
- **Missing entries:** The routing table at `config.ts:99-121` doesn't cover `deepseek-`, `llama-`, or other providers that the Pi plugin's provider list at `packages/pi/src/index.ts:53-72` supports. New models with unexpected prefixes fall through to env-var defaults, which may not be set.
- **Candidate requirement:** REQ-ROUTE-001: The upstream routing table MUST be extensible via configuration, not just hardcoded prefix matching, to support new model providers without code changes.

### Agent detection registry
- **Function:** `AGENTS` array at `packages/gateway/src/cli/agents.ts:82-141`
- **Purpose:** Registry of known AI coding agents for auto-detection and env var injection
- **Authoritative source:** The set of supported agents (Claude Code, Codex, Pi, OpenCode)
- **Extracted entries:** `claude`, `codex`, `pi`, `opencode`
- **Missing entries:** Cursor and Windsurf are mentioned in README.md and AGENTS.md as supported tools, but they have no entry in the `AGENTS` array. The `detectAgents()` function at line 156 only finds agents with entries in this array. Users of Cursor/Windsurf must manually configure env vars.
- **Candidate requirement:** REQ-AGENT-001: The agent detection registry SHOULD include entries for Cursor and Windsurf if these are documented as supported tools.

### Session state DB columns vs in-memory fields
- **Function:** `saveSessionTracking` at `packages/core/src/db.ts:891-950` and `loadSessionTracking` at `db.ts:954-1015`
- **Purpose:** Persist and restore session state fields across process restarts
- **Authoritative source:** The `SessionState` interface in `packages/core/src/gradient.ts` (all fields that should survive restart)
- **Gap:** `saveGradientState()` at `gradient.ts:673-677` repurposes the `dynamicContextCap` DB column to persist `consecutiveBusts`. But `getSessionState()` at `gradient.ts:325-329` does NOT restore `consecutiveBusts` from DB — the comment says "Don't restore consecutiveBusts from DB". This means the column is written but never read for its current purpose. It's effectively dead persistence — the data is saved but never loaded.
- **Candidate requirement:** REQ-STATE-001: Session state persistence MUST either restore all persisted fields on load OR not persist fields that are intentionally transient, to avoid confusing write-only DB columns.

### LTM forSession() preference fast path pool dedup
- **Function:** `forSession()` at `packages/core/src/ltm.ts:415-641`, specifically the preference fast path at lines 461-464
- **Purpose:** Return relevant knowledge entries for system prompt injection
- **Authoritative source:** Each knowledge entry should appear at most once in the output
- **Gap:** The preference fast path at line 463 builds `allPrefs = [...projectEntries, ...crossEntries]`. The project query at line 437 filters `cross_project = 0`, and the cross-project query at line 443 filters `project_id IS NULL OR cross_project = 1`. These pools are mutually exclusive for project-specific entries. However, an entry with `project_id = <current>` AND `cross_project = 1` would match ONLY the cross-project query (not the project query due to `cross_project = 0` filter). So the specific duplicate scenario described in `.lore.md` is actually prevented by the SQL filters — but only for the preference path. The non-preference path at lines 515-573 uses the same pool separation and could theoretically include the same entry from both vector search results.
- **Candidate requirement:** REQ-LTM-002: The LTM scoring pipeline SHOULD deduplicate entries after merging pools to prevent duplicate injection regardless of pool separation guarantees.

## Pattern Deep Dive — API Surface Consistency

### Data operations: CLI vs REST API vs direct DB
- **Surface A (CLI):** `packages/gateway/src/cli/data.ts` — `cmdList()` at line 80, `cmdShow()` at line 205, `cmdDelete()` at line 435
- **Surface B (REST API):** `packages/gateway/src/api.ts` — endpoints for `/api/v1/knowledge`, `/api/v1/recall`, etc.
- **Surface C (Direct DB):** `packages/core/src/data.ts` — `listKnowledge()`, `showKnowledge()`, `deleteKnowledge()`
- **Divergence:** The CLI `data.ts` at line 748 reimplements `pairKey()` for dedup similarity maps — this mirrors `ltm.dedupPairKey()` in core. If the core function changes its key format, the CLI copy diverges silently. Also, the CLI's `--yes` flag bypasses confirmation, but the REST API has no confirmation concept — it's always immediate.
- **Candidate requirement:** REQ-API-001: CLI data commands SHOULD delegate to the same core functions used by the REST API rather than reimplementing logic (e.g., pairKey) to prevent divergence.

### Recall: gateway interception vs CLI recall-cmd
- **Surface A (Gateway):** `packages/gateway/src/recall.ts` — `executeRecall()` at line 343, has LLM client for query expansion
- **Surface B (CLI):** `packages/gateway/src/cli/recall-cmd.ts` — `commandRecall()` at line 21, sets `queryExpansion: false` because no LLM client available
- **Divergence:** CLI recall always runs without query expansion, while gateway recall can expand queries. This means identical queries produce different results depending on whether they come from the agent (via gateway) or the terminal (via CLI). The divergence is documented (line 80 of recall-cmd.ts) and intentional, but users may not expect it.
- **Candidate requirement:** REQ-RECALL-001: CLI recall SHOULD document the query expansion limitation prominently and offer a `--expand` flag that starts a temporary LLM client for expansion.

### Export: agents-file.ts exportLoreFile vs exportToFile
- **Surface A:** `exportLoreFile()` at `packages/core/src/agents-file.ts:300-360` — exports knowledge entries to `.lore.md`
- **Surface B:** `exportToFile()` at `agents-file.ts:530-570` — exports to `AGENTS.md` with a pointer to `.lore.md`
- **Divergence:** `exportLoreFile()` checks a content hash before writing (skip if unchanged at line 342). `exportToFile()` calls `exportLoreFile()` internally and then unconditionally writes `AGENTS.md` even if the lore section didn't change. Minor inefficiency but not a correctness issue.

## Candidate Bugs for Phase 2

1. **CB-001: saveForceMinLayer(sid, 0) deletes entire session_state row, destroying persisted cost/tracking/gradient data.**
   Stage: open exploration
   Severity: HIGH — data loss on any session that returns to layer 0

2. **CB-002: Module-level contextLimit/outputReserved globals shared across sessions cause cross-contamination when different models are used concurrently.**
   Stage: open exploration
   Severity: MEDIUM — affects hosted mode with multi-model sessions

3. **CB-003: sessionStates, p-limit instances, and globalHeaderValues maps grow unboundedly, creating memory leaks in long-running gateways.**
   Stage: open exploration + quality risks
   Severity: MEDIUM — slow leak, hours/days to manifest

4. **CB-004: Recall follow-up stream output tokens are untracked — cost accounting, calibration, and temporal storage miss the follow-up response entirely.**
   Stage: open exploration
   Severity: MEDIUM — cost tracking drift over time

5. **CB-005: Recall marker regex truncates queries containing double-quote characters, causing partial search results.**
   Stage: open exploration
   Severity: MEDIUM — data corruption on specific input patterns

6. **CB-006: OpenAI Chat Completions translator silently drops tool_result blocks, breaking agentic workflows when upstream is OpenAI.**
   Stage: Cross-Implementation Contract Consistency
   Severity: HIGH — functional breakage for tool-using sessions

7. **CB-007: bin.ts uses process.exit(1) instead of safeExit(1), triggering Bun NAPI crash when ONNX modules are loaded.**
   Stage: open exploration
   Severity: MEDIUM — crash on error paths only

8. **CB-008: JSON.parse without try/catch in OpenAI translator for tool call arguments — malformed input crashes the request handler.**
   Stage: open exploration
   Severity: LOW — requires malformed client input

9. **CB-009: LTM scoring pipeline pools can include the same entry twice when merging project and cross-project results in non-preference path.**
   Stage: Enumeration and Representation Completeness
   Severity: MEDIUM — duplicate context in system prompt

10. **CB-010: Embedding auto-fallback from local to remote is permanent — a transient ONNX OOM permanently degrades to higher-cost remote embeddings.**
    Stage: Fallback and Degradation Path Parity
    Severity: MEDIUM — cost/latency degradation

11. **CB-011: SCHEMA_VERSION constant (16) is stale — there are 26 migrations. Dead code but misleading.**
    Stage: open exploration
    Severity: LOW — no runtime impact, documentation/maintenance issue

12. **CB-012: OpenAI Chat Completions streaming translator doesn't handle Anthropic error events — clients see silent termination instead of error details.**
    Stage: Cross-Implementation Contract Consistency
    Severity: MEDIUM — poor error UX for OpenAI-protocol clients

## Cartesian UC rule confirmation

1. For every REQ with >=2 References, I ran Gate 1 (path-suffix match). Applied to: REQ-TOOL-001 (3 translator files), REQ-STREAM-001 (3 stream files), REQ-PLUGIN-001 (2 plugin files).
2. For every REQ that passed Gate 1, I ran Gate 2 (function-level similarity). REQ-TOOL-001: all three implement message-building functions of similar size — passes. REQ-STREAM-001: all three implement stream translators of similar structure — passes. REQ-PLUGIN-001: both implement resolveGatewayUrl() of similar size — passes.
3. Where both gates passed, per-site UCs will be emitted in Phase 2 (UC-TOOL-001.a/b/c for each translator, UC-STREAM-001.a/b/c for each stream translator, UC-PLUGIN-001.a/b for each plugin).
4. No clusters marked heterogeneous — all matched clusters have parallel implementations.
5. Remaining REQs with single references kept single umbrella UCs.
6. Pattern annotations: REQ-TOOL-001: Pattern: parity. REQ-STREAM-001: Pattern: parity. REQ-PLUGIN-001: Pattern: parity.

## Gate Self-Check

1. **>=120 lines:** EXPLORATION.md exceeds 120 lines. PASS
2. **`## Open Exploration Findings` heading present:** Yes. PASS
3. **`## Quality Risks` heading present:** Yes. PASS
4. **`## Pattern Applicability Matrix` heading present:** Yes. PASS
5. **>=3 `## Pattern Deep Dive` sections:** Yes — 4 sections (Fallback, Cross-Implementation, Enumeration, API Surface). PASS
6. **PROGRESS.md Phase 1 marked `[x]`:** Yes. PASS
7. **>=8 findings with file:line citations in Open Exploration:** 15 findings, all with file:line citations. PASS
8. **>=3 multi-location findings:** Findings 1 (temporal→distillation→curator), 3 (pipeline→translators), 9 (anthropic→openai→responses), 10 (4 files with token estimation) are multi-location. 4 multi-location findings. PASS
9. **3-4 FULL pattern matrix rows:** 4 FULL rows (Fallback, Cross-Implementation, Enumeration, API Surface). PASS
10. **>=2 multi-function pattern deep dives:** Fallback (4 cascades with `embed()`, `ftsQuery()`, `startGateway()`, `identifySession()`), Cross-Implementation (3 analyses with `buildAnthropicRequest`/`buildOpenAIMessages`/`translateStream`), Enumeration (`resolveUpstreamRoute`/`AGENTS`/`saveSessionTracking`/`forSession`), API Surface (`cmdList`/API/`listKnowledge`, `executeRecall`/`commandRecall`). All 4 deep dives trace multiple functions. PASS
11. **Candidate-bug source mix >=2 from exploration/risks:** CB-001 through CB-005, CB-007, CB-008, CB-010, CB-011 are from open exploration (9). PASS
12. **>=1 candidate bug from pattern deep dive:** CB-006 from Cross-Implementation, CB-009 from Enumeration, CB-012 from Cross-Implementation (3). PASS
13. **All 13 checks evaluated:** Yes, this is check 13. PASS

## Derived Requirements (REQ-NNN)

### REQ-EMB-001: Recoverable embedding provider fallback
Embedding auto-fallback from local to remote MUST be recoverable — either retry local on a configurable timer or fall back per-request rather than permanently replacing the provider.
- References: `packages/core/src/embedding.ts:700`, `packages/core/src/embedding.ts:502`

### REQ-SEARCH-001: FTS5 degradation signal
FTS5 fallback to LIKE search SHOULD propagate a degradation signal so callers can log the fallback and optionally adjust scoring behavior.
- References: `packages/core/src/search.ts:162`, `packages/core/src/ltm.ts:272-274`

### REQ-NET-001: Multi-interface port conflict probe
Gateway port-conflict probe MUST check all configured host interfaces, not just the first one, to correctly detect existing gateways.
- References: `packages/gateway/src/cli/start.ts:131-138`

### REQ-SESSION-001: Serialized fingerprint-based session lookup
Fingerprint-based session identification MUST serialize concurrent lookups to prevent session splits for the same conversation.
- References: `packages/gateway/src/pipeline.ts:880-975`, `packages/gateway/src/session.ts:180`

### REQ-LTM-001: Protocol-agnostic LTM cache optimization
LTM injection SHOULD preserve the stable/context-bound distinction across all protocol paths to optimize cache behavior, not just for Anthropic.
- References: `packages/gateway/src/translate/anthropic.ts:369-423`, `packages/gateway/src/pipeline.ts:1028-1040`

### REQ-TOOL-001: Cross-protocol tool_result preservation
All protocol translators MUST preserve tool_result blocks when converting between gateway internal format and upstream wire format.
- References: `packages/gateway/src/translate/anthropic.ts:369-423`, `packages/gateway/src/translate/openai.ts:523-527`, `packages/gateway/src/translate/openai-responses.ts:126-131`

### REQ-STREAM-001: Cross-protocol error event propagation
All streaming translators MUST propagate upstream error events to clients in the target protocol's error format.
- References: `packages/gateway/src/stream/openai.ts`, `packages/gateway/src/stream/openai-responses.ts:687-711`

### REQ-PLUGIN-001: Shared gateway discovery module
Gateway discovery logic SHOULD be extracted to a shared module consumed by both OpenCode and Pi plugins to prevent code divergence.
- References: `packages/opencode/src/index.ts:39-80`, `packages/pi/src/index.ts:99-133`

### REQ-ROUTE-001: Extensible upstream routing
The upstream routing table MUST be extensible via configuration to support new model providers without code changes.
- References: `packages/gateway/src/config.ts:99-121`

### REQ-AGENT-001: Complete agent detection registry
The agent detection registry SHOULD include entries for all documented supported tools (Cursor, Windsurf).
- References: `packages/gateway/src/cli/agents.ts:82-141`

### REQ-STATE-001: Consistent session state persistence lifecycle
Session state persistence MUST either restore all persisted fields on load OR remove write-only persistence for transient fields.
- References: `packages/core/src/db.ts:891-950`, `packages/core/src/gradient.ts:673-677`

### REQ-LTM-002: Pool deduplication in LTM scoring
The LTM scoring pipeline SHOULD deduplicate entries after merging project and cross-project pools.
- References: `packages/core/src/ltm.ts:415-641`

### REQ-API-001: Shared implementation for CLI and REST
CLI data commands SHOULD delegate to core functions rather than reimplementing logic to prevent divergence.
- References: `packages/gateway/src/cli/data.ts:748`, `packages/core/src/ltm.ts`

### REQ-RECALL-001: Parity between gateway and CLI recall
CLI recall SHOULD document query expansion limitations and optionally support expansion via temporary LLM client.
- References: `packages/gateway/src/recall.ts:343`, `packages/gateway/src/cli/recall-cmd.ts:21`

## Derived Use Cases (UC-NN)

### UC-01: Multi-session gateway with different models
- Actors: Two AI agents using different models (e.g., Claude Opus and GPT-4)
- Preconditions: Gateway running in hosted mode
- Flow: Agent A sends request with Claude model → setModelLimits() sets Opus limits → Agent B sends request with GPT-4 → setModelLimits() overwrites with GPT-4 limits → Agent A's next request uses GPT-4's context limits
- Postconditions: Each session should use its own model's context limits

### UC-02: Long-running gateway session lifecycle
- Actors: Gateway process, multiple AI agent sessions over 24+ hours
- Preconditions: Gateway started, sessions connect and disconnect
- Flow: Sessions connect → sessionStates/limiters created → sessions disconnect → state remains in memory → new sessions add more state → memory grows monotonically
- Postconditions: Memory usage should stabilize or old sessions should be evicted

### UC-03: Agentic workflow through OpenAI upstream
- Actors: AI agent using OpenAI Chat Completions protocol, target tool
- Preconditions: Gateway proxying to OpenAI upstream, tool definitions registered
- Flow: Agent calls tool → model generates tool_use → gateway forwards → tool executes → tool_result returned → gateway builds upstream request → tool_result block is dropped
- Postconditions: Model should see tool results in subsequent turns

### UC-TOOL-001.a: Tool result round-trip via Anthropic translator
- Actors: AI agent, Anthropic upstream
- Flow: `buildAnthropicRequest` at `translate/anthropic.ts:333` converts gateway tool_result to Anthropic tool_result content block
- Postconditions: tool_result block present in upstream request

### UC-TOOL-001.b: Tool result round-trip via OpenAI translator
- Actors: AI agent, OpenAI upstream
- Flow: `buildOpenAIUpstreamRequest` at `translate/openai.ts:423` should convert gateway tool_result to `role: "tool"` message
- Postconditions: tool result present as tool message in upstream request (CURRENTLY BROKEN — silently dropped)

### UC-TOOL-001.c: Tool result round-trip via Responses translator
- Actors: AI agent, OpenAI Responses upstream
- Flow: `buildOpenAIResponsesUpstreamRequest` at `translate/openai-responses.ts:211` should preserve tool results
- Postconditions: tool result present in upstream request

### UC-STREAM-001.a: Error propagation in native Anthropic streaming
- Actors: Client, Anthropic upstream
- Flow: Upstream sends `error` event → `stream/anthropic.ts` accumulator processes it → event forwarded to client as-is
- Postconditions: Client sees error details

### UC-STREAM-001.b: Error propagation in OpenAI Chat Completions streaming
- Actors: Client, Anthropic upstream via OpenAI translation
- Flow: Upstream sends `error` event → `stream/openai.ts` translator should emit error → currently falls through silently → client sees `[DONE]`
- Postconditions: Client should see error details (CURRENTLY BROKEN — silent termination)

### UC-STREAM-001.c: Error propagation in Responses API streaming
- Actors: Client, Anthropic upstream via Responses translation
- Flow: Upstream sends `error` event → `stream/openai-responses.ts` translator emits `response.failed` at line 687-711
- Postconditions: Client sees `response.failed` with error details
