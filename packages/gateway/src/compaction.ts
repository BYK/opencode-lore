/**
 * Compaction request detection and interception for the Lore gateway.
 *
 * Claude Code (and other clients using the same pattern) sends compaction
 * requests with a distinct system prompt and message structure. The gateway
 * detects these and runs Lore's own distillation instead of forwarding to
 * the upstream API.
 *
 * Detection mirrors the patterns documented in the upstream
 * `packages/opencode/src/agent/prompt/compaction.txt` and the
 * `experimental.session.compacting` hook.
 *
 * This module has zero dependencies on `@loreai/core` — pure detection logic.
 */
import type { GatewayRequest, GatewayResponse } from "./translate/types";

// ---------------------------------------------------------------------------
// Detection patterns — exported so tests can reference them
// ---------------------------------------------------------------------------

/** System prompt substrings that identify a compaction agent. */
export const COMPACTION_SYSTEM_PATTERNS = [
  "anchored context summarization assistant",
] as const;

/** Last user message substrings that indicate a compaction request. */
export const COMPACTION_USER_PATTERNS = [
  "anchored summary from the conversation history above",
  "Update the anchored summary below",
  "<previous-summary>",
] as const;

/**
 * Template section headers found in the `<template>` block of a compaction
 * request. A request matching ≥4 of these (with a `<template>` tag) is
 * considered a compaction request.
 */
export const COMPACTION_TEMPLATE_SECTIONS = [
  "## Goal",
  "## Progress",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "## Relevant Files",
] as const;

/** Minimum number of template sections that must match (with `<template>` tag). */
const MIN_TEMPLATE_SECTION_MATCHES = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the concatenated text content from the last user message.
 * Returns an empty string if there are no user messages or no text blocks.
 */
function lastUserText(req: GatewayRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role === "user") {
      return msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
    }
  }
  return "";
}

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Usage scaling — prevent client auto-compaction in hosted gateway scenarios
// ---------------------------------------------------------------------------

/**
 * Claude Code's auto-compact threshold for a 200K context model:
 *   effectiveContextWindow = contextWindow - min(maxOutputTokens, 20_000)
 *   autoCompactThreshold  = effectiveContextWindow - 13_000
 *
 * For 200K context → 167K.  We report at most TARGET_RATIO × 167K ≈ 150K
 * so the client's "X% until auto-compact" UI grows naturally but never
 * triggers the compaction.
 */
export const AUTOCOMPACT_THRESHOLD = 167_000;
const TARGET_RATIO = 0.9;
const MAX_REPORTED_USAGE = Math.floor(AUTOCOMPACT_THRESHOLD * TARGET_RATIO);

/**
 * Scale usage fields proportionally so the client's total
 * (`input_tokens + cache_creation + cache_read + output_tokens`) stays
 * below `MAX_REPORTED_USAGE`.
 *
 * Returns the original usage unchanged when the total is already safe.
 * Internal Lore systems (calibrate, bustRate) must use the **real** values
 * — only the client-facing response should carry the scaled values.
 */
