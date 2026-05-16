# Code Review Findings

## Pass 1 — Structural Review

### P1-001: JSON.parse without error handling
- **File:** packages/gateway/src/translate/openai.ts:166,205
- **Category:** Error Handling
- **Severity:** LOW
- **Description:** `JSON.parse(fn.arguments as string)` is called without a try/catch block.
- **Impact:** Invalid JSON from the model will crash the translator and break the request lifecycle.
- **Related CB:** CB-008

### P1-002: Unhandled promise rejection on recall follow-up stream
- **File:** packages/gateway/src/pipeline.ts:1371-1440
- **Category:** Async Propagation / Error Handling
- **Severity:** MEDIUM
- **Description:** The `for await` block calling `parseSSEStream(contReader)` is not wrapped in a try/catch, meaning errors parsing the stream or sudden stream closure will result in unhandled rejections.
- **Impact:** Unhandled promise rejections can cause silent failures in the recall follow-up stream.
- **Related CB:** CB-004

### P1-003: saveForceMinLayer row deletion hazard
- **File:** packages/core/src/db.ts:1019-1031
- **Category:** Error Handling / Resource Cleanup
- **Severity:** HIGH
- **Description:** `saveForceMinLayer` issues a `DELETE FROM session_state WHERE session_id = ?` when layer is 0. This destroys the entire row including other dependent fields.
- **Impact:** Deletes tracking data, gradient state, and cost tracking unexpectedly.
- **Related CB:** CB-001

### P1-004: Unbounded contextLimit and outputReserved
- **File:** packages/core/src/gradient.ts:37-38
- **Category:** Unbounded Growth
- **Severity:** MEDIUM
- **Description:** `contextLimit` and `outputReserved` are module-level globals, shared across all sessions.
- **Impact:** Limits bleed across concurrent sessions causing unexpected truncation or limit violations.
- **Related CB:** CB-002

### P1-005: Unbounded sessionStates Map
- **File:** packages/core/src/gradient.ts:304
- **Category:** Unbounded Growth
- **Severity:** MEDIUM
- **Description:** `sessionStates` is a `Map<string, SessionState>` that never evicts old sessions.
- **Impact:** Memory leak over time as sessions accumulate.
- **Related CB:** CB-003

### P1-006: Unbounded globalHeaderValues Map
- **File:** packages/gateway/src/session.ts:328
- **Category:** Unbounded Growth
- **Severity:** MEDIUM
- **Description:** `globalHeaderValues` never evicts old candidates.
- **Impact:** Slow memory leak over time.
- **Related CB:** CB-003

### P1-007: Unbounded session-limiter p-limit Map
- **File:** packages/core/src/session-limiter.ts:17
- **Category:** Unbounded Growth
- **Severity:** MEDIUM
- **Description:** `limiters` Map never evicts unused limiters.
- **Impact:** Memory leak for long-running processes.
- **Related CB:** CB-003

### P1-008: process.exit over safeExit
- **File:** packages/gateway/src/cli/bin.ts:7
- **Category:** Resource Cleanup
- **Severity:** MEDIUM
- **Description:** `process.exit(1)` is used instead of `safeExit`.
- **Impact:** Might exit before pending async telemetry or DB flushes complete.
- **Related CB:** CB-007

---

## Pass 2 — Requirement Verification

### REQ-001: Recoverable embedding provider fallback
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/core/src/embedding.ts:518-527` — `cachedProvider = fallback.provider` permanently overwrites the provider.
- **Cross-reference:** CB-010
- **Notes:** Fallback has no retry mechanism.

### REQ-002: FTS5 degradation signal
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/core/src/ltm.ts:812-818` — The `catch` block calls `searchLike` and returns without propagating a warning/error.
- **Cross-reference:** New bug (could be considered part of FTS5 degradation).

### REQ-003: Multi-interface port conflict probe
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/cli/start.ts:120-130` — Uses `config.hosts[0]` exclusively.
- **Cross-reference:** New bug.

### REQ-004: Serialized fingerprint-based session lookup
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/pipeline.ts:930-950` — Concurrent lookups can cause race conditions.
- **Cross-reference:** New bug.

