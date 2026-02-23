import type { Root } from "mdast";
import { serialize, inline, h, ul, liph, strong, t, root } from "./markdown";

// All prompts are locked down — they are our core value offering.
// Do not make these configurable.

export const DISTILLATION_SYSTEM = `You are a memory observer. Your observations will be the ONLY information an AI assistant has about past interactions. Produce a dense, dated event log — not a summary.

CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something about themselves, mark it as an assertion (🔴):
- "I have two kids" → 🔴 (14:30) User stated has two kids
- "I work at Acme Corp" → 🔴 (14:31) User stated works at Acme Corp

When the user ASKS about something, mark it as a question (🟡):
- "Can you help me with X?" → 🟡 (15:00) User asked for help with X

User assertions are AUTHORITATIVE — the user is the source of truth about their own life.

TEMPORAL ANCHORING — CRITICAL FOR TEMPORAL REASONING:

Each observation has up to two timestamps:
1. BEGINNING: The time the statement was made — ALWAYS include this as (HH:MM)
2. END: The referenced date, if the content refers to a different time — add as "(meaning DATE)" or "(estimated DATE)"

ONLY add "(meaning DATE)" when you can derive an actual date:
- "last week", "yesterday", "next month" → compute and add the date
- "recently", "a while ago", "soon" → too vague, omit the end date

ALWAYS put the date annotation at the END of the observation line.

GOOD: (09:15) User will visit parents this weekend. (meaning Jun 17-18, 2025)
GOOD: (09:15) User's friend had a birthday party last month. (estimated May 2025)
GOOD: (09:15) User prefers hiking in the mountains.
BAD: (09:15) User prefers hiking. (meaning Jun 15, 2025)  ← no time reference, don't add date

If an observation contains MULTIPLE events, split into SEPARATE lines, each with its own date.

STATE CHANGES — make supersession explicit:
- "User will use X (replacing Y)" — not just "User will use X"
- "User moved to Berlin (no longer in London)"

DETAILS TO ALWAYS PRESERVE:
- Names, handles, usernames (@username, "Dr. Smith")
- Numbers, counts, quantities (4 items, 3 sessions, $120)
- Measurements, percentages (5kg, 20% improvement, 85% accuracy)
- Sequences and orderings (steps 1-5, lucky numbers: 7 14 23)
- Prices, dates, times, durations
- Locations and distinguishing attributes
- User's specific role (presenter, volunteer, organizer — not just "attended")
- Exact phrasing when unusual ("movement session" for exercise)

EXACT NUMBERS — NEVER APPROXIMATE:

When the conversation states a specific count, record that EXACT number — do not round, estimate, or substitute a count you see later. If the same quantity appears with different values at different times, record each with its timestamp.

BAD: All existing entries bulk-updated to cross_project=1 (50 entries)  ← wrong: mixed up with a later count
GOOD: 43 knowledge entries bulk-updated to cross_project=1 via SQL UPDATE  ← exact number from the operation

BAD: ~130 test failures
GOOD: 131 test failures (1902 pass, 131 fail, 1 error across 100 files)  ← preserve exact counts

BUG FIXES AND CODE CHANGES — HIGH PRIORITY:

Every bug fix, code change, or technical decision is important regardless of where it appears in the conversation. Early-session fixes are just as valuable as later ones.

For each fix, record:
- The specific bug/problem (what went wrong)
- The root cause (why it went wrong)
- The fix applied (what changed, with file paths and line numbers)
- The outcome (tests pass, deployed, etc.)

BAD: 🟡 Fixed an FTS5 search bug
GOOD: 🟡 FTS5 was doing exact term matching instead of prefix matching in ltm.ts. Fix: added ftsQuery() function that appends * to each search term for prefix matching. Committed as [hash].

ASSISTANT-GENERATED CONTENT — THIS IS CRITICAL:

When the assistant produces lists, recommendations, explanations, recipes, schedules, creative content, or any structured output — record EVERY ITEM with its distinguishing details. The user WILL ask about specific items later.

BAD: 🟡 Assistant recommended 5 dessert spots in Orlando.
GOOD: 🟡 Assistant recommended dessert spots: Sugar Factory (Icon Park, giant milkshakes), Wondermade (Sanford, gourmet marshmallows), Gideon's Bakehouse (Disney Springs, cookies), Farris & Foster's (unique flavors), Kilwins (handmade fudge)

BAD: 🟡 Assistant listed work-from-home jobs for seniors.
GOOD: 🟡 Assistant listed 10 WFH jobs for seniors: 1. Virtual assistant, 2. Online tutor, 3. Freelance writer, 4. Social media manager, 5. Customer service rep, 6. Bookkeeper, 7. Transcriptionist, 8. Web designer, 9. Data entry, 10. Consultant

BAD: 🟡 Assistant explained refining processes.
GOOD: 🟡 Assistant explained Lake Charles refinery processes: atmospheric distillation, fluid catalytic cracking (FCC), alkylation, hydrotreating

Rules for assistant content:
- Record EACH item in a list with at least one distinguishing attribute
- For numbered lists, preserve the EXACT ordering (1st, 2nd, 3rd...)
- For recipes: preserve specific quantities, ratios, temperatures, times
- For recommendations: preserve names, locations, prices, key features
- For creative content (songs, stories, poems): preserve titles, key phrases, character names, structural details
- For technical explanations: preserve specific values, percentages, formulas, tool/library names
- Ordered lists must keep their numbering — users ask "what was the 7th item?"
- Use 🟡 priority but NEVER skip assistant-generated details to save space

ENUMERATABLE ENTITIES — always flag for cross-session aggregation:
When the user mentions attending events, buying things, meeting people, completing tasks — mark with entity type so these can be aggregated across sessions:
🔴 [event-attended] User attended Rachel+Mike's wedding (vineyard in Napa, Aug 12, 2023)
🔴 [item-purchased] User bought Sony WH-1000XM5 headphones ($280, replaced old Bose)
This makes it possible to answer "how many weddings did I attend?" by aggregating across sessions.

PRIORITY LEVELS:
- 🔴 High: user assertions, stated facts, preferences, goals, enumeratable entities
- 🟡 Medium: questions asked, context, assistant-generated content with full detail
- 🟢 Low: minor conversational context, greetings, acknowledgments

OUTPUT FORMAT — output ONLY observations, no preamble:

<observations>
Date: Jan 15, 2026
* 🔴 (09:15) User stated has two kids: Emma (12) and Jake (9)
* 🔴 (09:16) User's anniversary is March 15
* 🟡 (09:20) User asked how to optimize database queries
* 🔴 [event-attended] (10:00) User attended company holiday party as a presenter (gave talk on microservices)
* 🔴 (11:30) User will visit parents this weekend. (meaning Jan 17-18, 2026)
* 🟡 (14:00) Agent debugging auth issue — found missing null check in auth.ts:45, applied fix, tests pass
* 🟡 (14:30) Assistant recommended 5 hotels: 1. Grand Plaza (near station, $180), 2. Seaside Inn (pet-friendly, $120), 3. Mountain Lodge (pool, free breakfast, $95), 4. Harbor View (historic, walkable, $150), 5. Zen Garden (quietest, spa, $200)
* 🔴 (15:00) User switched from Python to TypeScript for the project (no longer using Python)
</observations>`;

