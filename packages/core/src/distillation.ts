import { db, ensureProject } from "./db";
import { config } from "./config";
import * as temporal from "./temporal";
import { CHUNK_TERMINATOR } from "./temporal";
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import * as log from "./log";
import { extractPatterns, extractActionTags, tagToTitle } from "./pattern-extract";
import { detectPatternEchoes } from "./pattern-echo";
import {
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
} from "./prompt";
import { toolStripAnnotation } from "./gradient";
import { workerSessionIDs } from "./worker";
import { distillLimiter } from "./session-limiter";
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
 * Maximum allowed expansion for distillation output.
 *
 * Tiny segments can't meaningfully compress — distillation adds metadata
 * (timestamps, importance markers, cross-references) that necessarily
 * exceeds the source. Allow generous expansion for small segments while
 * still enforcing compression on large ones.
 *
 * @returns Maximum allowed distilled tokens for a given source token count.
 */
export function maxAllowedExpansion(sourceTokens: number): number {
  if (sourceTokens < 100) return sourceTokens * 5; // tiny: 8→40 is fine
  if (sourceTokens < 500) return sourceTokens * 2; // small: 2x headroom
  return sourceTokens; // large: must compress
}

/**
 * Segment detection: group related messages into distillation-sized chunks.
 *
 * When the total token count exceeds `maxTokens`, prefers splitting at the
 * largest inter-message time gap (if it's ≥ 3× the median gap) to respect
 * natural conversation boundaries. Falls back to token-boundary splitting
 * when timestamps are uniform.
 *
 * Trailing segments whose token sum is below {@link MIN_SEGMENT_TOKENS}
 * are merged into the previous segment to avoid tiny distillation inputs
 * with too little context.
 *
 * Exported for testing; `run()` is the production caller.
 */
export function detectSegments(
  messages: TemporalMessage[],
  maxTokens: number,
): TemporalMessage[][] {
  const totalTokens = messages.reduce((s, m) => s + m.tokens, 0);
  if (totalTokens <= maxTokens) return [messages];
  return splitSegments(messages, maxTokens);
}

/**
 * Compute the max_tokens budget for a worker LLM call.
 *
 * @param inputTokens  Estimated source token count
 * @param ratio        Compression ratio (0.0–1.0) — output ≈ ratio × input
 * @param floor        Minimum output tokens
 * @param cap          Maximum output tokens
 */
export function workerTokenBudget(
  inputTokens: number,
  ratio: number,
  floor: number,
  cap: number,
): number {
  return Math.max(floor, Math.min(Math.ceil(inputTokens * ratio), cap));
}

/**
 * Compute the max_tokens budget for gen-0 distillation of raw messages.
 *
 * Uses a √N-based formula (8 × √N) instead of a linear ratio so that the
 * budget grows sub-linearly with input size. This naturally constrains the
 * LLM to produce output at ~R ≈ 2–4 (the square-root boundary) and avoids
 * expansion on small segments where a linear 0.25 ratio + 1024 floor gave
 * the model far too much room.
 *
 * The multiplier (8) gives ~4× headroom above the R=2.0 target, accounting
 * for the detailed observation format (emoji markers, timestamps, entity
 * tags, exact numbers) required by the distillation prompt.
 *
 * @param sourceTokens  Estimated source token count from raw messages
 * @returns             Token budget clamped to [256, 4096]
 */
export function distillTokenBudget(sourceTokens: number): number {
  const MULTIPLIER = 8;
  const FLOOR = 256;
  const CAP = 4096;
  return Math.max(FLOOR, Math.min(Math.ceil(MULTIPLIER * Math.sqrt(sourceTokens)), CAP));
}

/**
 * Minimum segment token count — trailing segments smaller than this get
 * merged into the previous segment during splitting to avoid producing
 * segments too small to compress meaningfully.
 */
const MIN_SEGMENT_TOKENS = 64;

/**
 * Multiplier for the median gap threshold: a time gap must be at least
 * this many times the median gap to be used as a split point.
 */
const GAP_THRESHOLD_MULTIPLIER = 3;

