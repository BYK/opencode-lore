/**
 * Baseline implementations for the Lore eval suite.
 *
 * Each baseline takes a conversation transcript and produces a context
 * string that an LLM would use to answer questions about the session.
 *
 * Baselines:
 *   1. Tail window — keep last N tokens, drop the rest
 *   2. Compaction + tail window — LLM-summarize dropped prefix + tail
 *   3. Raw — full conversation (upper-bound reference)
 *   4. Lore context-only (ablation) — via gateway config override
 *   5. Lore memory-only (ablation) — via gateway config override
 *   6. (removed — auto-mem0 was a deprecated external baseline)
 */
import type { ConversationTurn, ContentPart } from "./types";
import type { EvalLLMClient } from "./llm-backend";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate tokens from text length (same heuristic as gradient.ts). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Render a content part to text. */
function renderContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool_use":
      return `[Tool call: ${part.name}(${JSON.stringify(part.input).slice(0, 500)})]`;
    case "tool_result":
      return `[Tool result${part.is_error ? " (error)" : ""}:\n${part.content}]`;
  }
}

/** Render a conversation turn to text. */
function renderTurn(turn: ConversationTurn): string {
  const role = turn.role === "user" ? "User" : "Assistant";
  const parts = turn.content.map(renderContentPart).join("\n");
  return `${role}:\n${parts}`;
}

/** Render an array of turns to a single text block. */
export function renderConversation(turns: ConversationTurn[]): string {
  return turns.map(renderTurn).join("\n\n---\n\n");
}

/** Estimate total tokens for an array of turns. */
function totalTokens(turns: ConversationTurn[]): number {
  return turns.reduce(
    (sum, t) => sum + (t.tokens ?? estimateTokens(renderTurn(t))),
    0,
  );
}

// ---------------------------------------------------------------------------
// Baseline 1: Tail Window
// ---------------------------------------------------------------------------

/**
 * Keep the last `budgetTokens` tokens of the conversation.
 * Everything before the cutoff is dropped entirely.
 */
export function tailWindowBaseline(
  turns: ConversationTurn[],
  budgetTokens = 80_000,
): string {
  let tailTokens = 0;
  let cutoff = turns.length;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens =
      turns[i].tokens ?? estimateTokens(renderTurn(turns[i]));
    if (tailTokens + turnTokens > budgetTokens) {
      cutoff = i + 1;
      break;
    }
    tailTokens += turnTokens;
    if (i === 0) cutoff = 0;
  }

  const droppedCount = cutoff;
  const tail = turns.slice(cutoff);

  if (droppedCount === 0) {
    return renderConversation(tail);
  }

  return (
    `[Note: ${droppedCount} earlier messages were dropped from context due to context window limits.]\n\n` +
    renderConversation(tail)
  );
}

// ---------------------------------------------------------------------------
// Baseline 2: Compaction + Tail Window
// ---------------------------------------------------------------------------

/**
 * The compaction prompt used by Claude Code and OpenCode.
 * Mirrors the actual production compaction behavior.
 */
const COMPACTION_SYSTEM = `You are a conversation summarizer. Your job is to create a detailed summary of a coding conversation that preserves all important technical details.`;

const COMPACTION_USER_TEMPLATE = `Summarize the following conversation excerpt, preserving:
- All file paths, function names, class names, and variable names mentioned
- All decisions made and their rationales
- All error messages, bug descriptions, and their fixes
- All configuration values, version numbers, and specific quantities
- The overall goal and current progress

Be detailed and specific — do not generalize. Include exact values.

Conversation to summarize:

{{conversation}}`;

/**
 * Simulate compaction: LLM-summarize the prefix that falls outside
 * the tail window, then return summary + tail.
 *
 * Iterative: when the total exceeds `compactionThreshold`, compact the prefix
 * and check again. Real tools (Claude Code) auto-compact at ~83.5% of the
 * context window, and a 400K session triggers 2-3 compaction cycles. Each
 * cycle replaces the prefix with a summary, losing more detail.
 */
