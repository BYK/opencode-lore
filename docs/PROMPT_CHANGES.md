# Prompt change discipline

Lore's prompts are part of the value offering and are deliberately
locked-down (`packages/core/src/prompt.ts:4-5`). They drive worker LLM
behavior whose outputs accumulate slowly into long-term memory artifacts
(distillations, knowledge entries, AGENTS.md, compaction summaries) — a
small regression here will quietly degrade Lore's memory quality across
all users for weeks before anyone notices.

This document codifies the review bar for prompt changes. It exists
because [Anthropic's April 23, 2026 postmortem][postmortem] showed that
even with multiple weeks of internal testing, a "harmless" verbosity
instruction (`"keep text between tool calls to ≤25 words"`) caused a 3%
intelligence regression on broader evals — they only caught it via an
ablation pass after users reported degradation.

[postmortem]: https://www.anthropic.com/engineering/april-23-postmortem

## What counts as a "prompt change"

Any edit to:

| Location | Used by |
|---|---|
| `packages/core/src/prompt.ts` — `DISTILLATION_SYSTEM`, `distillationUser()` | Background distillation worker |
| `packages/core/src/prompt.ts` — `RECURSIVE_SYSTEM`, `recursiveUser()` | Meta-distillation (consolidation of older distillations) |
| `packages/core/src/prompt.ts` — `CURATOR_SYSTEM`, `curatorUser()` | Knowledge curator (extracts long-term knowledge entries) |
| `packages/core/src/prompt.ts` — `CONSOLIDATION_SYSTEM`, `consolidationUser()` | Knowledge entry consolidation |
| `packages/core/src/prompt.ts` — `COMPACT_SUMMARY_TEMPLATE`, `buildCompactPrompt()` | `/compact` slash command override |
| `packages/core/src/prompt.ts` — `QUERY_EXPANSION_SYSTEM`, `queryExpansionUser()` | Recall tool query expansion |
| `packages/opencode/src/index.ts` — system transform hook (around lines 586-720) | User-facing system prompt: first-run greeting, LTM block, AGENTS.md commit reminder |
| `packages/pi/src/index.ts` — `before_agent_start` hook | User-facing system prompt (Pi extension) |
| `packages/core/src/recall.ts` — recall tool description / formatting | LLM-visible tool documentation |

It also includes any change to **how** these prompts get rendered or
which inputs they receive (e.g. tweaking `formatKnowledge()`,
changing how `messagesToText()` joins parts, altering temporal
serialization that feeds into distillation input).

## What is NOT covered here

- Snapshot-test fixture refreshes that are mechanical consequences of a
  prompt change (those should land in the same PR as the prompt edit).
- Comments inside prompt strings (zero behavioral effect, no review
  required).
- Renames of internal variables that don't appear in prompt strings.

## The review bar

A PR that changes any prompt MUST include in its description:

1. **The diff in plain text.** Not just "tightened wording" — show the
   before/after exactly. Reviewers should be able to see the new prompt
   without checking out the branch.

2. **A representative ablation.** Pick one realistic input for the
   affected worker (e.g. for `DISTILLATION_SYSTEM`: a real
   `temporal_messages` chunk from a development session; for
   `CURATOR_SYSTEM`: a finished session with mixed code/conversation).
   Run the worker once with the OLD prompt and once with the NEW prompt.
   Paste both outputs into the PR description.

3. **A token delta.** Note the input token count (system + user)
   for both prompts on the chosen input. Token-cap regressions are a
   valid reason to land a change; quietly ballooning the prompt without
   acknowledging it is not.

4. **A qualitative diff.** Two or three sentences answering: did the
   structure change? Did the level of detail change? Are there any
   instructions that could be interpreted as length-capping (which the
   April 23 incident showed costs 3% on coding evals)?

5. **A note on which artifacts will drift.** If this prompt edits a
   worker that writes to AGENTS.md or distillation rows, call out that
   existing entries will not retroactively pick up the new format —
   only entries written after the change will. List which test
   fixtures need refreshing in the same PR.

## Anti-patterns to reject

Specific prompt patterns the April 23 postmortem and Lore's own
experience flag as risky:

- **Length caps in user-facing system prompts.** `"≤25 words between
  tool calls"`, `"keep responses under 100 words"`, `"be concise"`
  applied to the agent (not the worker). These traded measurable
  intelligence for token savings in the Anthropic incident — the same
  trade is available via `temperature`, `max_tokens`, and reasoning
  effort settings without polluting the prompt. If a length cap is
  truly needed, it belongs on a worker prompt where the output structure
  is fixed (curator entries are 150-word capped on purpose), not the
  agent.

- **Per-model branching without ablation per model.** The Anthropic
  incident hit different model versions differently (Opus 4.6 vs 4.7).
  A change that's neutral on one model can regress another. If the
  prompt has any model-specific carve-outs, test all affected models.

- **Optimizations that become sticky.** The April 23 caching bug
  cleared reasoning blocks ONCE (intentional) and then kept clearing
  them every turn (bug). Any prompt-level optimization that's gated on
  session state — "if N turns deep, do X" — needs an explicit test for
  the gate flipping back off, not just for the gate firing.

- **"Internal eval looked fine" as the only check.** Anthropic noted
  that their evals at the time didn't reproduce the issue. Always pair
  programmatic evals with at least one manual ablation on a realistic
  input.

## When this is overkill

Trivial mechanical edits (typo fix, whitespace, dead-code removal
inside a prompt) don't require the full ablation. Reviewer's discretion
— if the change can plausibly affect output structure or length, do
the ablation; if not, a one-line PR description is fine. If you're not
sure, do the ablation.

## Future work

This is a process gate, not a programmatic one. We don't have
infrastructure for automated coding-quality evals on a custom prompt,
and we should not pretend otherwise. Candidates if/when we build that:

- Snapshot tests for the structural fields of curator JSON output
  (category, priority markers, length bounds).
- Snapshot tests for the section structure of `COMPACT_SUMMARY_TEMPLATE`
  outputs.
- Distillation observation-log smoke tests that pin the
  `(HH:MM)` / `🔴`/`🟡`/`🟢` priority marker format.

Land those when there's a concrete regression worth pinning, not
preemptively.
