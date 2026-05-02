import { db, ensureProject } from "./db";
import { config } from "./config";
import * as temporal from "./temporal";
import { CHUNK_TERMINATOR } from "./temporal";
import * as embedding from "./embedding";
import * as log from "./log";
import {
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
} from "./prompt";
import { needsUrgentDistillation, toolStripAnnotation } from "./gradient";
import { workerSessionIDs } from "./worker";
import type { LLMClient } from "./types";

// Re-export for backwards compat — index.ts and others may still import from here.
export { workerSessionIDs };

type TemporalMessage = temporal.TemporalMessage;

/**
 * Compression health ratio: k / √N.
 *
 * k = distilled token count, N = source token count.
 * Values < 1.0 signal likely lossy compression (below the square-root
 * boundary). Values > 1.0 signal relatively faithful compression.
 *
 * Based on the "LLM Context Square Root Theory" heuristic from
 * D7x7z49/llm-context-idea. The specific threshold is unvalidated —
 * use as a diagnostic signal, not a hard gate.
 */
export function compressionRatio(
  distilledTokens: number,
  sourceTokens: number,
): number {
  if (sourceTokens <= 0) return 0;
  return distilledTokens / Math.sqrt(sourceTokens);
}

/**
 * Segment detection: group related messages into distillation-sized chunks.
 *
 * When the message count exceeds `maxSegment`, prefers splitting at the
 * largest inter-message time gap (if it's ≥ 3× the median gap) to respect
 * natural conversation boundaries. Falls back to count-based splitting at
 * `maxSegment` when timestamps are uniform.
 *
 * Trailing segments with < 3 messages are merged into the previous segment
 * to avoid tiny distillation inputs with too little context.
 *
 * Exported for testing; `run()` is the production caller.
 */
export function detectSegments(
  messages: TemporalMessage[],
  maxSegment: number,
): TemporalMessage[][] {
  if (messages.length <= maxSegment) return [messages];
  return splitSegments(messages, maxSegment);
}

/** Minimum segment size — segments smaller than this get merged. */
const MIN_SEGMENT = 3;

/**
 * Multiplier for the median gap threshold: a time gap must be at least
 * this many times the median gap to be used as a split point.
 */
const GAP_THRESHOLD_MULTIPLIER = 3;

function splitSegments(
  messages: TemporalMessage[],
  maxSegment: number,
): TemporalMessage[][] {
  if (messages.length <= maxSegment) return [messages];

  // Find the split point: prefer the largest time gap if it's significant
  const splitIdx = findSplitIndex(messages, maxSegment);

  const left = messages.slice(0, splitIdx);
  const right = messages.slice(splitIdx);

  // Recurse on both halves
  const result = splitSegments(left, maxSegment);

  if (right.length < MIN_SEGMENT) {
    // Merge tiny trailing segment into the last segment
    result[result.length - 1].push(...right);
  } else {
    result.push(...splitSegments(right, maxSegment));
  }

  return result;
}

/**
 * Choose where to split an oversized message array.
 *
 * If there's a time gap ≥ 3× the median gap AND it falls within a range
 * that would produce segments of at least MIN_SEGMENT size, use it.
 * Otherwise fall back to the count-based boundary at `maxSegment`.
 */
