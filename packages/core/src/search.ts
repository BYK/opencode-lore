/**
 * Centralized FTS5 search utilities for Lore.
 *
 * Provides query building, stopword filtering, and (Phase 2+) score fusion.
 * All FTS5 search callers (ltm, temporal, reflect) import from here.
 */

/**
 * Curated stopword set for FTS5 queries. These are common English words that
 * match broadly and dilute search precision when used with OR semantics.
 *
 * CRITICAL: OR without stopword filtering is catastrophic — "the OR for OR and"
 * matches every document in the corpus. Stopwords MUST be filtered before
 * building OR queries.
 *
 * This list is intentionally conservative: only includes words that are
 * genuinely content-free. Domain terms like "handle", "state", "type" are
 * NOT stopwords — they carry meaning in code/technical contexts.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // Articles & determiners
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "some",
  "each",
  "every",
  // Pronouns
  "he",
  "it",
  "me",
  "my",
  "we",
  "us",
  "or",
  "am",
  "they",
  "them",
  "their",
  "there",
  "here",
  "what",
  "which",
  "where",
  "when",
  "whom",
  // Common verbs (content-free)
  "is",
  "be",
  "do",
  "no",
  "so",
  "if",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  "are",
  "was",
  "has",
  "had",
  "not",
  "but",
  "can",
  "did",
  "for",
  "got",
  "let",
  "may",
  "our",
  "its",
  "nor",
  "yet",
  "how",
  "all",
  "any",
  "too",
  "own",
  "out",
  "why",
  "who",
  "few",
  "have",
  "been",
  "were",
  "will",
  "would",
  "could",
  "should",
  "does",
  "being",
  "also",
  // Prepositions & conjunctions
  "with",
  "from",
  "into",
  "about",
  "than",
  "over",
  "such",
  "after",
  "before",
  "between",
  // Adverbs (content-free)
  "just",
  "only",
  "very",
  "more",
  "most",
  "really",
  "already",
]);

/**
 * The sentinel value returned when a query contains no meaningful terms after
 * filtering. Callers should check for this and return a "query too vague"
 * message instead of executing an FTS5 MATCH against it.
 */
export const EMPTY_QUERY = '""';

/**
 * Filter raw query text into meaningful FTS5 tokens.
 *
 * Filtering (in order):
 * 1. Strip non-word chars (punctuation, operators — prevents FTS5 injection)
 * 2. Remove single-character tokens (contraction artifacts like "s", "t")
 * 3. Remove stopwords
 *
 * If ALL words are filtered, returns an empty array. The caller decides
 * what to do (typically returns a "query too vague" message).
 *
 * No general length filter — short but meaningful tokens like "DB", "CI",
 * "IO", "PR" are preserved. Only single chars are dropped.
 */
export function filterTerms(raw: string): string[] {
  const words = raw
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.filter(
    (w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()),
  );
}

/**
 * Build an FTS5 MATCH expression using AND semantics (implicit AND via space).
 *
 * Returns `""` (match-nothing sentinel) when no meaningful terms remain after
 * filtering. Callers should check `q === EMPTY_QUERY` and handle accordingly.
 */
export function ftsQuery(raw: string): string {
  const terms = filterTerms(raw);
  if (!terms.length) return EMPTY_QUERY;
  return terms.map((w) => `${w}*`).join(" ");
}

/**
 * Build an FTS5 MATCH expression using OR semantics.
 * Same filtering as ftsQuery(), but joins terms with OR.
 * Used as fallback when AND returns zero results.
 */
export function ftsQueryOr(raw: string): string {
  const terms = filterTerms(raw);
  if (!terms.length) return EMPTY_QUERY;
  return terms.map((w) => `${w}*`).join(" OR ");
}

// ---------------------------------------------------------------------------
// Term extraction (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Extract the top meaningful terms from text, sorted by frequency.
 *
 * Same filtering as ftsQuery: drops single chars + stopwords.
 * No general length threshold — preserves short meaningful tokens like "DB", "CI".
 *
 * Used by forSession() to build session context queries for FTS5 scoring.
 *
 * @param text   Raw text to extract terms from
 * @param limit  Max number of terms to return (default 40)
 */
