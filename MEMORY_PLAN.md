# Nuum Memory Improvement Plan

Based on: LongMemEval oracle evaluation (Feb 2026) + Mastra Observational Memory analysis
+ coding memory eval on real OpenCode sessions.

## Benchmark Results

### LongMemEval (500 questions, Sonnet 4.6)

| System             | Overall | SSU   | SSP   | SSA   | Abst  | KU    | Multi | Temp  |
| ------------------ | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| Mastra OM (5-mini) | 94.87%  | —     | —     | —     | —     | —     | —     | —     |
| **Nuum v2**        | **88.0%** | 93.8% | 86.7% | 96.4% | 86.7% | 93.1% | 85.1% | 81.9% |
| Nuum v1            | 73.8%  | 93.8% | 86.7% | 83.9% | 76.7% | 83.3% | 64.5% | 59.1% |
| Baseline (no mem)  | 72.6%  | 71.9% | 46.7% | 91.1% | 53.3% | 84.7% | 76.9% | 64.6% |

Key: SSU=single-session-user, SSP=single-session-preference, SSA=single-session-assistant,
Abst=abstention, KU=knowledge-update, Multi=multi-session, Temp=temporal-reasoning.

### Coding Memory Eval (15 questions across 3 real OpenCode sessions)

| System          | Score    | Notes                                          |
| --------------- | -------- | ---------------------------------------------- |
| **Nuum v2**     | **80.0%** (12/15) | Wins on early-session recall, prefill error, org count, test failures |
| Default OpenCode | 73.3% (11/15) | Wins on /users/me/ detail (recency bias helps) |

Head-to-head: nuum wins 3, default wins 2, both correct 9, both fail 1.

Sessions tested:
- nuum-dev (776 msgs, 416k tokens, 11 distillations, 32.6k obs chars) — good coverage
- sentry-cli (199 msgs, 141k tokens, 0 persistent distillations) — on-demand only
- auth-api (226 msgs, 95k tokens, 1 distillation, 4k obs chars) — very sparse

---

## Phase 1: Observation-log format — DONE

Replaced `{ narrative, facts }` JSON with OM-style dated timestamped event-log text.
Priority tags (🔴/🟡/🟢), entity markers, exact quantities, assistant content preservation.

Result: +14.2pp on LongMemEval (73.8% → 88.0%). SSA fixed from 83.9% → 96.4% after
strengthening assistant content preservation rules in observer prompt.

## Phase 2: Temporal anchoring at read time — DONE

`addRelativeTimeToObservations` and `expandInlineEstimatedDates` inject "(5 weeks ago)"
annotations and gap markers at read time. Temporal-reasoning: 59.1% → 81.9%.

## Stability fixes — DONE

- **Infinite tool-call loop** (2bdc4c3): trailing-drop safety net was unconditionally
  stripping assistant messages including those with tool parts for in-progress agentic steps.
  Fix: only drop assistant messages with no tool parts. Layer 4 uses cleanParts instead of
  stripToTextOnly to preserve tool parts.
- **Worker session isolation** (c7e78ff): shared workerSessionIDs set prevents storing
  distillation/curator worker session content in temporal storage.
- **Orphan reset** (c7e78ff): resetOrphans() recovers messages marked distilled by
  deleted/migrated distillations.
- **Recall tool description** (2bdc4c3): rewritten to make explicit that visible context is
  a trimmed window, encouraging proactive recall for anything not currently visible.
- **System-reminder stripping** (c054f64): cleanParts applied in all gradient layers
  including Layer 4. Handles both ephemeral wrappers and persisted synthetic parts.
- **Prefill error** (5fb7ecb): stripToTextOnly inserts placeholder if all parts removed;
  index.ts safety net drops trailing non-tool assistant messages.
- **crossProject default** (a2a2b21): `op.crossProject !== false` instead of
  `op.crossProject ? 1 : 0` to handle undefined correctly.

---

## Phase 3: Incremental distillation — NEXT

**Problem:** Nuum distills in batch on session.idle, which creates two issues:

1. **Giant first segments**: The nuum-dev session's first distillation covers 306 messages
   in 5,084 chars. Early details (like the FTS5 bug at message 1) get lost in compression.
   Both modes fail on this question.

2. **No distillation for active sessions**: sentry-cli has 199 messages and 141k tokens but
   zero stored distillations. Each eval run must re-distill on-demand. auth-api has only
   1 distillation covering 224 messages at very low fidelity (4k chars).

3. **Latency**: Observations aren't available until the session goes idle, so recall
   can't find recent work within the same session.

**Plan:**

- Observe incrementally every ~20-30 messages (~30k tokens) via message count tracking,
  not just on session.idle. Each segment stays within maxSegment (50 msgs) for high fidelity.
- Append-only: new observations append to existing for that session rather than re-distilling.
- Reflection threshold: when total observation size exceeds ~40k tokens, trigger metaDistill
  (recursive merge).
- Backfill: add a CLI command or startup hook to distill historical sessions that have
  temporal messages but no distillations.

**Expected impact:** Fix the FTS5 question (smaller segments = higher fidelity on early
messages). Fix sparse auth-api coverage. Eliminate on-demand distillation in eval.

---

## Phase 4: Cross-session entity merging — FUTURE

**Problem:** Distilling sessions independently loses enumeratable entities that span sessions.
"How many weddings did I attend?" fails if each wedding was in a separate session.

**Plan:**

- **Observer prompt**: Flag enumeratable entities explicitly with ENTITY markers.
  `🔴 [ENTITY:event-attended] User attended Rachel+Mike's wedding (vineyard, Aug 2023)`
- **Reflector prompt**: Aggregate entity sets during recursive merge.
  `🔴 User attended 3 weddings total: Rachel+Mike (Aug), Emily+Sarah (Sep), Jen+Tom (Oct 8)`
- **Curator integration**: Update existing LTM entries for recurring entity types rather
  than creating duplicates.

**Expected impact:** Partial recovery of multi-session category (currently 85.1%, was 64.5%
in v1). Ceiling ~94% (Mastra OM's best). Lower priority than Phase 3 since multi-session
is already the strongest improvement from Phase 1+2.

---

## Phase 5: Observer prompt refinements — ONGOING

**Known gaps from coding eval failures:**

1. **Exact number preservation**: Nuum said "50 entries" instead of "43" for the bulk-update
   count question. Observer prompt should emphasize preserving exact counts when stated.

2. **Very early session detail**: Events in the first few messages of a session get
   compressed more aggressively because they're in the oldest distillation segment. Phase 3
   (incremental distillation) addresses this structurally; prompt refinements can help too.

3. **Sparse session handling**: When a session has very few observations relative to its
   message count, the recall tool should surface this gap so the model knows to look harder
   or qualify uncertainty.

---

## What NOT to change

- **LTM curator system** — nuum's unique advantage. OM has no cross-session durable knowledge.
- **Gradient 4-layer safety system** — more robust than OM's fixed two-block layout for
  coding agents with unpredictable tool call sizes.
- **Plugin architecture** — nuum operates as an OpenCode plugin, swappable and configurable.

---

## Key references

- Mastra OM source: https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory
- Mastra OM research: https://mastra.ai/research/observational-memory
- LongMemEval: https://arxiv.org/abs/2410.10813
- Oracle dataset: eval/data/longmemeval_oracle.json (500 questions)
- Coding eval dataset: eval/data/coding_memory_eval.json (15 questions, 3 sessions)
- Eval harness: eval/harness.ts (LongMemEval), eval/coding_eval.ts (coding)
- Eval judge: eval/evaluate.ts
- Results: eval/results/