function findSplitIndex(
  messages: TemporalMessage[],
  maxSegment: number,
): number {
  // Compute consecutive time gaps
  const gaps: Array<{ index: number; gap: number }> = [];
  for (let i = 1; i < messages.length; i++) {
    gaps.push({
      index: i,
      gap: messages[i].created_at - messages[i - 1].created_at,
    });
  }

  if (gaps.length === 0) return maxSegment;

  // Find median gap
  const sortedGaps = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

  // Find the largest gap that would produce viable segments (≥ MIN_SEGMENT on each side)
  let bestGap = { index: -1, gap: 0 };
  for (const g of gaps) {
    if (
      g.gap > bestGap.gap &&
      g.index >= MIN_SEGMENT &&
      messages.length - g.index >= MIN_SEGMENT
    ) {
      bestGap = g;
    }
  }

  // Use the time gap if it's significantly larger than median
  if (bestGap.index > 0 && bestGap.gap >= medianGap * GAP_THRESHOLD_MULTIPLIER) {
    return bestGap.index;
  }

  // Fall back to count-based splitting
  return maxSegment;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// Chunk separator written by `temporal.partsToText` and recovered by the
// reader below. As of F3b, chunks are joined with `"\n" + CHUNK_TERMINATOR`
// — the `\x1f` (Unit Separator) is non-word so FTS5 ignores it, and it
// cannot legitimately appear in normal content, so the boundary is
// unambiguous regardless of payload contents.
//
// The migration in db.ts (version 11) rewrote pre-F3b rows to the new
// format, so every `temporal_messages.content` value now uses this
// separator. Before F3b the structural parser used a heuristic regex
// over `\n` boundaries which had two ambiguity directions
// (trailing-text swallow + embedded-envelope fabrication); both are
// gone for migrated and new rows.
const CHUNK_SEPARATOR = "\n" + CHUNK_TERMINATOR;

/**
 * Truncate tool outputs within a `TemporalMessage.content` string (produced
 * by `temporal.partsToText`). Plain text and `[reasoning]` chunks pass
 * through untouched; only `[tool:<name>] <payload>` envelopes whose payload
 * exceeds `maxChars` are replaced with a compact `toolStripAnnotation(...)`
 * marker preserving line count, error flag, and file paths.
 *
 * Annotation matches the style used by the runtime gradient so the
 * distillation LLM sees the same affordance it sees during live turns.
 *
 * Exported primarily for tests. If future renderers need the same
 * semantics (e.g. a recall-time preview), they can reuse this.
 */
export function truncateToolOutputsInContent(
  content: string,
  maxChars: number,
): string {
  if (maxChars <= 0 || content.length === 0) return content;

  // Fast path: a row with no chunk terminator is single-chunk content.
  // (After the F3b migration, this only happens for messages with exactly
  // one part — including all user messages, single-text assistant
  // responses, and standalone tool outputs.) Truncate as one chunk if
  // it's a tool envelope.
  if (content.indexOf(CHUNK_TERMINATOR) === -1) {
    return truncateSingleChunk(content, maxChars);
  }

  const chunks = content.split(CHUNK_SEPARATOR);
  let anyToolChunk = false;
  for (const c of chunks) {
    if (c.startsWith("[tool:")) {
      anyToolChunk = true;
      break;
    }
  }
  if (!anyToolChunk) return content;

  const out = chunks.map((chunk) => truncateSingleChunk(chunk, maxChars));
  return out.join(CHUNK_SEPARATOR);
}

// Truncate a single chunk if it's an oversized [tool:<name>] envelope.
// Returns the chunk unchanged if it's plain text, [reasoning], or a tool
// chunk under the cap. Helper used by both the multi-chunk path and the
// single-chunk fast path.
function truncateSingleChunk(chunk: string, maxChars: number): string {
  if (!chunk.startsWith("[tool:")) return chunk;
  const closeBracket = chunk.indexOf("] ");
  if (closeBracket < 0) return chunk; // malformed; leave alone
  const toolName = chunk.slice(6, closeBracket); // 6 = "[tool:".length
  const payload = chunk.slice(closeBracket + 2);
  if (payload.length <= maxChars) return chunk;
  return `[tool:${toolName}] ${toolStripAnnotation(toolName, payload)}`;
}

/**
 * Render a sequence of TemporalMessages as a single string for the distillation
 * LLM. User messages pass through verbatim; assistant and tool messages have
 * oversized tool outputs truncated via {@link truncateToolOutputsInContent}.
 *
 * Exported so tests can verify truncation on realistic message fixtures without
 * spinning up a full distillSegment round trip.
 */
export function messagesToText(
  messages: TemporalMessage[],
  toolOutputMaxChars?: number,
): string {
  const cap = toolOutputMaxChars ?? config().distillation.toolOutputMaxChars;
  return messages
    .map((m) => {
      // User text is always signal — never truncate.
      const body =
        m.role === "user" ? m.content : truncateToolOutputsInContent(m.content, cap);
      return `[${m.role}] (${formatTime(m.created_at)}) ${body}`;
    })
    .join("\n\n");
}

type DistillationResult = {
  observations: string;
};

function parseDistillationResult(text: string): DistillationResult | null {
  // Extract content from <observations>...</observations> block
  const match = text.match(/<observations>([\s\S]*?)<\/observations>/i);
  const observations = match ? match[1].trim() : text.trim();
  if (!observations) return null;
  return { observations };
}

// Get the most recent observations for context
function latestObservations(
  projectPath: string,
  sessionID: string,
): string | undefined {
  const pid = ensureProject(projectPath);
  const row = db()
    .query(
      "SELECT observations FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(pid, sessionID) as { observations: string } | null;
  return row?.observations || undefined;
}

/**
 * Return the most recent gen>0 (meta) distillation observations for this
 * session, or undefined when none exists. Used by `metaDistill` as the
 * `<previous-meta-summary>` anchor on second-and-later consolidation rounds:
 * the LLM updates the prior meta in place rather than re-deriving from
 * scratch.
 *
 * Filters on `generation > 0` explicitly — gen-0 rows are raw segment
 * observations and aren't a suitable anchor (same constraint that motivated
 * the F1b SDK live-read for /compact summaries).
 *
 * Exported primarily for tests; `metaDistill` is the only production caller.
 */
export function latestMetaObservations(
  projectPath: string,
  sessionID: string,
): string | undefined {
  return latestMeta(projectPath, sessionID)?.observations;
}

/**
 * Internal: like `latestMetaObservations` but also returns the generation
 * number, so `metaDistill` can derive the next gen number for the new row.
 */
function latestMeta(
  projectPath: string,
  sessionID: string,
): { observations: string; generation: number } | undefined {
  const pid = ensureProject(projectPath);
  const row = db()
    .query(
      `SELECT observations, generation FROM distillations
       WHERE project_id = ? AND session_id = ? AND generation > 0
       ORDER BY generation DESC, created_at DESC LIMIT 1`,
    )
    .get(pid, sessionID) as
    | { observations: string; generation: number }
    | null;
  if (!row || !row.observations) return undefined;
  return row;
}

/** Safely parse the source_ids JSON column. Defaults to [] on corrupt data. */
export function parseSourceIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    log.warn("corrupt source_ids in distillation, defaulting to []");
    return [];
  }
}