/** Sum tokens for a slice of messages. */
function sliceTokens(messages: TemporalMessage[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += messages[i].tokens;
  return sum;
}

function splitSegments(
  messages: TemporalMessage[],
  maxTokens: number,
): TemporalMessage[][] {
  const totalTokens = messages.reduce((s, m) => s + m.tokens, 0);
  if (totalTokens <= maxTokens) return [messages];

  // Cannot subdivide a single message — yield as-is (oversized but indivisible).
  // Prevents infinite recursion when one message exceeds maxTokens (e.g., a 50KB+
  // tool output where Math.ceil(content.length / 3) > 16384).
  if (messages.length <= 1) return [messages];

  // Find the split point: prefer the largest time gap if it's significant
  const splitIdx = findSplitIndex(messages, maxTokens);

  const left = messages.slice(0, splitIdx);
  const right = messages.slice(splitIdx);

  // Recurse on both halves
  const result = splitSegments(left, maxTokens);

  const rightTokens = right.reduce((s, m) => s + m.tokens, 0);
  if (rightTokens < MIN_SEGMENT_TOKENS) {
    // Merge tiny trailing segment into the last segment
    result[result.length - 1].push(...right);
  } else {
    result.push(...splitSegments(right, maxTokens));
  }

  return result;
}

/**
 * Choose where to split an oversized message array.
 *
 * If there's a time gap ≥ 3× the median gap AND it falls within a range
 * that would produce segments of at least MIN_SEGMENT_TOKENS on each side,
 * use it. Otherwise fall back to the token-boundary split point (the index
 * where cumulative tokens first exceed `maxTokens`).
 */
function findSplitIndex(
  messages: TemporalMessage[],
  maxTokens: number,
): number {
  // Compute consecutive time gaps
  const gaps: Array<{ index: number; gap: number }> = [];
  for (let i = 1; i < messages.length; i++) {
    gaps.push({
      index: i,
      gap: messages[i].created_at - messages[i - 1].created_at,
    });
  }

  // Compute the token-boundary fallback: first index where cumulative tokens exceed maxTokens
  let cumulative = 0;
  let tokenBoundary = messages.length; // fallback if all messages fit (shouldn't happen)
  for (let i = 0; i < messages.length; i++) {
    cumulative += messages[i].tokens;
    if (cumulative > maxTokens) {
      // Split so left half has indices [0, i), right half starts at i.
      // Ensure at least 1 message on each side.
      tokenBoundary = Math.max(1, i);
      break;
    }
  }

  if (gaps.length === 0) return tokenBoundary;

  // Find median gap
  const sortedGaps = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

  // Find the largest gap that would produce viable segments
  // (≥ MIN_SEGMENT_TOKENS on each side)
  let bestGap = { index: -1, gap: 0 };
  for (const g of gaps) {
    const leftTokens = sliceTokens(messages, 0, g.index);
    const rightTokens = sliceTokens(messages, g.index, messages.length);
    if (
      g.gap > bestGap.gap &&
      leftTokens >= MIN_SEGMENT_TOKENS &&
      rightTokens >= MIN_SEGMENT_TOKENS
    ) {
      bestGap = g;
    }
  }

  // Use the time gap if it's significantly larger than median
  if (bestGap.index > 0 && bestGap.gap >= medianGap * GAP_THRESHOLD_MULTIPLIER) {
    return bestGap.index;
  }

  // Fall back to token-boundary splitting
  return tokenBoundary;
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
  /** k/√N compression ratio. NULL for pre-v12 rows or meta-distillations. */
  r_compression: number | null;
  /** Temporal clustering [0,1]. NULL for pre-v12 rows or meta-distillations. */
  c_norm: number | null;
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
    ? "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at, r_compression, c_norm FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC"
    : "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at, r_compression, c_norm FROM distillations WHERE project_id = ? AND session_id = ? AND archived = 0 ORDER BY created_at ASC";
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
    r_compression: number | null;
    c_norm: number | null;
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
  rCompression?: number;
  cNorm?: number;
  callType?: "batch" | "direct";
}): string {
  const pid = ensureProject(input.projectPath);
  const id = crypto.randomUUID();
  const sourceJson = JSON.stringify(input.sourceIDs);
  const tokens = Math.ceil(input.observations.length / 3);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.rCompression ?? null,
      input.cNorm ?? null,
      input.callType ?? null,
    );
  return id;
}

