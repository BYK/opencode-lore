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
function filterTerms(raw: string): string[] {
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