export type Distillation = {
  id: string;
  project_id: string;
  session_id: string;
  observations: string;
  source_ids: string[];
  generation: number;
  token_count: number;
  created_at: number;
};

/**
 * Load distillations for a session, oldest first.
 *
 * By default (`includeArchived = false`) skips rows that have been archived
 * by `archiveDistillations` — typically gen-0 segments that were already
 * consolidated into a gen>0 meta. This honors the docstring contract that
 * archived rows are "excluded from the in-context prefix."
 *
 * Pre-F2, this function did NOT filter `archived` and so leaked merged
 * gen-0 rows into `/compact` and overflow-recovery prompts alongside the
 * meta that consolidated them. The default-false behavior fixes that
 * divergence; `includeArchived: true` preserves the legacy shape for
 * rare callers that explicitly want all rows.
 */
export function loadForSession(
  projectPath: string,
  sessionID: string,
  includeArchived = false,
): Distillation[] {
  const pid = ensureProject(projectPath);
  const sql = includeArchived
    ? "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC"
    : "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at FROM distillations WHERE project_id = ? AND session_id = ? AND archived = 0 ORDER BY created_at ASC";
  const rows = db()
    .query(sql)
    .all(pid, sessionID) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    observations: string;
    source_ids: string;
    generation: number;
    token_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    ...r,
    source_ids: parseSourceIds(r.source_ids),
  }));
}