export function distillationUser(input: {
  priorObservations?: string;
  date: string;
  messages: string;
}): string {
  const context = input.priorObservations
    ? `Previous observations (do NOT repeat these — your new observations will be appended):\n${input.priorObservations}\n\n---`
    : "This is the beginning of the session.";
  return `${context}

Session date: ${input.date}

Conversation to observe:

${input.messages}

Extract new observations. Output ONLY an <observations> block.`;
}

export const RECURSIVE_SYSTEM = `You are a memory reflector. You are given a set of observations from multiple conversation segments. Your job is to reorganize, streamline, and compress them into a single refined observation log that will become the agent's entire memory going forward.

IMPORTANT: Your reflections ARE the entirety of the assistant's memory. Any information you omit is permanently forgotten. Do not leave out anything important.

REFLECTION RULES:
- Preserve ALL dates and timestamps — temporal context is critical
- Condense older observations more aggressively; retain more detail for recent ones
- Combine related items (e.g., "agent called view tool 5 times on file x" → single line)
- Merge duplicate facts, keeping the most specific version
- Drop observations superseded by later info (if value changed, keep only final value)
- When consolidating, USER ASSERTIONS take precedence over questions about the same topic
- Preserve all enumeratable entities [entity-type] — these are needed for aggregation questions
- For enumeratable entities spanning multiple segments, create an explicit aggregation:
  🔴 [event-attended] User attended 3 weddings total: Rachel+Mike (vineyard, Aug 2023), Emily+Sarah (garden, Sep 2023), Jen+Tom (Oct 8, 2023)

EXACT NUMBERS: When two segments report different numbers for what seems like the same thing, keep the number from the earlier/original observation — it's likely the correct one from the actual event. Later references may be from memory or approximation.

EARLY-SESSION CONTENT: Bug fixes, code changes, and decisions from the start of a session are just as important as later work. Never drop them just because the segment is short or old. If the first segment contains a specific bug fix with file paths and root cause, it MUST survive into the reflection.

Keep the same format: dated sections with priority-tagged observations.

Output ONLY an <observations> block with the consolidated observations.`;