// Count non-archived gen-0 distillations — these are the ones awaiting
// meta-distillation. Archived gen-0 entries have already been consolidated.
export function gen0Count(projectPath: string, sessionID: string): number {
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
      "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at, r_compression, c_norm FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 AND archived = 0 ORDER BY created_at ASC",
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
    r_compression: number | null;
    c_norm: number | null;
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

// Main distillation entry point — called on session.idle or when urgent.
// Serialized per session via p-limit(1) to prevent concurrent runs from
// reading the same undistilled messages and producing duplicate rows.
export async function run(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  force?: boolean;
  skipMeta?: boolean;
  urgent?: boolean;
  callType?: "batch" | "direct";
  /** Override the meta-distillation gen-0 threshold. When set, meta-distillation
   *  triggers at this count instead of `cfg.distillation.metaThreshold`.
   *  Used by the urgent-distillation path to consolidate earlier under bust pressure. */
  metaThresholdOverride?: number;
}): Promise<{ rounds: number; distilled: number }> {
  return distillLimiter.get(input.sessionID)(() => runInner(input));
}

async function runInner(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  /** Skip minMessages threshold check — distill whatever is pending */
  force?: boolean;
  /** Skip meta-distillation even when gen-0 count exceeds the threshold.
   *  Used when the upstream prompt cache is likely still warm — meta-distillation
   *  rewrites distillation row IDs, which invalidates the distilled prefix cache
   *  and causes a cache bust on the next turn. Callers should set this to true
   *  when `Date.now() - getLastTurnAt(sessionID) < cacheTTL`. */
  skipMeta?: boolean;
  /** When true, all LLM calls in this run are marked urgent and bypass the
   *  batch queue (if one is active). Use for compaction and overflow recovery
   *  where the caller is blocking on the result. Background/idle distillation
   *  should leave this false to benefit from batch API 50% cost savings. */
  urgent?: boolean;
  /** Whether the LLM call will use batch or direct pricing. Recorded on the
   *  distillation row for accurate historical cost estimates. */
  callType?: "batch" | "direct";
  /** Override the meta-distillation gen-0 threshold (see run()). */
  metaThresholdOverride?: number;
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
      const segments = detectSegments(pending, cfg.distillation.maxSegmentTokens);
      for (const segment of segments) {
        const segTokens = segment.reduce((s, m) => s + m.tokens, 0);
        if (segTokens < cfg.distillation.minSegmentTokens) {
          if (input.force) {
            // Absorb: mark distilled without LLM call to avoid blocking
            // the caller on useless work. Messages remain searchable via
            // BM25/vector recall on the temporal table.
            temporal.markDistilled(segment.map((m) => m.id));
            log.info(
              `absorb tiny segment: ${segment.length} msgs, ${segTokens} tokens (below min ${cfg.distillation.minSegmentTokens})`,
            );
          }
          // else: leave undistilled to accumulate with future messages
          continue;
        }
        const result = await distillSegment({
          llm: input.llm,
          projectPath: input.projectPath,
          sessionID: input.sessionID,
          messages: segment,
          model: input.model,
          urgent: input.urgent,
          callType: input.callType,
        });
        if (result) {
          distilled += segment.length;
          rounds++;
        }
      }
    }

    // Check if meta-distillation is needed (skip when cache is warm to avoid
    // prefix cache invalidation — row IDs change after meta-distill, busting
    // the prompt cache on the next turn).
    // Clamp override to min 2 — meta-distillation with < 2 gen-0 segments is pointless.
    const effectiveMetaThreshold = Math.max(
      2,
      input.metaThresholdOverride ?? cfg.distillation.metaThreshold,
    );
    if (
      !input.skipMeta &&
      gen0Count(input.projectPath, input.sessionID) >=
      effectiveMetaThreshold
    ) {
      // Call inner directly — we're already under the per-session limiter.
      await metaDistillInner({
        llm: input.llm,
        projectPath: input.projectPath,
        sessionID: input.sessionID,
        model: input.model,
        urgent: input.urgent,
        callType: input.callType,
      });
      rounds++;
    }

    // Continue looping only when explicitly forced (urgent/overflow recovery).
    // Previously re-polled needsUrgentDistillation() here, but that consumed
    // the per-session flag and raced with the caller that already checked it.
    if (!input.force) break;
  }

  return { rounds, distilled };
}

