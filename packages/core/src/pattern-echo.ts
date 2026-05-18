/**
 * Vector similarity-based behavioral pattern detection.
 *
 * After each distillation segment is created, compares its embedding against
 * all previous distillation embeddings for the same project. When a segment
 * is similar to 2+ prior segments from different sessions (cosine similarity
 * >= ECHO_THRESHOLD), it indicates a repeated behavioral pattern. Uses the
 * curator LLM to extract the common pattern and create a preference entry.
 *
 * This catches implicit patterns that neither regex-based extraction
 * (pattern-extract.ts) nor instruction detection (instruction-detect.ts)
 * can find — e.g., the user always asks for tests after implementation,
 * always corrects the same style issue, always wraps DB calls in try/catch.
 */

import { db, ensureProject } from "./db";
import { config } from "./config";
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import * as log from "./log";
import { PATTERN_ECHO_SYSTEM, patternEchoUser } from "./prompt";
import type { LLMClient } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum cosine similarity to consider two distillation segments as
 * "echoes" — same behavioral shape, different instances.
 *
 * 0.78 is above the Nomic v1.5 same-domain spread ceiling (0.70 for
 * genuinely distinct entries) and below the near-duplicate zone (0.85+).
 * Distillation observations use normalized phrasing from the observer,
 * which pushes semantically similar behaviors into higher similarity.
 */
const ECHO_THRESHOLD = 0.78;

/**
 * Minimum number of prior echoing segments in DISTINCT sessions to
 * trigger pattern extraction. 2 means the behavior appeared in at least
 * 2 OTHER sessions before the current one — 3 total instances.
 */
const MIN_ECHO_COUNT = 2;

/** Maximum similar segments to feed to the pattern extraction LLM. */
const MAX_ECHO_SEGMENTS = 5;

/** Rate limit: at most 1 pattern extraction per session per 10 minutes. */
const PATTERN_COOLDOWN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limit state
// ---------------------------------------------------------------------------

const lastExtraction = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: embed a new distillation segment AND check for
 * behavioral pattern echoes across the project's distillation history.
 *
 * Replaces the plain `embedDistillation()` call at the gen-0 distillation
 * hook point. Does two jobs:
 * 1. Stores the embedding (same as embedDistillation)
 * 2. Searches for similar prior segments and triggers pattern extraction
 *
 * All errors are caught and logged — never throws.
 */
export function detectPatternEchoes(input: {
  distillId: string;
  observations: string;
  projectPath: string;
  sessionID: string;
  llm: LLMClient;
  model?: { providerID: string; modelID: string };
}): Promise<void> {
  const p = _detect(input).catch((err) => {
    log.error("pattern echo detection failed:", err);
  });
  return p;
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function _detect(input: {
  distillId: string;
  observations: string;
  projectPath: string;
  sessionID: string;
  llm: LLMClient;
  model?: { providerID: string; modelID: string };
}): Promise<void> {
  // Rate limit check
  const lastTime = lastExtraction.get(input.sessionID) ?? 0;
  if (Date.now() - lastTime < PATTERN_COOLDOWN_MS) return;

  // Step 1: Embed the new distillation (awaited, not fire-and-forget)
  const [vec] = await embedding.embed([input.observations], "document");
  db()
    .query("UPDATE distillations SET embedding = ? WHERE id = ?")
    .run(embedding.toBlob(vec), input.distillId);

  // Step 2: Search for similar distillations across the project
  const pid = ensureProject(input.projectPath);
  const hits = embedding.vectorSearchAllDistillations(
    vec,
    pid,
    MAX_ECHO_SEGMENTS + 10,
  );

  // Step 3: Filter to echoes — above threshold, exclude self and same session
  const echoes = hits.filter(
    (h) =>
      h.id !== input.distillId &&
      h.session_id !== input.sessionID &&
      h.similarity >= ECHO_THRESHOLD,
  );

  // Count distinct sessions
  const distinctSessions = new Set(echoes.map((e) => e.session_id));
  if (distinctSessions.size < MIN_ECHO_COUNT) return;

  log.info(
    `pattern echo: segment ${input.distillId.slice(0, 8)} has ${echoes.length} echoes ` +
      `across ${distinctSessions.size} sessions (threshold: ${ECHO_THRESHOLD})`,
  );

  // Step 4: Load the observation text of the echoing segments
  const echoIds = echoes.slice(0, MAX_ECHO_SEGMENTS).map((e) => e.id);
  const placeholders = echoIds.map(() => "?").join(",");
  const echoRows = db()
    .query(
      `SELECT id, observations FROM distillations WHERE id IN (${placeholders})`,
    )
    .all(...echoIds) as Array<{ id: string; observations: string }>;

  if (!echoRows.length) return;

  // Step 5: Use the LLM to extract the common behavioral pattern
  const userContent = patternEchoUser({
    currentObservations: input.observations,
    echoObservations: echoRows.map((r) => r.observations),
    echoCount: distinctSessions.size,
  });

  const model = input.model ?? config().model;
  const responseText = await input.llm.prompt(
    PATTERN_ECHO_SYSTEM,
    userContent,
    {
      model,
      workerID: "lore-pattern-echo",
      thinking: false,
      sessionID: input.sessionID,
      maxTokens: 512,
    },
  );

  if (!responseText) return;

  // Step 6: Parse response and create preference entry
  const pattern = parsePatternResponse(responseText);
  if (!pattern) return;

  try {
    ltm.create({
      projectPath: input.projectPath,
      category: "preference",
      title: pattern.title,
      content: pattern.content,
      session: input.sessionID,
      scope: "project",
      confidence: 0.8, // moderate — auto-extracted, not user-stated
    });
    log.info(`pattern echo created preference: "${pattern.title}"`);
    lastExtraction.set(input.sessionID, Date.now());
  } catch {
    // ltm.create() dedup guard handles duplicates — swallow
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

type PatternResponse = { title: string; content: string };

function parsePatternResponse(text: string): PatternResponse | null {
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");

  // Check for explicit "null" response
  if (cleaned === "null" || cleaned === "null\n") return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.title === "string" &&
      typeof parsed.content === "string" &&
      parsed.title.length > 5 &&
      parsed.content.length > 10
    ) {
      return {
        title: parsed.title.slice(0, 200),
        content: parsed.content.slice(0, 1200),
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}
