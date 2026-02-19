# Nuum Memory Improvement Plan

Based on: LongMemEval oracle evaluation (Feb 2026) + Mastra Observational Memory analysis.

## Benchmark Results (baseline)

| System                    | Model          | LongMemEval | Dataset       |
| ------------------------- | -------------- | ----------- | ------------- |
| Mastra OM                 | gpt-5-mini     | 94.87%      | longmemeval_s |
| Mastra OM                 | gpt-4o         | 84.23%      | longmemeval_s |
| **Nuum (post-Phase-1+2)** | **Sonnet 4.6** | **TBD**     | **oracle**    |
| Nuum (original)           | Sonnet 4.6     | 73.8%       | oracle        |
| Baseline (full context)   | Sonnet 4.6     | 72.6%       | oracle        |

### Nuum oracle breakdown (pre-improvement)

| Category                  | Baseline | Nuum  | Delta    |
| ------------------------- | -------- | ----- | -------- |
| single-session-user       | 71.9%    | 93.8% | +21.9    |
| single-session-preference | 46.7%    | 86.7% | +40.0    |
| abstention                | 53.3%    | 76.7% | +23.4    |
| knowledge-update          | 84.7%    | 83.3% | -1.4     |
| single-session-assistant  | 91.1%    | 83.9% | -7.1     |
| multi-session             | 76.9%    | 64.5% | -12.4    |
| temporal-reasoning        | 64.6%    | 59.1% | -5.5     |
| **Overall**               | 72.6%    | 73.8% | **+1.2** |

### Three failure patterns identified

1. **Cross-session aggregation loss** (multi-session -12.4%): Distillation compresses each
   session independently. Items mentioned briefly ("attended a wedding as background context")
   get dropped. Questions like "how many total?" undercount across sessions.

2. **Temporal precision loss** (temporal-reasoning -5.5%): Exact dates ("February 14") get
   compressed to vague relative terms ("early February"). Ordering and duration questions fail.

3. **Assistant output detail loss** (single-session-assistant -7.1%): Current prompt treats
   assistant-generated content as "verbose output." Specific details (colors, names, shift
   schedules, recommendations with attributes) get dropped.

---

## Phase 1: Observation-log format (DONE — post re-eval)

**What changed:**

- `prompt.ts`: `DISTILLATION_SYSTEM` replaced with OM-style Observer extraction instructions.
  Output format changed from `{ narrative, facts }` JSON to dated timestamped event-log text.
- `prompt.ts`: `RECURSIVE_SYSTEM` replaced with OM-style Reflector instructions that merge
  and prune observations while preserving the event-log format.
- `prompt.ts`: `distillationUser` and `recursiveUser` updated for new format.
- `prompt.ts`: `formatDistillations` updated to inject observation text directly (no markdown
  narrative+facts rendering).
- `distillation.ts`: `parseDistillationResult` replaced with `parseObservations` (string, not JSON).
  `storeDistillation` stores `observations TEXT` instead of `narrative + facts`.
- `db.ts`: Migration v2 adds `observations TEXT` column to `distillations`, drops `narrative`/`facts`.
- `eval/harness.ts`: `processNuum` updated to use observation-log format for distillation
  and context injection.

**Key preservation rules added to Observer prompt:**

- All dates in ISO format or `(meaning DATE)` annotations
- Priority tags: 🔴 user assertions/facts, 🟡 questions/context, 🟢 minor details
- Enumeratable entities with counts (weddings attended, trips taken, items purchased)
- Assistant-generated list items with distinguishing attributes per item
- State changes: "User will use X (replacing Y)"
- Role/participation: "User was a presenter" not "User attended"
- Exact quantities, measurements, percentages

## Phase 2: Temporal anchoring at read time (DONE — post re-eval)

**What changed:**

- `gradient.ts`: `addRelativeTimeToObservations(observations, currentDate)` added.
  Transforms "Date: Jan 15, 2026" → "Date: Jan 15, 2026 (5 weeks ago)".
  Adds gap markers between non-consecutive dates: "[3 weeks later]".
- `gradient.ts`: `expandInlineEstimatedDates(observations, currentDate)` added.
  Transforms "(meaning Jan 31, 2026)" → "(meaning Jan 31, 2026 - 3 weeks ago)".
  Detects past future-intent observations and adds "(likely already happened)".
- `gradient.ts`: `distilledPrefix` calls both functions when injecting observations into context.

---

## Phase 3: Cross-session entity merging (NEXT)

**Problem:** Distilling sessions independently loses enumeratable entities that span sessions.
A question like "how many weddings did I attend?" fails if each wedding was mentioned in a
separate session and the per-session distillation didn't flag them as belonging to a set.

**Plan:**

- **During observation (Observer prompt)**: Flag enumeratable entities explicitly.
  When the user mentions attending an event, buying something, meeting someone — add a
  special marker so the Reflector recognizes aggregatable items:
  `🔴 [ENTITY:event-attended] User attended Rachel+Mike's wedding (vineyard, Aug 2023)`
- **During recursive merge (Reflector prompt)**: Explicitly aggregate entity sets.
  When multiple observations share the same ENTITY tag, produce a consolidation line:
  `🔴 User attended 3 weddings total: Rachel+Mike (Aug), Emily+Sarah (Sep), Jen+Tom (Oct 8)`
- **Curator integration**: When the LTM curator encounters a recurring entity type,
  update the existing knowledge entry rather than create a new one. "Weddings attended: 3"
  becomes the durable knowledge entry, updated each session.

**Expected impact:** Partial recovery of multi-session -12.4%. The ceiling appears to be
~87% (OM's best with gpt-5-mini) since some cross-session aggregation is inherently ambiguous
after compression.

---

## Phase 4: Incremental distillation (FUTURE)

**Problem:** Nuum currently distills in batch at session end (or on urgent trigger). OM
observes continuously every ~30k tokens of new messages, keeping observations current.

**Plan:**

- Hook into `message.updated` SSE events in `index.ts` for incremental observation.
  Don't wait for session to end — observe every ~20-30 messages (~30k tokens).
- Append-only observations: new observations append to existing for that session rather
  than re-distilling everything.
- Reflection on threshold: when total observation size exceeds ~40k tokens, trigger
  `metaDistill` (recursive merge / reflection).
- This is a bigger architectural change to the distillation pipeline.

**Note:** The batch approach currently works. Incremental distillation improves latency
(observations available sooner) and quality (each batch processes less context, higher
compression ratio), but isn't blocking on correctness.

---

## What NOT to change

- **LTM curator system** — nuum's unique advantage for coding agents. OM has no equivalent
  of cross-session durable knowledge (decisions, patterns, gotchas, preferences).
- **Gradient 4-layer safety system** — more robust than OM's fixed two-block layout for
  coding agents with unpredictable tool call sizes.
- **Facts array for curator** — for LTM curator input, structured facts are still useful.
  The observation format and fact extraction for curator purposes can coexist.
- **Plugin architecture** — nuum operates as an OpenCode plugin, swappable and configurable.

---

## Key references

- Mastra OM source: https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory
- Mastra OM research: https://mastra.ai/research/observational-memory
- LongMemEval: https://arxiv.org/abs/2410.10813
- Oracle dataset: eval/data/longmemeval_oracle.json (500 questions)
- Eval harness: eval/harness.ts
- Eval judge: eval/evaluate.ts
- Results: eval/results/