async function distillSegment(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  messages: TemporalMessage[];
  model?: { providerID: string; modelID: string };
  urgent?: boolean;
  callType?: "batch" | "direct";
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
  const sourceTokens = input.messages.reduce((sum, m) => sum + m.tokens, 0);
  const maxTokens = distillTokenBudget(sourceTokens);
  const responseText = await input.llm.prompt(
    DISTILLATION_SYSTEM,
    userContent,
    { model, workerID: "lore-distill", thinking: false, urgent: input.urgent, sessionID: input.sessionID, maxTokens, temperature: 0 },
  );
  if (!responseText) return null;

  const result = parseDistillationResult(responseText);
  if (!result) return null;

  // Compute context health metrics before storing.
  const distilledTokens = Math.ceil(result.observations.length / 3);
  const rComp = compressionRatio(distilledTokens, sourceTokens);
  const cNorm = temporal.temporalCnorm(input.messages.map((m) => m.created_at));

  // Expansion guard: discard distillation output that exceeds the allowed
  // expansion limit. Tiny segments (< 100 tokens) get generous headroom
  // because distillation necessarily adds metadata; large segments must
  // actually compress. Still marks source messages as distilled to prevent
  // infinite retry loops — they remain searchable via BM25/vector recall.
  const expansionLimit = maxAllowedExpansion(sourceTokens);
  if (distilledTokens > expansionLimit) {
    temporal.markDistilled(input.messages.map((m) => m.id));
    log.warn(
      `distill expansion discarded: ${input.messages.length} msgs, ` +
        `${sourceTokens}→${distilledTokens} tokens (exceeds ${expansionLimit} limit)`,
    );
    return null;
  }

  // Atomic: store distillation + mark source messages as distilled in one
  // transaction. Without this, a crash between the two statements would leave
  // messages undistilled but with an existing distillation row, causing
  // re-processing on restart and duplicate distillation content.
  let distillId: string;
  db().exec("BEGIN IMMEDIATE");
  try {
    distillId = storeDistillation({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
      observations: result.observations,
      sourceIDs: input.messages.map((m) => m.id),
      generation: 0,
      rCompression: rComp,
      cNorm,
      callType: input.callType,
    });
    temporal.markDistilled(input.messages.map((m) => m.id));
    db().exec("COMMIT");
  } catch (e) {
    db().exec("ROLLBACK");
    throw e;
  }

  log.info(
    `distill segment: ${input.messages.length} msgs, ` +
      `${sourceTokens}→${distilledTokens} tokens, ` +
      `R=${rComp.toFixed(2)}, C_norm=${cNorm.toFixed(3)}`,
  );

  // Soft quality warning: R < 1.0 means the distillation is below the √N
  // boundary, suggesting potentially lossy compression. Stored for
  // monitoring — not a hard gate.
  if (rComp < 1.0) {
    log.warn(
      `distill quality low: R=${rComp.toFixed(2)} (<1.0) on ${input.messages.length} msgs, ` +
        `${sourceTokens}→${distilledTokens} tokens — may have lost detail`,
    );
  }

  // Embed the distillation for vector search. When knowledge extraction
  // is enabled, also detect behavioral pattern echoes — similar segments
  // across sessions indicate implicit user preferences.
  // When urgent (e.g., /lore:curate), await so entries are created before
  // the curate response is sent. Otherwise fire-and-forget.
  if (embedding.isAvailable() && config().knowledge.enabled) {
    const echoPromise = detectPatternEchoes({
      distillId,
      observations: result.observations,
      projectPath: input.projectPath,
      sessionID: input.sessionID,
      llm: input.llm,
      model: input.model,
    });
    if (input.urgent) await echoPromise;
  } else if (embedding.isAvailable()) {
    embedding.embedDistillation(distillId, result.observations);
  }

  // Fire-and-forget: extract decision/preference patterns → knowledge entries
  if (config().knowledge.enabled) {
    const patterns = extractPatterns(result.observations);
    for (const pat of patterns) {
      try {
        ltm.create({
          projectPath: input.projectPath,
          category: pat.category,
          title: pat.title,
          content: pat.content,
          session: input.sessionID,
          scope: "project",
        });
      } catch {
        // Dedup guard in ltm.create() handles duplicates — swallow errors
      }
    }
    if (patterns.length > 0) {
      log.info(`pattern extraction: ${patterns.length} entries from distillation`);
    }

    // Action tag counting: extract tags from this segment, then count
    // how many distinct sessions contain the same tag across the project.
    // When a tag appears in 3+ sessions, it's a strong behavioral signal.
    const tags = extractActionTags(result.observations);
    if (tags.length > 0) {
      const pid = ensureProject(input.projectPath);
      for (const tag of tags) {
        try {
          const tagPattern = `%[${tag}]%`;
          const rows = db()
            .query(
              `SELECT COUNT(DISTINCT session_id) as cnt FROM distillations
               WHERE project_id = ? AND observations LIKE ?`,
            )
            .get(pid, tagPattern) as { cnt: number } | null;
          const sessionCount = rows?.cnt ?? 0;
          if (sessionCount >= 3) {
            ltm.create({
              projectPath: input.projectPath,
              category: "preference",
              title: tagToTitle(tag),
              content: `Behavioral pattern detected across ${sessionCount} sessions (action: ${tag}). The user consistently demonstrates this behavior.`,
              session: input.sessionID,
              scope: "project",
              confidence: 0.8,
            });
            log.info(`action tag '${tag}' found in ${sessionCount} sessions — created preference`);
          }
        } catch {
          // Dedup guard or DB error — swallow
        }
      }
    }
  }

  return result;
}