export function scaleUsageForClient(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} {
  const total =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens;

  if (total <= MAX_REPORTED_USAGE) return usage;

  const scale = MAX_REPORTED_USAGE / total;
  return {
    input_tokens: Math.floor(usage.input_tokens * scale),
    output_tokens: Math.floor(usage.output_tokens * scale),
    ...(usage.cache_read_input_tokens != null
      ? { cache_read_input_tokens: Math.floor(usage.cache_read_input_tokens * scale) }
      : {}),
    ...(usage.cache_creation_input_tokens != null
      ? { cache_creation_input_tokens: Math.floor(usage.cache_creation_input_tokens * scale) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// isStructuralCompaction — session-aware detection
// ---------------------------------------------------------------------------

/**
 * Detect compaction via structural session signals — no prompt pattern
 * matching needed.  Works regardless of compaction prompt format changes.
 *
 * Signal: a known session previously had many messages (>10), but the
 * current request has very few (≤3) — a >50 % drop.  This is the
 * hallmark of Claude Code replacing its entire message history with a
 * compaction summary.
 */
export function isStructuralCompaction(
  req: GatewayRequest,
  priorState?: { messageCount: number },
): boolean {
  if (!priorState || priorState.messageCount <= 10) return false;
  const currCount = req.messages.length;
  return currCount <= 3 && currCount < priorState.messageCount * 0.5;
}

// ---------------------------------------------------------------------------
// isCompactionRequest — pattern-based detection (fallback)
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the request looks like a compaction request.
 *
 * Checks in order:
 *  1. System prompt contains any `COMPACTION_SYSTEM_PATTERNS` → true
 *  2. Tools empty AND last user message contains any `COMPACTION_USER_PATTERNS` → true
 *  3. Last user message has `<template>` tag AND ≥4 template sections → true
 *  4. Otherwise → false
 */
/** Detection reason returned by `detectCompactionRequest`. */
export type CompactionDetection =
  | { detected: false }
  | { detected: true; reason: "system-prompt"; pattern: string }
  | { detected: true; reason: "user-keywords"; pattern: string }
  | { detected: true; reason: "template-sections"; matchCount: number };

/**
 * Detect whether a request is a compaction request and return the reason.
 * Used by the pipeline for logging; `isCompactionRequest` is the boolean wrapper.
 */
export function detectCompactionRequest(req: GatewayRequest): CompactionDetection {
  // 1. System prompt check — strongest signal, sufficient alone
  const systemLower = req.system.toLowerCase();
  for (const pattern of COMPACTION_SYSTEM_PATTERNS) {
    if (systemLower.includes(pattern.toLowerCase())) {
      return { detected: true, reason: "system-prompt", pattern };
    }
  }

  const userText = lastUserText(req);

  // 2. No tools + user message contains compaction keywords
  if (req.tools.length === 0 && userText) {
    for (const pattern of COMPACTION_USER_PATTERNS) {
      if (userText.includes(pattern)) {
        return { detected: true, reason: "user-keywords", pattern };
      }
    }
  }

  // 3. <template> tag + ≥4 section headers
  if (userText.includes("<template>")) {
    let matches = 0;
    for (const section of COMPACTION_TEMPLATE_SECTIONS) {
      if (userText.includes(section)) matches++;
    }
    if (matches >= MIN_TEMPLATE_SECTION_MATCHES) {
      return { detected: true, reason: "template-sections", matchCount: matches };
    }
  }

  return { detected: false };
}

export function isCompactionRequest(req: GatewayRequest): boolean {
  return detectCompactionRequest(req).detected;
}

// ---------------------------------------------------------------------------
// extractPreviousSummary
// ---------------------------------------------------------------------------

/** Regex to extract content from `<previous-summary>` block (dotAll). */
const PREVIOUS_SUMMARY_RE =
  /<previous-summary>\n(.*?)\n<\/previous-summary>/s;

/**
 * Extract the content of a `<previous-summary>` block from the last user
 * message, or `undefined` if no such block exists.
 */
export function extractPreviousSummary(
  req: GatewayRequest,
): string | undefined {
  const userText = lastUserText(req);
  const match = PREVIOUS_SUMMARY_RE.exec(userText);
  return match?.[1] ?? undefined;
}

// ---------------------------------------------------------------------------
// isTitleOrSummaryRequest
// ---------------------------------------------------------------------------

/** Max system prompt length for title/summary agents (chars). */
const TITLE_SUMMARY_MAX_SYSTEM_LENGTH = 500;

/** Max number of tools for a title/summary agent (0 or very few). */
const TITLE_SUMMARY_MAX_TOOLS = 2;

/** Max message count for a title/summary agent (system extracted, so 1–2). */
const TITLE_SUMMARY_MAX_MESSAGES = 2;

/**
 * Detect non-conversation requests that should be forwarded without Lore
 * pipeline processing (title generation, summary agents, etc.).
 *
 * These have:
 *  - Empty or very few tools (≤2)
 *  - Only 1–2 messages (system already extracted to `req.system`)
 *  - Short system prompt (< 500 chars)
 *  - NOT a compaction request (handled separately)
 */
export function isTitleOrSummaryRequest(req: GatewayRequest): boolean {
  // Compaction requests are handled separately — don't classify as title/summary
  if (isCompactionRequest(req)) return false;

  return (
    req.tools.length <= TITLE_SUMMARY_MAX_TOOLS &&
    req.messages.length <= TITLE_SUMMARY_MAX_MESSAGES &&
    req.system.length < TITLE_SUMMARY_MAX_SYSTEM_LENGTH
  );
}

// ---------------------------------------------------------------------------
// buildCompactionResponse
// ---------------------------------------------------------------------------

/**
 * Build a `GatewayResponse` wrapping a compaction summary as if it were a
 * normal assistant response. The gateway translates this back to the
 * client's protocol (Anthropic/OpenAI) before sending.
 */
export function buildCompactionResponse(
  _sessionID: string,
  summary: string,
  model: string,
): GatewayResponse {
  return {
    id: `msg_lore_compact_${crypto.randomUUID().slice(0, 8)}`,
    model,
    content: [{ type: "text", text: summary }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 0,
      outputTokens: estimateTokens(summary),
    },
  };
}