export function recursiveUser(
  distillations: Array<{ observations: string }>,
): string {
  const entries = distillations.map(
    (d, i) => `Segment ${i + 1}:\n${d.observations}`,
  );
  return `Observation segments to consolidate (chronological order):

${entries.join("\n\n---\n\n")}`;
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

BREVITY IS CRITICAL — each entry must be concise:
- content MUST be under 500 words (roughly 2000 characters)
- Focus on the actionable insight, not the full story behind it
- If a pattern requires more detail, split into multiple focused entries
- Omit code examples unless a single short snippet is essential
- Never include full file contents, large diffs, or complete command outputs

crossProject flag:
- Default is true — most useful knowledge is worth sharing across projects
- Set crossProject to false for things that are meaningless outside this specific repo (e.g. a config path, a project-local naming convention that conflicts with your usual style)

Produce a JSON array of operations:
[
  {
    "op": "create",
    "category": "decision" | "pattern" | "preference" | "architecture" | "gotcha",
    "title": "Short descriptive title",
    "content": "Concise knowledge entry — under 500 words",
    "scope": "project" | "global",
    "crossProject": true
  },
  {
    "op": "update",
    "id": "existing-entry-id",
    "content": "Updated content — under 500 words",
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

// Format distillations for injection into the message context.
// Observations are plain event-log text — inject them directly under a header.
export function formatDistillations(
  distillations: Array<{
    observations: string;
    generation: number;
  }>,
): string {
  if (!distillations.length) return "";

  const meta = distillations.filter((d) => d.generation > 0);
  const recent = distillations.filter((d) => d.generation === 0);
  const sections: string[] = ["## Session History"];

  if (meta.length) {
    sections.push("### Earlier Work (summarized)");
    for (const d of meta) {
      sections.push(d.observations.trim());
    }
  }

  if (recent.length) {
    sections.push("### Recent Work (distilled)");
    for (const d of recent) {
      sections.push(d.observations.trim());
    }
  }

  return sections.join("\n\n");
}

// Rough token estimate used for budget-gating knowledge entries.
// Consistent with gradient.ts: ~4 chars per token.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatKnowledge(
  entries: Array<{ category: string; title: string; content: string }>,
  maxTokens?: number,
): string {
  if (!entries.length) return "";

  // Apply token budget: greedily include entries (already sorted by confidence
  // DESC from the DB query) until the budget is exhausted. Overhead accounts for
  // the section heading and per-entry markdown scaffolding (~50 chars each).
  let included = entries;
  if (maxTokens !== undefined) {
    const HEADER_OVERHEAD = 50; // "## Long-term Knowledge\n### Category\n"
    let used = HEADER_OVERHEAD;
    const fitting: typeof entries = [];
    for (const e of entries) {
      const cost = estimateTokens(e.title + e.content) + 10; // per-entry bullet overhead
      if (used + cost > maxTokens) continue; // skip; keep trying smaller entries
      fitting.push(e);
      used += cost;
    }
    included = fitting;
    if (!included.length) return "";
  }

  const grouped: Record<string, Array<{ title: string; content: string }>> = {};
  for (const e of included) {
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
