<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ded9e-8a33-72a5-86b1-c364a26679fa -->
* **@loreai/gateway package: transparent LLM proxy for Claude Code/Cursor/etc**: @loreai/gateway package: transparent LLM proxy for Claude Code/Cursor/etc. Gateway HTTP proxy on port 6969 accepting \`/v1/messages\`. Session ID via \`\[lore:\<base62>]\` marker (8 random bytes + unix timestamp). If absent, forces \`stream:false\`, prepends marker, re-encodes SSE. Fallback: SHA-256 of first message. Project path from system prompt regex or \`X-Lore-Project\` header. Node22 bundle. Plugin auto-spawns gateway if not running: probes \`http://127.0.0.1:6969/health\`, spawns via \`Bun.spawn()\` if absent, waits up to 5s for readiness. Skip via \`LORE\_GATEWAY\_MODE=0\` or \`NODE\_ENV=test\`.

<!-- lore:019df8a8-a2ee-71fe-a8c1-7b2aaa4b8c03 -->
* **Gateway OpenAI protocol translation layer**: Gateway accepts \`/v1/chat/completions\` and \`/v1/messages\`. \`parseOpenAIRequest()\` maps tool\_calls to tool\_use, preserves extras (temperature, top\_p). \`buildOpenAIResponse()\` handles streaming (SSE) and non-streaming. API key via \`x-api-key\` header → \`Authorization: Bearer\`.

<!-- lore:019df901-8543-729d-adff-fff21c43fc5e -->
* **Plugin primary path: direct hooks with optional gateway fallback**: OpenCode plugin defaults to direct plugin mode (hooks in \`packages/opencode/src/index.ts:1537\`). At startup, probes gateway health (\`http://127.0.0.1:6969/health\`, 1.5s timeout) and attempts spawn via \`Bun.spawn()\` if absent. If gateway comes up, switches to observer-only hooks (lines 1450–1535) that log \`\[lore:verify]\` without mutating output; gateway does the real work. If probe fails or spawn doesn't complete in 5s, falls back to direct plugin path. Disable via \`LORE\_GATEWAY\_MODE=0\` or \`NODE\_ENV=test\`. \*\*Critical for production cost\*\*: worktree sessions use OpenCode build from worktree directory, not the patched BYK/cumulative fork. Worktree OpenCode may lack the tool-part cache mutation fix (patch \`88260b5e8\`), causing unbounded cache busts. Verify worktree is synced or runs with fix applied.

### Decision

<!-- lore:019df901-8553-7b53-b74e-2021824da8d7 -->
* **Batch API integration: gateway enhancement, not mandatory architecture shift**: Implementing Anthropic Message Batches API as a gateway-only feature (50% cost savings on distillation/curation workers) does not require mandating gateway for all deployments. Direct plugin path continues working normally; batching is an optional gateway optimization that transparently accumulates non-urgent distill/distill-curation calls, flushes every N seconds, polls results in background. Keeps gateway experimental status while capturing savings on high-volume workers (\`distillSegment\`, \`metaDistill\`, \`consolidate\`, worker validation). Estimate: ~$1,100/month savings on Lore workers alone.

<!-- lore:019dfa53-b925-70e2-8f84-cab808d8e115 -->
* **Batch distillation consumption to reduce cache-bust frequency**: Batch distillation consumption at turn boundaries: Refresh \`loadDistillations()\` only at turn boundaries (new user message) or after idle gap > cache TTL (~5min). During autonomous tool chains (consecutive assistant→tool→assistant), freeze prefix—no DB hits. Context: prefix refresh costs \`context\_size × $3.75/MTok\` (~$1.88 per bust for 500K Sonnet). New distillations have marginal value mid-chain—model already has raw messages. Turn-boundary refresh reduces 189 arrivals → 8 refresh points in typical session, cutting bust cache writes from $639 → ~$15 (97% reduction). Combine with batching background distill workers: accumulate \`backgroundDistill()\` calls, flush at turn boundaries instead of firing on every \`message.updated\` event.

### Gotcha

<!-- lore:019dfa62-9c29-746f-ab60-313983894131 -->
* **Anthropic cache TTL is 5 minutes, not 1 hour — inform refresh policy**: Anthropic prompt cache TTL is ~5 minutes, not 1 hour. Any prefix refresh within a warm window pays full cache write cost (~$3.75/MTok × context\_size, ~$1.88 per bust for 500K). Prefix changes due to distillation row arrivals or transform non-determinism (Date.now() in sanitizeToolParts, relational timestamps) trigger busts. Cost-aware policy: refresh at turn boundaries or after idle > TTL only. Runtime monitoring needed: track bust rate per session; alert stderr when rate > 50% after 20+ calls to catch regressing code paths early.

<!-- lore:019c91d6-04af-7334-8374-e8bbf14cb43d -->
* **Calibration used DB message count instead of transformed window count — caused layer 0 false passthrough**: Gradient calibration: (1) Use \`getLastTransformedCount()\`, not DB count—causes layer 0 overflow. (2) Include \`cache.write\` in \`actualInput\`. (3) Drop trailing pure-text assistant messages ALL layers; never drop tool parts. (4) Unregistered projects stuck in compaction; delete after last good assistant.

<!-- lore:019dfa4b-d2fb-7195-8f43-f93b5ffac9bb -->
* **Lore transform non-determinism breaks prompt cache between API calls**: Lore transform non-determinism breaks prompt cache. Root causes: (1) \`sanitizeToolParts()\` uses \`Date.now()\` on every call → different timestamps for same pending parts → different message bytes → cache bust. Fix: use deterministic timestamp (part.state.time.start or 0). (2) \`distilledPrefixCached()\` calls \`addRelativeTimeToObservations(newRows, new Date())\` per gen-0 row → relational time changes → cache bust. Fix: batch consumption at turn boundaries \[\[019dfa53-b925-70e2-8f84-cab808d8e115]]. Prevent regressions via unit tests covering transform determinism + runtime bust-rate tracking.

<!-- lore:019dfcb9-cad6-7290-b526-cc9e4186a290 -->
* **Runtime cost monitoring is log-only, no session budget enforcement**: Lore has cache-bust detection (prefix hash comparison) and overflow recovery, but NO session cost accumulator, alerts, or abort mechanisms. Cost is only tracked post-hoc in eval harnesses. Cache busts log individually via \`log.info()\` but are never counted or rated. No config option for session spend limits or cost thresholds. Plugin can't abort—only host (OpenCode) can halt. Must implement runtime cost tracking with stderr alerts when session spend exceeds threshold, paired with unit tests for transform determinism to prevent regressions.

<!-- lore:019dfa53-b91d-734f-a5e2-55979f911303 -->
* **System prompt size bloat from AGENTS.md injection: 41K tokens on single session**: System prompt reaches ~41K tokens: AGENTS.md (project-specific knowledge ~16K) + Lore entries (~7K) + OpenCode base system prompt (~5K) + tool definitions (~8-10K). The 41K is cached read-only (Anthropic caches it), but AGENTS.md's 68KB file (growing with lore exports) is expensive to maintain. Lore entries change frequently (new entries added post-session). Consider: truncate lore entries in AGENTS.md to recent 10-15 instead of all 26, or split knowledge into separate injection path (not system prompt) to avoid system-prompt byte changes on each knowledge update.

<!-- lore:019df987-1c4b-727d-9968-7ed4871ec85f -->
* **Worktree OpenCode instances lack upstream cache bust fix — enable tool-part caching**: OpenCode worktree instances (created via \`mkdir worktree\`, managed independently from main install) may not have patch \`88260b5e8\` (cache \`msgs\` array across prompt loop iterations). Without it, tool-part state mutations (\`pending\` → \`completed\` + output) between API calls break prompt cache on nearly every call. Real cost impact: session with 667 API calls = 78 busts costing $77 (12% of calls, 99% of cache-write cost). Each bust rewrite grows to 470K tokens. Fix: sync worktree OpenCode to BYK/cumulative branch OR apply patch directly. Workaround: set aggressive layer-0 cap ($0.05/turn for Sonnet) to escalate to layer 1+ where mutations are contained.

### Pattern

<!-- lore:019dfcb9-cae2-7eb5-9769-8faf8cc8527d -->
* **Cache bust detection via prefix ID hash but no rate tracking**: Gradient tracks byte-identity of message prefix between turns using \`lastPrefixHash\` (first 5 message IDs concatenated with layer). When prefix changes, logs cache-bust event via \`log.info()\` at lines 1682-1696. Also tracks \`consecutiveHighLayer\` counter for compaction hints (logs at count=3, fires once). But no rolling bust-rate counter, no cumulative bust count per session, no alerting threshold. Need to add per-session \`bustCount\` and \`bustRate\` metrics that fire stderr alert when rate > 50% after 20+ API calls.

<!-- lore:019dfa53-b921-766c-b46b-14390cf81010 -->
* **Distillation row arrivals trigger cache busts via prefix budget shifts**: Each new gen-0 distillation row (~189 total across session) changes the distilled prefix text length → shrinks raw window budget → \`tryFitStable()\` recalculates raw window cutoff → messages evicted/included from front → entire output array bytes change. Even with \`tryFitStable()\` pinning logic, prefix token growth forces re-evaluation. Result: alternating bust/warm pattern (bust when row arrives, warm on subsequent call with same row count). Meta-distillations compound this: 17 full re-renders with \`new Date()\` cause relational time annotations to potentially differ, plus row count collapse (e.g., 10 gen-0 → 1 gen-1 row) shrinks prefix drastically.

<!-- lore:019df901-854f-704d-98db-f33a70ed9617 -->
* **distillSegment urgency tiers: defer-safe vs blocking paths**: Not all \`distillSegment()\` calls tolerate batching latency (up to 1h). Fire-and-forget calls in \`message.updated\` (line 836) and \`messages.transform\` layer≥2 (line 1341) defer result to next turn—batch-safe. But overflow recovery (line 888) and \`/compact\` (line 1368) \`await\` result immediately to build recovery/compact prompt—batch-unsafe. Thread \`urgent?: boolean\` flag through \`backgroundDistill()\` to \`distillation.run()\`: urgent=true bypasses batch queue, uses synchronous \`prompt()\`. Batch viable for ~80% of distillation volume (idle/incremental paths).

<!-- lore:019df8b6-f76d-730d-bdfa-e614a9b1d918 -->
* **Gateway model-based upstream routing with fallback to env vars**: Gateway auto-infers upstream provider URL from model prefix (claude-\* → Anthropic, gpt-\* → OpenAI). \`resolveUpstreamRoute()\` maintains routing table matching models to URLs/protocols. Unknown models fall back to \`LORE\_UPSTREAM\_ANTHROPIC\`/\`LORE\_UPSTREAM\_OPENAI\` env vars, enabling zero-config forwarding.

<!-- lore:019df77c-df6d-7223-ad8b-c8484e9d3e25 -->
* **Gateway package: new fourth runtime adapter for proxy-based context management**: Gateway package: runtime-agnostic HTTP proxy accepting Anthropic \`/v1/messages\`, applying full Lore pipeline (gradient, LTM, distillation), forwarding upstream. Implements \`LLMClient\` in \`llm-adapter.ts\`. Supports optional interceptor for recording/replay. Plugin spawns gateway if not running (probes \`http://127.0.0.1:6969/health\`, waits 5s), then registers observer hooks in gateway mode to audit gateway decisions without mutating output — logs session ID verification, LTM entries selected, gradient layer/tokens chosen. Observer reads \`temporal\_messages\`, \`knowledge\` tables; runs local \`transform()\` and \`forSession()\` for comparison.

<!-- lore:019dfa4b-d2ff-704a-97b4-e382a46cb7b4 -->
* **Gradient layer transitions trigger cascade of cache busts in Lore**: Late-stage sessions show phase transition at ~step 668: bust rate jumps from 12% → 51%. Correlates with context window growth crossing layer-0 cap, escalating to layer-1+ (higher cost, different message restructuring). Each layer transition may alter how gradient injects context, changing message array bytes and invalidating prompt cache. Effect compounds: higher layer cost + more busts = quadratic explosion. Monitor gradient layer choice at step transitions; may need per-layer cache validation or deterministic layer boundary crossing.

<!-- lore:019dc5e2-c998-7395-9591-b0214485832d -->
* **Idle-resume cache refresh: clear caches when wall-clock gap exceeds prompt cache TTL**: Clear caches when wall-clock gap exceeds prompt cache TTL. If \`now - lastTurnAt > 60min\`, call \`onIdleResume(sessionID)\` in pre-LLM hook to clear \`prefixCache\`, \`rawWindowCache\`, delete \`ltmSessionCache\`, set \`cameOutOfIdle=true\`.

<!-- lore:019df987-1c4f-7205-b320-f01f2c32cdce -->
* **Long-running autonomous sessions hit quadratic cache cost — session length budget needed**: Long-running sessions hit quadratic cache cost via non-deterministic transform. Session with 1,345 API calls: 314 calls (23%) read only 40,913 tokens (system prompt), rewriting 400–690K tokens each (busts). Two root causes: (1) Distillation row arrivals (~189 total) change \`distilledPrefix()\` length → shrink raw window budget → entire message array bytes change. (2) \`sanitizeToolParts()\` line 833 uses \`Date.now()\` to convert pending tool parts to error, producing different timestamps on every \`transform()\` call even with same input. OpenCode's cache fix (e148f00aa) preserves old pending parts in cached array—but Lore re-timestamps them. Fix distillation consumption at turn boundaries \[\[019dfa53-b925-70e2-8f84-cab808d8e115]] and use deterministic timestamp (0 or message.time.created) instead of \`Date.now()\` in sanitizeToolParts.

<!-- lore:019df8d1-f93e-7e83-8706-7d6d87b00f77 -->
* **Observer hooks in gateway mode: local gradient/LTM audit without mutation**: When gateway is active, plugin registers observer-only hooks that run \`transform()\` and \`ltm.forSession()\` locally on raw messages, then log results as \`\[lore:verify]\` without mutating \`output\`. Session marker scanned from incoming messages for ID verification. Observer reads \`temporal\_messages\` and \`knowledge\` tables to audit gateway's gradient layer, token estimates, and LTM entry selection—enabling side-by-side comparison in production without altering the real data flow (gateway remains the authoritative LLM handler).

<!-- lore:019df8b6-f772-797b-88d3-29c98434646e -->
* **Plugin auto-detects gateway and configures provider baseURLs via config hook**: Plugin auto-detects gateway via health check to \`http://localhost:6969/health\` (1s timeout). If responding, plugin sets \`baseURL: http://localhost:6969\` for all providers (Anthropic, OpenAI, Google, Nvidia, etc), routing requests through gateway. Sets \`LORE\_GATEWAY\_MODE=1\` to disable normal operation.

<!-- lore:019df8c1-0777-7a22-9146-7f991d9ba972 -->
* **Plugin resolver shim for workspace source resolution**: Installed plugin at \`~/.config/opencode/plugins/lore.ts\` is a re-export shim (\`export { LorePlugin as default } from "opencode-lore"\`). This allows the plugin to always resolve to workspace source (\`packages/opencode/src/index.ts\`) without requiring rebuild after code changes. Plugin loads the active source directly on each OpenCode startup.

<!-- lore:019de7fb-fec3-75a5-ae26-88193fc59abf -->
* **Time-gap-aware detectSegments + recall recency RRF**: \`detectSegments()\` splits at largest inter-message time gap (≥3× median); falls back to count-based for uniform timestamps. Min segment 3. Recall adds recency-sorted temporal results to RRF fusion keyed \`t:\<id>\`, naturally boosting items in both BM25 + recency lists. Pure additive; no schema changes.
<!-- End lore-managed section -->