function storeDistillation(input: {
  projectPath: string;
  sessionID: string;
  observations: string;
  sourceIDs: string[];
  generation: number;
}): string {
  const pid = ensureProject(input.projectPath);
  const id = crypto.randomUUID();
  const sourceJson = JSON.stringify(input.sourceIDs);
  const tokens = Math.ceil(input.observations.length / 3);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pid,
      input.sessionID,
      "", // legacy column — kept for schema compat
      "[]", // legacy column — kept for schema compat
      input.observations,
      sourceJson,
      input.generation,
      tokens,
      Date.now(),
    );
  return id;
}

// Count non-archived gen-0 distillations — these are the ones awaiting
// meta-distillation. Archived gen-0 entries have already been consolidated.
function gen0Count(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  return (
    db()
      .query(
        "SELECT COUNT(*) as count FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 AND archived = 0",
      )
      .get(pid, sessionID) as { count: number }
  ).count;
}

// Load non-archived gen-0 distillations for meta-distillation input.
function loadGen0(projectPath: string, sessionID: string): Distillation[] {
  const pid = ensureProject(projectPath);
  const rows = db()
    .query(
      "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 AND archived = 0 ORDER BY created_at ASC",
    )
    .all(pid, sessionID) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    observations: string;
    source_ids: string;
    generation: number;
    token_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    ...r,
    source_ids: parseSourceIds(r.source_ids),
  }));
}

// Archive distillations instead of deleting them. Archived entries are
// excluded from the in-context prefix (`gradient.loadDistillations` filters
// `archived = 0`) and from `loadForSession`'s default path (post-F2). They
// remain searchable via BM25 recall (`search.ts` does not filter archived);
// vector recall (`embedding.ts`) skips them via `WHERE archived = 0`. This
// preserves a detailed "zoom-in" layer beneath the compressed gen-1 summary
// for BM25 callers while keeping the in-context prefix lean.
// Inspired by Cartridges (Eyuboglu et al., 2025): independently compressed
// representations remain composable and queryable after consolidation.
// Reference: https://arxiv.org/abs/2501.17390
function archiveDistillations(ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db()
    .query(
      `UPDATE distillations SET archived = 1 WHERE id IN (${placeholders})`,
    )
    .run(...ids);
}

// Reset messages that were marked distilled by a previous format/run but aren't
// covered by any current distillation. This happens when distillations are deleted
// (e.g., format migration from v1 to v2) but the temporal messages keep distilled=1.
function resetOrphans(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  // Collect all message IDs referenced by existing distillations
  const rows = db()
    .query(
      "SELECT source_ids FROM distillations WHERE project_id = ? AND session_id = ?",
    )
    .all(pid, sessionID) as Array<{ source_ids: string }>;
  const covered = new Set<string>();
  for (const r of rows) {
    for (const id of parseSourceIds(r.source_ids)) covered.add(id);
  }
  if (rows.length === 0) {
    // No distillations at all — reset everything to undistilled
    const result = db()
      .query(
        "UPDATE temporal_messages SET distilled = 0 WHERE project_id = ? AND session_id = ? AND distilled = 1",
      )
      .run(pid, sessionID);
    // node:sqlite returns `changes` as `number | bigint`; bun:sqlite returns `number`.
    // Coerce to number — SQLite will never return a row count > 2^53.
    return Number(result.changes);
  }
  // Find orphans: marked distilled but not in any source_ids
  const distilled = db()
    .query(
      "SELECT id FROM temporal_messages WHERE project_id = ? AND session_id = ? AND distilled = 1",
    )
    .all(pid, sessionID) as Array<{ id: string }>;
  const orphans = distilled.filter((m) => !covered.has(m.id)).map((m) => m.id);
  if (!orphans.length) return 0;
  // Reset in batches to avoid SQLite parameter limit
  const batch = 500;
  for (let i = 0; i < orphans.length; i += batch) {
    const chunk = orphans.slice(i, i + batch);
    const placeholders = chunk.map(() => "?").join(",");
    db()
      .query(
        `UPDATE temporal_messages SET distilled = 0 WHERE id IN (${placeholders})`,
      )
      .run(...chunk);
  }
  return orphans.length;
}