export async function compactionBaseline(
  turns: ConversationTurn[],
  tailBudgetTokens: number = 80_000,
  llm: EvalLLMClient,
  modelContextWindow: number = 200_000,
): Promise<string> {
  // Match Claude Code's autoCompactThreshold: effectiveContextWindow * 0.835
  const compactionThreshold = Math.floor(
    (modelContextWindow - Math.min(32_000, modelContextWindow * 0.15)) * 0.835,
  );
  const maxCompactions = 4; // safety cap
  let currentTurns = turns;
  let compactionCount = 0;

  while (compactionCount < maxCompactions) {
    const total = totalTokens(currentTurns);

    // If everything fits within the threshold (or within the tail budget
    // on the first pass), no more compaction needed.
    if (compactionCount > 0 && total <= compactionThreshold) break;
    if (total <= tailBudgetTokens) break;

    // Find the tail window cutoff
    let tailTokens = 0;
    let cutoff = currentTurns.length;
    for (let i = currentTurns.length - 1; i >= 0; i--) {
      const turnTokens =
        currentTurns[i].tokens ?? estimateTokens(renderTurn(currentTurns[i]));
      if (tailTokens + turnTokens > tailBudgetTokens) {
        cutoff = i + 1;
        break;
      }
      tailTokens += turnTokens;
      if (i === 0) cutoff = 0;
    }

    const prefix = currentTurns.slice(0, cutoff);
    const tail = currentTurns.slice(cutoff);

    if (prefix.length === 0) break;

    // Summarize the prefix via LLM
    const prefixText = renderConversation(prefix);
    const userPrompt = COMPACTION_USER_TEMPLATE.replace(
      "{{conversation}}",
      prefixText,
    );

    const result = await llm.prompt(COMPACTION_SYSTEM, userPrompt, {
      maxTokens: 4096,
      temperature: 0,
    });

    // Replace prefix with a synthetic summary turn + keep tail
    const summaryTurn: ConversationTurn = {
      role: "assistant",
      content: [{ type: "text", text: `## Compacted Summary (pass ${compactionCount + 1})\n\n${result.text}` }],
      tokens: estimateTokens(result.text),
    };
    currentTurns = [summaryTurn, ...tail];
    compactionCount++;

    console.log(
      `  [compaction] pass ${compactionCount}: ${prefix.length} turns summarized → ${estimateTokens(result.text)} tok, ${currentTurns.length} turns remaining (${totalTokens(currentTurns)} tok)`,
    );
  }

  // Final render
  if (compactionCount === 0) {
    return renderConversation(currentTurns);
  }

  return renderConversation(currentTurns);
}

// ---------------------------------------------------------------------------
// Baseline 3: Raw Context
// ---------------------------------------------------------------------------

/**
 * Full conversation with no compression.
 * Only viable when the conversation fits in context.
 */
export function rawBaseline(turns: ConversationTurn[]): string {
  return renderConversation(turns);
}

// ---------------------------------------------------------------------------
// Ablation config builders (for gateway-based baselines)
// ---------------------------------------------------------------------------

/**
 * Lore config overrides for context-only ablation.
 * Disables knowledge/LTM/curator while keeping gradient + distillation.
 */
export function contextOnlyConfigOverrides(): Record<string, unknown> {
  return {
    knowledge: { enabled: false },
    curator: { enabled: false },
  };
}

/**
 * Lore config overrides for memory-only ablation.
 * Keeps LTM/recall/curator but disables gradient compression.
 * The distilled prefix budget is zeroed so distillations are stored
 * (for recall search) but never injected into the context window.
 */
export function memoryOnlyConfigOverrides(): Record<string, unknown> {
  return {
    budget: {
      distilled: 0,
      raw: 0.95,
    },
  };
}

// ---------------------------------------------------------------------------
// Context builder for question-answering
// ---------------------------------------------------------------------------

/**
 * Build a question-answering prompt from a context string.
 * Used by all baselines to ask eval questions.
 */
export function buildQAPrompt(
  context: string,
  question: string,
  _mode: "baseline" | "lore",
): string {
  return (
    `Here is context from a past coding session.\n\n${context}\n\n` +
    `Question: ${question}\n\n` +
    `Answer concisely and specifically. Include exact values, file paths, and names when known.`
  );
}

export const QA_SYSTEM =
  "You are answering questions about past coding sessions. " +
  "Do your best to come up with the exact and correct answer. " +
  "Use all the tools available to you to find it. " +
  "Be specific and factual — include exact file paths, error messages, " +
  "version numbers, and names when known. " +
  "If you don't have enough information, say so.";