### REQ-005: Protocol-agnostic LTM cache optimization
- **Verdict:** PARTIALLY SATISFIED
- **Evidence:** `packages/gateway/src/translate/anthropic.ts:374` implements the 3-block TTL, but `packages/gateway/src/pipeline.ts:1053-1075` simply concatenates LTM for OpenAI paths.
- **Cross-reference:** New bug.
- **Notes:** Only Anthropic implements the optimization.

### REQ-006: Cross-protocol tool_result preservation
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/translate/openai.ts:523-527` — `tool_result` is explicitly ignored.
- **Cross-reference:** CB-006

### REQ-007: Cross-protocol error event propagation
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/stream/openai.ts:150-200` — Switch case on stream events is missing `"error"`.
- **Cross-reference:** CB-012

### REQ-008: Shared gateway discovery module
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/opencode/src/index.ts:39-60` and `packages/pi/src/index.ts:99-120` — Duplicated gateway discovery logic.
- **Cross-reference:** New bug.

### REQ-009: Extensible upstream routing
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/config.ts:99-130` — Uses hardcoded array `UPSTREAM_ROUTES`.
- **Cross-reference:** New bug.

### REQ-010: Complete agent detection registry
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/cli/agents.ts:80-110` — Missing `windsurf` and `cursor`.
- **Cross-reference:** New bug.

### REQ-011: Consistent session state persistence lifecycle
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/core/src/db.ts:1019-1031` — `saveForceMinLayer` deletes rows unexpectedly.
- **Cross-reference:** CB-001

### REQ-012: Pool deduplication in LTM scoring
- **Verdict:** NOT SATISFIED (at application level, though SQL overlap is minimal)
- **Evidence:** `packages/core/src/ltm.ts:450-470` — Direct concatenation `[...projectEntries, ...crossEntries]` in the preference path.
- **Cross-reference:** CB-009

### REQ-013: Shared implementation for CLI and REST
- **Verdict:** NOT SATISFIED
- **Evidence:** `packages/gateway/src/cli/data.ts` re-implements pair keys.
- **Cross-reference:** New bug.

### REQ-014: Parity between gateway and CLI recall
- **Verdict:** PARTIALLY SATISFIED
- **Evidence:** CLI lacks query expansion flag matching gateway capability.
- **Cross-reference:** New bug.

---

## Pass 3 — Cross-Requirement Consistency

### C3-001: Session State Persistence Consistency
- **Scope:** REQ-011, Database Writers
- **Finding:** INCONSISTENT
- **Evidence:** `packages/core/src/db.ts:1019` vs `1217`
- **Impact:** State loss. `saveForceMinLayer` deletion causes intermittent resets.
- **Recommendation:** Use `UPDATE` and `INSERT OR IGNORE` consistently across all mutations to `session_state`.

### C3-002: LTM Injection Consistency
- **Scope:** REQ-005
- **Finding:** PARTIAL
- **Evidence:** `packages/gateway/src/pipeline.ts:1053-1075`
- **Impact:** Sub-optimal token caching for non-Anthropic models.
- **Recommendation:** Implement proper block splitting if the protocol supports it, or document asymmetry.

### C3-003: Protocol Parity
- **Scope:** REQ-006, REQ-007
- **Finding:** INCONSISTENT
- **Evidence:** `packages/gateway/src/translate/openai.ts` and `packages/gateway/src/stream/openai.ts`
- **Impact:** Anthropic is the only reliable path for tools and error streams. OpenAI paths are deficient.
- **Recommendation:** Propagate `tool_result` mappings and streaming errors universally.

### C3-004: Requirement Contradiction Check
- **Scope:** General architecture
- **Finding:** CONSISTENT
- **Evidence:** Requirements do not strictly contradict, but optimizations like the fast path in `ltm.ts` need careful guarding against duplicate entry propagation.
- **Impact:** None directly observed beyond the deduplication bug.
- **Recommendation:** None.