// Main distillation entry point — called on session.idle or when urgent
export async function run(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  /** Skip minMessages threshold check — distill whatever is pending */
  force?: boolean;
}): Promise<{ rounds: number; distilled: number }> {
  // Reset orphaned messages (marked distilled by a deleted/migrated distillation)
  const orphans = resetOrphans(input.projectPath, input.sessionID);
  if (orphans > 0) {
    log.info(
      `Reset ${orphans} orphaned messages for re-observation`,
    );
  }

  const cfg = config();
  const maxRounds = 3;
  let rounds = 0;
  let distilled = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Check if there are enough undistilled messages
    const pending = temporal.undistilled(input.projectPath, input.sessionID);
    if (
      !input.force &&
      pending.length < cfg.distillation.minMessages &&
      round === 0
    )
      break;

    if (pending.length > 0) {
      const segments = detectSegments(pending, cfg.distillation.maxSegment);
      for (const segment of segments) {
        const result = await distillSegment({
          llm: input.llm,
          projectPath: input.projectPath,
          sessionID: input.sessionID,
          messages: segment,
          model: input.model,
        });
        if (result) {
          distilled += segment.length;
          rounds++;
        }
      }
    }

    // Check if meta-distillation is needed
    if (
      gen0Count(input.projectPath, input.sessionID) >=
      cfg.distillation.metaThreshold
    ) {
      await metaDistill({
        llm: input.llm,
        projectPath: input.projectPath,
        sessionID: input.sessionID,
        model: input.model,
      });
      rounds++;
    }

    // Check if we still need urgent distillation
    if (!needsUrgentDistillation()) break;
  }

  return { rounds, distilled };
}

