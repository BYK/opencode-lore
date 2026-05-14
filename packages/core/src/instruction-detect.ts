/**
 * Cross-session repeated-instruction detection.
 *
 * Identifies instruction-like user messages in the current session
 * and searches for similar instructions in prior sessions using both
 * embedding-based vector search (semantic similarity) and FTS5 (exact terms).
 *
 * When an instruction appears in N+ prior sessions, it's flagged as a
 * strong LTM candidate and formatted as additional context for the curator.
 *
 * This module does NOT auto-create knowledge entries — it augments the
 * curator's input so the LLM can make the final judgment call on whether
 * a repeated instruction warrants a persistent preference entry.
 */

import { db, ensureProject } from "./db";
import * as temporal from "./temporal";
import * as embedding from "./embedding";
import { filterTerms, ftsQueryOr, EMPTY_QUERY } from "./search";
import * as log from "./log";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum distinct prior sessions to consider an instruction "repeated". */
const DEFAULT_REPETITION_THRESHOLD = 2;

/** Minimum cosine similarity for a vector search hit to count. */
const VECTOR_SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of instruction candidates to process per curation run. */
const MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Instruction candidate extraction
// ---------------------------------------------------------------------------

/**
 * Patterns that identify instruction-like language in raw user messages.
 * These are intentionally broader than the distillation patterns in
 * pattern-extract.ts because they match the user's raw words, not the
 * observer's normalized phrasing.
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\balways\b (.{10,80}?)(?:\.|,|!|$)/gi,
  /\bnever\b (.{10,80}?)(?:\.|,|!|$)/gi,
  /\bmake sure to (.{10,80}?)(?:\.|,|!|$)/gi,
  /\bdon'?t forget (?:to )?(.{10,80}?)(?:\.|,|!|$)/gi,
  /\bplease (?:always |make sure (?:to )?)(.{10,80}?)(?:\.|,|!|$)/gi,
  /\bI (?:want|need|prefer|expect) (?:you to )?(.{10,80}?)(?:\.|,|!|$)/gi,
];

export type InstructionCandidate = {
  /** The matched instruction text. */
  text: string;
  /** Session this candidate was found in. */
  sessionID: string;
};

export type RepeatedInstruction = {
  /** The instruction text from the current session. */
  instruction: string;
  /** Number of distinct prior sessions containing similar instructions. */
  priorSessionCount: number;
};

/**
 * Extract instruction-like phrases from user messages.
 * Scans raw user message content for instruction keywords and returns
 * deduplicated candidates.
 */