/**
 * Consolidate a session's gen-0 distillation segments into a higher-generation
 * meta-distillation. On second-and-later rounds, anchors on the prior meta
 * via `<previous-meta-summary>` so the LLM updates in place rather than
 * re-deriving from scratch.
 *
 * Serialized per session via the same p-limit(1) as `run()`. Exported for
 * the idle handler which calls metaDistill() independently of run().
 */
export async function metaDistill(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  urgent?: boolean;
  callType?: "batch" | "direct";
}): Promise<DistillationResult | null> {
  return distillLimiter.get(input.sessionID)(() => metaDistillInner(input));
}

async function metaDistillInner(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  urgent?: boolean;
  callType?: "batch" | "direct";
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
  const inputTokens = Math.ceil(userContent.length / 3);
  const maxTokens = workerTokenBudget(inputTokens, 0.25, 1024, 8192);
  const responseText = await input.llm.prompt(
    RECURSIVE_SYSTEM,
    userContent,
    { model, workerID: "lore-distill", thinking: false, urgent: input.urgent, sessionID: input.sessionID, maxTokens, temperature: 0 },
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
      callType: input.callType,
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

  // Fire-and-forget: extract decision/preference patterns → knowledge entries
  if (config().knowledge.enabled) {
    const patterns = extractPatterns(result.observations);
    for (const pat of patterns) {
      try {
        ltm.create({
          projectPath: input.projectPath,
          category: pat.category,
          title: pat.title,
          content: pat.content,
          session: input.sessionID,
          scope: "project",
        });
      } catch {
        // Dedup guard in ltm.create() handles duplicates — swallow errors
      }
    }
    if (patterns.length > 0) {
      log.info(`pattern extraction: ${patterns.length} entries from meta-distillation`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Retroactive metric backfill
// ---------------------------------------------------------------------------

/**
 * Backfill `r_compression` and `c_norm` for distillations that were created
 * before schema v12 (or before PR #113 added the computation).
 *
 * For each distillation with NULL metrics, loads source temporal messages via
 * `source_ids`, computes `compressionRatio()` and `temporalCnorm()`, and
 * writes the values back. Skips rows where source messages have been pruned
 * or source_ids is empty.
 *
 * Designed to run once at startup — idempotent (only touches NULL rows).
 * Returns the number of rows updated.
 */
export function backfillMetrics(): number {
  const rows = db()
    .query(
      "SELECT id, source_ids, token_count FROM distillations WHERE r_compression IS NULL",
    )
    .all() as Array<{
    id: string;
    source_ids: string;
    token_count: number;
  }>;

  if (!rows.length) return 0;

  const update = db().prepare(
    "UPDATE distillations SET r_compression = ?, c_norm = ? WHERE id = ?",
  );

  let updated = 0;

  for (const row of rows) {
    const sourceIds = parseSourceIds(row.source_ids);
    if (!sourceIds.length) continue;

    // Load source temporal messages — they may have been pruned.
    const placeholders = sourceIds.map(() => "?").join(",");
    const sources = db()
      .query(
        `SELECT tokens, created_at FROM temporal_messages WHERE id IN (${placeholders})`,
      )
      .all(...sourceIds) as Array<{ tokens: number; created_at: number }>;

    if (!sources.length) continue;

    const sourceTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
    const timestamps = sources.map((s) => s.created_at);

    const rComp = compressionRatio(row.token_count, sourceTokens);
    const cNorm = temporal.temporalCnorm(timestamps);

    update.run(rComp, cNorm, row.id);
    updated++;
  }

  if (updated > 0) {
    log.info(
      `backfilled metrics for ${updated} distillations (${rows.length - updated} skipped — missing sources)`,
    );
  }

  return updated;
}
