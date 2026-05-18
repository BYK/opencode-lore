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
 * Minimum cosine similarity for initial candidate retrieval.
 * Lower than the old 0.78 to cast a wider net — clustering handles
 * the precision by requiring candidates to be similar to EACH OTHER,
 * not just to the current segment.
 */
const CANDIDATE_THRESHOLD = 0.65;

/**
 * Minimum cosine similarity between two candidates to be in the same
 * cluster. Higher than CANDIDATE_THRESHOLD to ensure cluster members
 * are genuinely related, not just vaguely topical.
 */
const CLUSTER_SIMILARITY = 0.72;

/**
 * Minimum number of DISTINCT sessions in a cluster to trigger pattern
 * extraction. 3 means the behavior appeared in at least 3 sessions
 * (including the current one).
 */
const MIN_CLUSTER_SESSIONS = 3;

/** Maximum similar segments to feed to the pattern extraction LLM. */
const MAX_ECHO_SEGMENTS = 5;

/** Maximum candidates to retrieve for clustering. */
const MAX_CANDIDATES = 20;

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

  // Step 2: Search for similar distillations across the project (wide net)
  const pid = ensureProject(input.projectPath);
  const hits = embedding.vectorSearchAllDistillations(
    vec,
    pid,
    MAX_CANDIDATES,
  );

  // Step 3: Filter candidates — above lower threshold, exclude self
  const candidates = hits.filter(
    (h) =>
      h.id !== input.distillId &&
      h.similarity >= CANDIDATE_THRESHOLD,
  );

  if (candidates.length < 2) return;

  // Step 4: Cluster candidates by mutual similarity.
  // Load embeddings for candidates and group those that are similar
  // to each other — not just to the current segment.
  const cluster = clusterBySimilarity(candidates, input.sessionID);

  // Find the best cluster spanning enough distinct sessions
  if (!cluster || cluster.distinctSessions < MIN_CLUSTER_SESSIONS) return;

  log.info(
    `pattern echo: segment ${input.distillId.slice(0, 8)} cluster of ${cluster.members.length} ` +
      `across ${cluster.distinctSessions} sessions`,
  );

  // Step 5: Load the observation text of the cluster members
  const memberIds = cluster.members.slice(0, MAX_ECHO_SEGMENTS).map((e) => e.id);
  const placeholders = memberIds.map(() => "?").join(",");
  const echoRows = db()
    .query(
      `SELECT id, observations FROM distillations WHERE id IN (${placeholders})`,
    )
    .all(...memberIds) as Array<{ id: string; observations: string }>;

  if (!echoRows.length) return;

  // Step 5: Use the LLM to extract the common behavioral pattern
  const userContent = patternEchoUser({
    currentObservations: input.observations,
    echoObservations: echoRows.map((r) => r.observations),
    echoCount: cluster.distinctSessions,
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
// Clustering
// ---------------------------------------------------------------------------

type CandidateHit = { id: string; session_id: string; similarity: number };

interface Cluster {
  members: CandidateHit[];
  distinctSessions: number;
}

/**
 * Cluster candidates by mutual embedding similarity.
 *
 * Loads embeddings for all candidates, then greedily builds a cluster
 * starting from the most similar candidate. A candidate joins the cluster
 * if it has cosine similarity >= CLUSTER_SIMILARITY with at least one
 * existing cluster member.
 *
 * Returns the largest cluster that spans the most distinct sessions,
 * or null if no viable cluster is found.
 */
function clusterBySimilarity(
  candidates: CandidateHit[],
  currentSessionID: string,
): Cluster | null {
  // Load embeddings for all candidates
  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db()
    .query(
      `SELECT id, session_id, embedding FROM distillations WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
    )
    .all(...ids) as Array<{ id: string; session_id: string; embedding: Buffer }>;

  if (rows.length < 2) return null;

  // Build embedding map
  const embeddings = new Map<string, Float32Array>();
  const sessionMap = new Map<string, string>();
  for (const row of rows) {
    embeddings.set(row.id, embedding.fromBlob(row.embedding));
    sessionMap.set(row.id, row.session_id);
  }

  // Greedy clustering: start with the highest-similarity candidate,
  // then add candidates similar to any cluster member.
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity);
  const used = new Set<string>();

  let bestCluster: Cluster | null = null;

  for (const seed of sorted) {
    if (used.has(seed.id)) continue;
    const seedVec = embeddings.get(seed.id);
    if (!seedVec) continue;

    const cluster: CandidateHit[] = [seed];
    const clusterVecs: Float32Array[] = [seedVec];
    used.add(seed.id);

    // Try to add remaining candidates
    for (const candidate of sorted) {
      if (used.has(candidate.id) || candidate.id === seed.id) continue;
      const cVec = embeddings.get(candidate.id);
      if (!cVec) continue;

      // Check similarity against any cluster member
      const isRelated = clusterVecs.some(
        (cv) => embedding.cosineSimilarity(cv, cVec) >= CLUSTER_SIMILARITY,
      );

      if (isRelated) {
        cluster.push(candidate);
        clusterVecs.push(cVec);
        used.add(candidate.id);
      }
    }

    // Count distinct sessions (including current session)
    const sessions = new Set(cluster.map((c) => sessionMap.get(c.id) ?? c.session_id));
    sessions.add(currentSessionID);

    const clusterResult: Cluster = {
      members: cluster,
      distinctSessions: sessions.size,
    };

    if (
      !bestCluster ||
      clusterResult.distinctSessions > bestCluster.distinctSessions ||
      (clusterResult.distinctSessions === bestCluster.distinctSessions &&
        clusterResult.members.length > bestCluster.members.length)
    ) {
      bestCluster = clusterResult;
    }
  }

  return bestCluster;
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