export function extractTopTerms(text: string, limit = 40): string[] {
  const freq = text
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .reduce<Map<string, number>>((acc, w) => {
      acc.set(w, (acc.get(w) ?? 0) + 1);
      return acc;
    }, new Map());

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

// ---------------------------------------------------------------------------
// Score normalization & fusion (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw FTS5 BM25 rank to a 0–1 range using min-max normalization.
 *
 * FTS5 rank/bm25() values are negative (more negative = better match).
 * This converts them to 0–1 where 1 = best match in the result set.
 *
 * Used for display scores only — RRF fusion uses rank positions, not scores.
 */
export function normalizeRank(
  rank: number,
  minRank: number,
  maxRank: number,
): number {
  // All same rank → everything is equally relevant
  if (minRank === maxRank) return 1;
  // minRank is most negative (best), maxRank is least negative (worst)
  // Invert: best match → 1.0, worst → 0.0
  return (maxRank - rank) / (maxRank - minRank);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into a single ranked list.
 *
 * RRF score = Σ(1 / (k + rank_i)) for each list where the item appears.
 * k = 60 is standard (from Cormack et al., 2009; also used by QMD).
 *
 * RRF is rank-based, not score-based — raw score magnitude differences across
 * different FTS5 tables don't matter. Only relative ordering within each list.
 *
 * @param lists  Each list provides items (in ranked order) and a key function
 *               for deduplication. Items at the front of the array are rank 0.
 * @param k      Smoothing constant. Default 60.
 * @returns      Fused list sorted by RRF score descending. When items appear
 *               in multiple lists, the first occurrence's item is kept.
 */
export function reciprocalRankFusion<T>(
  lists: Array<{ items: T[]; key: (item: T) => string }>,
  k = 60,
): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.items.length; rank++) {
      const item = list.items[rank];
      const id = list.key(item);
      const rrfScore = 1 / (k + rank);
      const existing = scores.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(id, { item, score: rrfScore });
      }
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// LLM query expansion (Phase 4)
// ---------------------------------------------------------------------------

import type { createOpencodeClient } from "@opencode-ai/sdk";
import { workerSessionIDs, promptWorker } from "./worker";
import { QUERY_EXPANSION_SYSTEM } from "./prompt";
import * as log from "./log";

type Client = ReturnType<typeof createOpencodeClient>;

// Worker sessions for query expansion — keyed by parent session ID
const expansionWorkerSessions = new Map<string, string>();

async function ensureExpansionWorkerSession(
  client: Client,
  parentID: string,
): Promise<string> {
  const existing = expansionWorkerSessions.get(parentID);
  if (existing) return existing;
  const session = await client.session.create({
    body: { parentID, title: "lore query expansion" },
  });
  const id = session.data!.id;
  expansionWorkerSessions.set(parentID, id);
  workerSessionIDs.add(id);
  return id;
}

/**
 * Expand a user query into multiple search variants using the configured LLM.
 * Returns `[original, ...expanded]`. The original is always first.
 *
 * Uses a 3-second timeout — if the LLM is slow, returns only the original query.
 * Errors are caught silently (logged) and the original query is returned.
 *
 * @param client    OpenCode client for LLM calls
 * @param query     The original user query
 * @param sessionID Parent session ID (for worker session creation)
 * @param model     Optional model override
 */
export async function expandQuery(
  client: Client,
  query: string,
  sessionID: string,
  model?: { providerID: string; modelID: string },
): Promise<string[]> {
  const TIMEOUT_MS = 3000;

  try {
    const workerID = await ensureExpansionWorkerSession(client, sessionID);
    const parts = [
      {
        type: "text" as const,
        text: `${QUERY_EXPANSION_SYSTEM}\n\nInput: "${query}"`,
      },
    ];

    // Race the LLM call against a timeout
    const responseText = await Promise.race([
      promptWorker({
        client,
        workerID,
        parts,
        agent: "lore-query-expand",
        model,
        sessionMap: expansionWorkerSessions,
        sessionKey: sessionID,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);

    if (!responseText) {
      log.info("query expansion timed out or failed, using original query");
      return [query];
    }

    // Parse JSON array from response
    const cleaned = responseText
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [query];

    const expanded = parsed.filter(
      (q): q is string => typeof q === "string" && q.trim().length > 0,
    );
    if (!expanded.length) return [query];

    return [query, ...expanded.slice(0, 3)]; // cap at 3 expansions
  } catch (err) {
    log.info("query expansion failed, using original query:", err);
    return [query];
  }
}