export function extractInstructionCandidates(
  messages: Array<{ role: string; content: string; session_id: string }>,
): InstructionCandidate[] {
  const candidates: InstructionCandidate[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "user") continue;

    for (const pattern of INSTRUCTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpMatchArray | null;
      while ((match = pattern.exec(msg.content)) !== null) {
        const text = match[1]?.trim();
        if (!text || text.length < 10) continue;

        // Dedup by lowercased text within this extraction
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          text,
          sessionID: msg.session_id,
        });

        // Cap total candidates to bound search cost
        if (candidates.length >= MAX_CANDIDATES) return candidates;
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Cross-session search
// ---------------------------------------------------------------------------

/**
 * Search for similar instructions in OTHER sessions via distillation
 * embeddings (semantic) and FTS5 (keyword). Returns instructions that
 * appear in >= threshold prior sessions.
 */
export async function findRepeatedInstructions(input: {
  projectPath: string;
  currentSessionID: string;
  candidates: InstructionCandidate[];
  threshold?: number;
}): Promise<RepeatedInstruction[]> {
  const threshold = input.threshold ?? DEFAULT_REPETITION_THRESHOLD;
  if (!input.candidates.length) return [];

  const pid = ensureProject(input.projectPath);

  // Batch-embed all candidate texts in a single call (1×RTT instead of N×RTT)
  let candidateEmbeddings: Float32Array[] = [];
  if (embedding.isAvailable()) {
    try {
      candidateEmbeddings = await embedding.embed(
        input.candidates.map((c) => c.text),
        "query",
      );
    } catch (err) {
      log.warn("instruction-detect: batch embedding failed:", err);
    }
  }

  const results: RepeatedInstruction[] = [];

  for (let i = 0; i < input.candidates.length; i++) {
    const candidate = input.candidates[i];
    const sessionIDs = new Set<string>();

    // Path A: Vector search (when embeddings succeeded)
    if (candidateEmbeddings.length > i) {
      const hits = embedding.vectorSearchAllDistillations(candidateEmbeddings[i], pid, 20);
      for (const hit of hits) {
        if (
          hit.similarity >= VECTOR_SIMILARITY_THRESHOLD &&
          hit.session_id !== input.currentSessionID
        ) {
          sessionIDs.add(hit.session_id);
        }
      }
    }

    // Path B: FTS fallback (always runs to complement vector search)
    const terms = filterTerms(candidate.text);
    if (terms.length >= 2) {
      // Cap at 5 terms to keep queries focused
      const searchText = terms.slice(0, 5).join(" ");
      const ftsHits = searchDistillationsFTS(pid, searchText);
      for (const hit of ftsHits) {
        if (hit.session_id !== input.currentSessionID) {
          sessionIDs.add(hit.session_id);
        }
      }
    }

    if (sessionIDs.size >= threshold) {
      results.push({
        instruction: candidate.text,
        priorSessionCount: sessionIDs.size,
      });
    }
  }

  return results;
}

/**
 * Simple FTS5 search over distillation observations, returning session_id
 * for cross-session counting. Searches all distillations (including archived).
 *
 * Uses OR semantics — we want to find any distillation mentioning any of
 * the instruction's key terms, since paraphrased instructions may share
 * only some terms. This is a recall-oriented search (find all possible
 * matches), not a precision-oriented one.
 *
 * @param projectId  The resolved project ID (from ensureProject).
 * @param rawQuery   Raw search text — will be converted to OR-based FTS expression.
 */
function searchDistillationsFTS(
  projectId: string,
  rawQuery: string,
): Array<{ id: string; session_id: string }> {
  const matchExpr = ftsQueryOr(rawQuery);
  if (matchExpr === EMPTY_QUERY) return [];

  const sql = `SELECT d.id, d.session_id
     FROM distillation_fts f
     CROSS JOIN distillations d ON d.rowid = f.rowid
     WHERE distillation_fts MATCH ?
     AND d.project_id = ?
     ORDER BY rank LIMIT 30`;

  try {
    return db().query(sql).all(matchExpr, projectId) as Array<{
      id: string;
      session_id: string;
    }>;
  } catch (err) {
    log.warn("instruction-detect: FTS search failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Curator context formatting
// ---------------------------------------------------------------------------

/**
 * Format repeated instructions as additional context for the curator prompt.
 * Returns empty string if no repeated instructions found.
 */
export function formatForCurator(instructions: RepeatedInstruction[]): string {
  if (!instructions.length) return "";

  const lines = instructions.map(
    (i) =>
      `- "${i.instruction}" (seen in ${i.priorSessionCount} prior session${i.priorSessionCount !== 1 ? "s" : ""})`,
  );

  return `\n\n---\nCROSS-SESSION REPEATED INSTRUCTIONS (high-confidence preference candidates):\nThe following user instructions have appeared in multiple prior sessions. These are strong candidates for "preference" entries:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Full detection pipeline: extract candidates from current session →
 * search for repetitions across other sessions → format for curator.
 *
 * Returns a string to append to the curator's user prompt, or "" if
 * nothing was found. Safe to call even when embeddings are unavailable
 * (falls back to FTS-only).
 */
export async function detectAndFormat(input: {
  projectPath: string;
  sessionID: string;
  threshold?: number;
}): Promise<string> {
  const messages = temporal.bySession(input.projectPath, input.sessionID);
  const candidates = extractInstructionCandidates(messages);
  if (!candidates.length) return "";

  const repeated = await findRepeatedInstructions({
    projectPath: input.projectPath,
    currentSessionID: input.sessionID,
    candidates,
    threshold: input.threshold,
  });

  if (repeated.length) {
    log.info(
      `instruction-detect: ${repeated.length} repeated instruction(s) found across sessions`,
    );
  }

  return formatForCurator(repeated);
}
