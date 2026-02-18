import type { Root } from "mdast";
import {
  serialize,
  normalize,
  inline,
  h,
  p,
  ul,
  lip,
  liph,
  strong,
  t,
  root,
} from "./markdown";

// All prompts are locked down — they are our core value offering.
// Do not make these configurable.

export const DISTILLATION_SYSTEM = `You are a memory distillation agent. Your job is to compress a conversation segment into structured output while preserving operational intelligence.

Produce a JSON object with exactly two fields:

"narrative": 1-3 sentences describing what happened. Past tense. Focus on outcomes and decisions, not the process of getting there.

"facts": An array of strings. Each fact is a specific, actionable detail the agent needs to continue working. Each fact must be self-contained (understandable without the narrative).

RULES FOR FACTS — PRESERVE:
- File paths with line numbers when relevant
- Specific values, thresholds, configuration details
- Decisions and their rationale (the "why", not just the "what")
- User preferences and stated patterns
- Error messages and their root cause + solution
- Environment details (env vars, build tools, deploy targets)
- Approaches that were tried and FAILED, with why they failed (prefix with "FAILED:")
- Anything that would require tool calls to rediscover

RULES FOR FACTS — DROP:
- The detailed back-and-forth of debugging (keep only the conclusion and any failed approaches worth remembering)
- Verbose tool output (keep only the conclusion)
- Social exchanges and acknowledgments
- Redundant restatements of the same information
- Intermediate reasoning that led to a final decision already captured

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

export function distillationUser(input: {
  priorNarrative?: string;
  messages: string;
}): string {
  const context = input.priorNarrative
    ? `Brief context for orientation (what happened before this segment — do NOT include this in your output):\n${input.priorNarrative}`
    : "This is the beginning of the session.";
  return `${context}

---
Conversation segment to distill:

${input.messages}`;
}

export const RECURSIVE_SYSTEM = `You are a memory distillation agent performing recursive compression. You are given previously distilled conversation segments. Compress them into a single higher-level distillation.

Merge related facts. Drop facts superseded by later segments (e.g. if a value was changed, keep only the final value). Keep facts about failed approaches — these prevent repeating mistakes.

Produce a JSON object with exactly two fields:

"narrative": 2-4 sentences summarizing the combined work. Higher level than individual distillations. Past tense.

"facts": An array of strings. Only the most operationally relevant facts that span across segments. Merge duplicates. Prefer facts that would be hardest to rediscover.

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

export function recursiveUser(
  distillations: Array<{ narrative: string; facts: string[] }>,
): string {
  const entries = distillations.map((d, i) => {
    const facts = d.facts.map((f) => `  - ${f}`).join("\n");
    return `Segment ${i + 1}:\nNarrative: ${d.narrative}\nFacts:\n${facts}`;
  });
  return `Distilled segments to compress (chronological order):

${entries.join("\n\n")}`;
}

export const CURATOR_SYSTEM = `You are a long-term memory curator. Your job is to extract durable knowledge from a conversation that should persist across sessions.

Focus on knowledge that will remain true and useful beyond the current task:
- User preferences and working style
- Architectural decisions and their rationale
- Project conventions and patterns
- Environment setup details
- Recurring gotchas or constraints
- Important relationships between components

Do NOT extract:
- Task-specific details (file currently being edited, current bug being fixed)
- Temporary state (current branch, in-progress work)
- Information that will change frequently

Produce a JSON array of operations:
[
  {
    "op": "create",
    "category": "decision" | "pattern" | "preference" | "architecture" | "gotcha",
    "title": "Short descriptive title",
    "content": "Detailed knowledge entry",
    "scope": "project" | "global",
    "crossProject": false
  },
  {
    "op": "update",
    "id": "existing-entry-id",
    "content": "Updated content",
    "confidence": 0.0-1.0
  },
  {
    "op": "delete",
    "id": "existing-entry-id",
    "reason": "Why this is no longer relevant"
  }
]

If nothing warrants extraction, return an empty array: []

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

export function curatorUser(input: {
  messages: string;
  existing: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
}): string {
  const existing = input.existing.length
    ? `Existing knowledge entries (you may update or delete these):\n${input.existing.map((e) => `- [${e.id}] (${e.category}) ${e.title}: ${e.content}`).join("\n")}`
    : "No existing knowledge entries.";
  return `${existing}

---
Recent conversation to extract knowledge from:

${input.messages}`;
}

// Format distillations for injection into the message context
export function formatDistillations(
  distillations: Array<{
    narrative: string;
    facts: string[];
    generation: number;
  }>,
): string {
  if (!distillations.length) return "";

  const meta = distillations.filter((d) => d.generation > 0);
  const recent = distillations.filter((d) => d.generation === 0);
  const children: Root["children"] = [h(2, "Session History")];

  if (meta.length) {
    children.push(h(3, "Earlier Work (summarized)"));
    for (const d of meta) {
      const narrative = inline(d.narrative);
      if (narrative) children.push(p(narrative));
      const facts = d.facts.map(inline).filter(Boolean);
      if (facts.length) children.push(ul(facts.map(lip)));
    }
  }

  if (recent.length) {
    children.push(h(3, "Recent Work (distilled)"));
    for (const d of recent) {
      const narrative = inline(d.narrative);
      if (narrative) children.push(p(narrative));
      const facts = d.facts.map(inline).filter(Boolean);
      if (facts.length) children.push(ul(facts.map(lip)));
    }
  }

  return serialize(root(...children));
}

export function formatKnowledge(
  entries: Array<{ category: string; title: string; content: string }>,
): string {
  if (!entries.length) return "";

  const grouped: Record<string, Array<{ title: string; content: string }>> = {};
  for (const e of entries) {
    const group = grouped[e.category] ?? (grouped[e.category] = []);
    group.push(e);
  }

  const children: Root["children"] = [h(2, "Long-term Knowledge")];
  for (const [category, items] of Object.entries(grouped)) {
    children.push(h(3, category.charAt(0).toUpperCase() + category.slice(1)));
    children.push(
      ul(
        items.map((i) =>
          liph(strong(inline(i.title)), t(": " + inline(i.content))),
        ),
      ),
    );
  }

  return serialize(root(...children));
}