async function distillSegment(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  messages: TemporalMessage[];
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const prior = latestObservations(input.projectPath, input.sessionID);
  const text = messagesToText(input.messages);
  // Derive session date from first message timestamp
  const first = input.messages[0];
  const date = first
    ? new Date(first.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "unknown date";
  const userContent = distillationUser({
    priorObservations: prior,
    date,
    messages: text,
  });

  const model = input.model ?? config().model;
  const responseText = await input.llm.prompt(
    DISTILLATION_SYSTEM,
    userContent,
    { model, workerID: "lore-distill" },
  );
  if (!responseText) return null;

  const result = parseDistillationResult(responseText);
  if (!result) return null;

  const distillId = storeDistillation({
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    observations: result.observations,
    sourceIDs: input.messages.map((m) => m.id),
    generation: 0,
  });
  temporal.markDistilled(input.messages.map((m) => m.id));

  // Diagnostic: log compression health and temporal clustering metrics.
  // R_compression (k/√N): < 1.0 signals likely lossy distillation.
  // C_norm: 0 = uniform timestamps, 1 = dominated by distant past.
  const distilledTokens = Math.ceil(result.observations.length / 3);
  const sourceTokens = input.messages.reduce((sum, m) => sum + m.tokens, 0);
  const rComp = compressionRatio(distilledTokens, sourceTokens);
  const cNorm = temporal.temporalCnorm(input.messages.map((m) => m.created_at));
  log.info(
    `distill segment: ${input.messages.length} msgs, ` +
      `${sourceTokens}→${distilledTokens} tokens, ` +
      `R=${rComp.toFixed(2)}, C_norm=${cNorm.toFixed(3)}`,
  );

  // Fire-and-forget: embed the distillation for vector search
  if (embedding.isAvailable()) {
    embedding.embedDistillation(distillId, result.observations);
  }

  return result;
}

/**
 * Consolidate a session's gen-0 distillation segments into a higher-generation
 * meta-distillation. On second-and-later rounds, anchors on the prior meta
 * via `<previous-meta-summary>` so the LLM updates in place rather than
 * re-deriving from scratch.
 *
 * Exported for tests; `run()` is the production entry point.
 */
export async function metaDistill(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const existing = loadGen0(input.projectPath, input.sessionID);

  // F2 anchor: when a prior gen>0 meta exists for this session, feed it back
  // as <previous-meta-summary> so the LLM updates in place rather than
  // re-deriving from scratch. Mirrors upstream OpenCode's <previous-summary>
  // anchoring at compaction.ts:121-132. The `loadGen0` query already filters
  // archived rows, so `existing` only contains gen-0 distillations created
  // since the last meta-distill — no overlap with the anchor body.
  const priorMeta = latestMeta(input.projectPath, input.sessionID);

  // Threshold: first meta needs ≥3 gen-0 segments to consolidate. Subsequent
  // anchored metas only need ≥1 new gen-0 since the prior meta already covers
  // earlier history; without this distinction, every meta-distill round would
  // need a fresh pile of segments and we'd lose the incremental-update benefit.
  if (priorMeta) {
    if (existing.length === 0) return null;
  } else {
    if (existing.length < 3) return null;
  }

  const userContent = recursiveUser(existing, priorMeta?.observations);

  const model = input.model ?? config().model;
  const responseText = await input.llm.prompt(
    RECURSIVE_SYSTEM,
    userContent,
    { model, workerID: "lore-distill" },
  );
  if (!responseText) return null;

  const result = parseDistillationResult(responseText);
  if (!result) return null;

  // Store the meta-distillation at generation N+1, where N is the highest
  // generation in the merged inputs OR the prior meta's generation, whichever
  // is greater. Pre-F2, `existing` was the full history (all gen-0 rows that
  // ever existed for the session, including those merged by prior metas) so
  // its generation max worked. With F2's archive filter, `existing` only
  // covers new gen-0 since the last meta — we must consult the prior meta's
  // generation explicitly to keep the chain monotonic.
  const maxGen = Math.max(
    ...existing.map((d) => d.generation),
    priorMeta?.generation ?? 0,
  );
  const allSourceIDs = existing.flatMap((d) => d.source_ids);

  // Atomic: store the new meta row + archive the merged gen-0 rows in one
  // transaction. Without this, a crash between the two would leave stale
  // lineage (gen-N+1 meta stored but gen-0 rows un-archived, causing the
  // next run to re-consolidate the same segments into a duplicate meta).
  // Uses manual BEGIN/COMMIT because `bun:sqlite` and `node:sqlite` have
  // incompatible transaction APIs (`.transaction()` vs nothing).
  let metaId: string;
  db().exec("BEGIN IMMEDIATE");
  try {
    metaId = storeDistillation({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
      observations: result.observations,
      sourceIDs: allSourceIDs,
      generation: maxGen + 1,
    });
    // Archive the gen-0 distillations that were merged into gen-1+.
    // They remain searchable via BM25 recall but are excluded from the
    // in-context prefix and (post-F2) from `loadForSession`'s default path.
    archiveDistillations(existing.map((d) => d.id));
    db().exec("COMMIT");
  } catch (e) {
    db().exec("ROLLBACK");
    throw e;
  }

  // Fire-and-forget OUTSIDE the transaction (async, no rollback needed).
  if (embedding.isAvailable()) {
    embedding.embedDistillation(metaId, result.observations);
  }

  return result;
}
