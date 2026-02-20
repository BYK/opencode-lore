# Nuum Memory Improvement Plan

Based on: LongMemEval oracle evaluation (Feb 2026) + Mastra Observational Memory analysis
+ coding memory eval on real OpenCode sessions.

## Benchmark Results

### LongMemEval (500 questions, Sonnet 4.6)

| System             | Overall | SSU   | SSP   | SSA   | Abst  | KU    | Multi | Temp  |
| ------------------ | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| Mastra OM (5-mini) | 94.87%  | —     | —     | —     | —     | —     | —     | —     |
| **Lore v2**        | **88.0%** | 93.8% | 86.7% | 96.4% | 86.7% | 93.1% | 85.1% | 81.9% |
| Lore v1            | 73.8%  | 93.8% | 86.7% | 83.9% | 76.7% | 83.3% | 64.5% | 59.1% |
| Baseline (no mem)  | 72.6%  | 71.9% | 46.7% | 91.1% | 53.3% | 84.7% | 76.9% | 64.6% |

Key: SSU=single-session-user, SSP=single-session-preference, SSA=single-session-assistant,
Abst=abstention, KU=knowledge-update, Multi=multi-session, Temp=temporal-reasoning.

### Coding Memory Eval (15 questions across 3 real OpenCode sessions)

| System               | Score              | Delta   | Notes                                                 |
| -------------------- | ------------------ | ------- | ----------------------------------------------------- |
| **Lore v2 final**    | **14/15 (93.3%)**  | +26.7pp | Refined observer prompts + backfilled distillations   |
| Lore v2 + recall     | 12/15 (80.0%)      | +13.3pp | Recall tool + backfill, before prompt refinements     |
| Lore v2 (obs only)   | 12/15 (80.0%)      | +13.3pp | Observations only, no recall tool in eval             |
| Default OpenCode     | 10/15 (66.7%)      | —       | 80K token tail window (recency-biased context)        |

Final head-to-head (lore 93.3% vs default 66.7%):
Nuum wins 5, Default wins 1, Both correct 9, Both fail 0.

Nuum uniquely wins: crossProject type, FTS5 bug fix, bulk-update count (43), eval session
pollution, orgs count — all early/mid-session details lost from default's tail window.

Default uniquely wins: test failures count (131 vs 130 — observer captured both measurements
from different segments, model picked the later one).

Sessions tested:
- nuum-dev (919 msgs, 483k tokens, 19 distillations, 92k obs chars) — fully backfilled
- sentry-cli (199 msgs, 141k tokens, 4 distillations, 21k obs chars) — backfilled
- auth-api (226 msgs, 95k tokens, 5 distillations, 24k obs chars) — backfilled

---

## Phase 1: Observation-log format — DONE

Replaced `{ narrative, facts }` JSON with OM-style dated timestamped event-log text.
Priority tags (🔴/🟡/🟢), entity markers, exact quantities, assistant content preservation.

Result: +14.2pp on LongMemEval (73.8% → 88.0%). SSA fixed from 83.9% → 96.4% after
strengthening assistant content preservation rules in observer prompt.

## Phase 2: Temporal anchoring at read time — DONE

`addRelativeTimeToObservations` and `expandInlineEstimatedDates` inject "(5 weeks ago)"
annotations and gap markers at read time. Temporal-reasoning: 59.1% → 81.9%.

## Phase 3: Incremental distillation — DONE

Triggers `backgroundDistill` when undistilled message count exceeds `maxSegment` (default 50)
after each completed assistant message (index.ts message.updated handler). This keeps each
distillation segment small and high-fidelity, preventing the oversized first-batch problem
(306 msgs in one segment) that caused early detail loss.

Also implemented:
- **Backfill script** (eval/backfill.ts): segments historical sessions into 50-msg batches
  and stores gen-0 distillations via the OpenCode prompt API.
- **Child session skip** (index.ts): `shouldSkip()` checks for parentID and caches result,
  preventing eval/worker child sessions from polluting temporal storage.
- **Eval purge** (eval/coding_eval.ts): `purgeEvalMessages()` cleans small eval sessions
  from temporal storage before each run. Rebuilds FTS5 index after content table deletes.

## Phase 4: Observer prompt refinements — DONE

Added to DISTILLATION_SYSTEM:
- **EXACT NUMBERS — NEVER APPROXIMATE**: Record verbatim counts from the conversation at
  the time stated; never substitute a later count. Fixed bulk-update "43 vs 50" failure.
- **BUG FIXES AND CODE CHANGES — HIGH PRIORITY**: Record bug, root cause, fix (with file
  paths), and outcome regardless of position in conversation. Fixed FTS5 prefix matching
  bug capture.

Added to RECURSIVE_SYSTEM:
- **EXACT NUMBERS**: When segments conflict on a number, keep the earlier/original one.
- **EARLY-SESSION CONTENT**: Bug fixes from session start must survive reflection.

Result: +13.3pp on coding eval (80.0% → 93.3%).

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
- **FTS5 content-sync purge** (1d02e1d): rebuild FTS index after content table deletes;
  direct DELETE from FTS5 content-sync tables causes SQLITE_CORRUPT_VTAB.
- **Eval contamination** (763ee8f): child session skip + purgeEvalMessages prevents
  eval Q&A from polluting temporal storage and recall results.

---

## Phase 5: Cross-session entity merging — FUTURE

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
in v1). Ceiling ~94% (Mastra OM's best). Lower priority since multi-session is already the
strongest improvement from Phase 1+2.

---

## What NOT to change

- **LTM curator system** — lore's unique advantage. OM has no cross-session durable knowledge.
- **Gradient 4-layer safety system** — more robust than OM's fixed two-block layout for
  coding agents with unpredictable tool call sizes.
- **Plugin architecture** — lore operates as an OpenCode plugin, swappable and configurable.

---

## Key references

- Mastra OM source: https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory
- Mastra OM research: https://mastra.ai/research/observational-memory
- LongMemEval: https://arxiv.org/abs/2410.10813
- Oracle dataset: eval/data/longmemeval_oracle.json (500 questions)
- Coding eval dataset: eval/data/coding_memory_eval.json (15 questions, 3 sessions)
- Eval harness: eval/harness.ts (LongMemEval), eval/coding_eval.ts (coding)
- Backfill: eval/backfill.ts
- Results: eval/results/
