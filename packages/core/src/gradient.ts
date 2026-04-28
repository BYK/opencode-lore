import type { LoreMessage, LorePart, LoreMessageWithParts, LoreToolPart, LoreTextPart, LoreToolState, LoreToolStateCompleted } from "./types";
import { isTextPart, isReasoningPart, isToolPart } from "./types";
import { db, ensureProject, loadForceMinLayer, saveForceMinLayer } from "./db";
import { config } from "./config";
import { formatDistillations } from "./prompt";
import { normalize } from "./markdown";
import * as log from "./log";

type MessageWithParts = LoreMessageWithParts;

// Token estimate: ~3 chars per token. Validated against real API data across
// 200+ turn-pairs: chars/3 gives ~1.68x ratio (actual/estimate), best among
// heuristics tested. The gap is overhead (system prompt, tool definitions,
// conversation structure) which calibratedOverhead captures via EMA.
function estimate(text: string): number {
  return Math.ceil(text.length / 3);
}

function estimateParts(parts: LorePart[]): number {
  let total = 0;
  for (const part of parts) {
    if (isTextPart(part)) total += estimate(part.text);
    else if (isReasoningPart(part) && part.text)
      total += estimate(part.text);
    else if (isToolPart(part) && part.state.status === "completed")
      total += estimate(part.state.output) + estimate(part.tool) + 50;
    else total += 20; // metadata overhead for other part types
  }
  return total;
}

function estimateMessage(msg: MessageWithParts): number {
  return estimateParts(msg.parts) + 20; // role/metadata overhead
}

// Cached model context limit — set by system transform hook, used by message transform
let contextLimit = 200_000; // sensible default
let outputReserved = 32_000;

// Cost-aware layer-0 token cap. When > 0, the layer-0 passthrough gate uses
// min(maxInput, maxLayer0Tokens) instead of maxInput alone. Derived from the
// model's cache-read cost: cap = targetCostPerTurn / costPerToken. This prevents
// expensive models from sending huge contexts at layer 0, where cache-read costs
// compound linearly across turns. Set to 0 to disable (use full context).
let maxLayer0Tokens = 0;

const MIN_LAYER0_FLOOR = 40_000;

// Conservative overhead reserve for first-turn (before calibration):
// accounts for provider system prompt + AGENTS.md + tool definitions + env info
const FIRST_TURN_OVERHEAD = 15_000;

// Calibrated overhead: actual tokens used minus our message estimate.
// Null = not yet calibrated (first turn). Updated after every assistant response.
// Shared across all sessions — this is model-level overhead (system prompt,
// tool definitions, provider headers) that doesn't vary per session.
let calibratedOverhead: number | null = null;

// ---------------------------------------------------------------------------
// Per-session state
//
// All calibration, layer-tracking, and window-ID state is scoped per session
// using an in-memory Map. This prevents worker sessions (lore-distill,
// lore-curator) from corrupting the main session's sticky-layer guard and
// delta-estimation state when their transform() calls return layer 0.
//
// forceMinLayer is the one field that MUST survive process restarts: when the
// API returns "prompt is too long", the error handler sets forceMinLayer=2.
// If OpenCode restarts before the next turn, the escalation is lost and the
// overflow repeats. forceMinLayer is persisted to SQLite (session_state table)
// and loaded on first access. All other state rebuilds from the first API
// response via UNCALIBRATED_SAFETY.
// ---------------------------------------------------------------------------

type SessionState = {
  /** Exact input token count from the last successful API response */
  lastKnownInput: number;
  /** LTM tokens that were in-flight when lastKnownInput was recorded */
  lastKnownLtm: number;
  /** Total messages sent to the model in the last turn (compressed count on layers 1-4) */
  lastKnownMessageCount: number;
  /** Number of messages in the most recent transform() output */
  lastTransformedCount: number;
  /** Layer used by the most recent transform() call — sticky-layer guard */
  lastLayer: SafetyLayer;
  /** Message IDs in the most recent transform() output — ID-based delta estimation */
  lastWindowMessageIDs: Set<string>;
  /** One-shot force escalation: skip layers below this on the next transform() */
  forceMinLayer: SafetyLayer;
  /** Token estimate from the most recent transform() output (compressed window) */
  lastTransformEstimate: number;
  /** Distilled prefix cache (Approach C) */
  prefixCache: PrefixCache | null;
  /** Raw window pin cache (Approach B) */
  rawWindowCache: RawWindowCache | null;
  /**
   * Wall-clock timestamp (epoch ms) of the most recent transform() call for this
   * session. Used by onIdleResume() to detect cold-cache resumption — when the
   * gap between turns exceeds Anthropic's prompt cache eviction window (5 min
   * default / 1 hour extended), the byte-identity caching subsystems
   * (prefixCache, rawWindowCache) are providing no value because the cache is
   * already cold. Refreshing them on resume lets us produce a better-fitting
   * window without paying a cache cost we'd otherwise be trying to preserve.
   * 0 = never set (first turn).
   */
  lastTurnAt: number;
  /**
   * Set true by onIdleResume() when an idle-resume reset just fired; consumed
   * (and cleared) by the LTM degraded-recovery branch in the OpenCode hook to
   * skip the conversation-vs-LTM token comparison. After idle eviction the
   * cache-bust cost is effectively zero, so we should always recover LTM on
   * the post-idle turn regardless of conversation size.
   */
  cameOutOfIdle: boolean;
  /** Consecutive turns at layer >= 2. When >= 3, log a compaction hint. */
  consecutiveHighLayer: number;
  /** Hash of the first message IDs in the last transform output — for cache-bust diagnostics. */
  lastPrefixHash: string;
};

function makeSessionState(): SessionState {
  return {
    lastKnownInput: 0,
    lastKnownLtm: 0,
    lastKnownMessageCount: 0,
    lastTransformedCount: 0,
    lastLayer: 0,
    lastWindowMessageIDs: new Set(),
    forceMinLayer: 0,
    lastTransformEstimate: 0,
    prefixCache: null,
    rawWindowCache: null,
    lastTurnAt: 0,
    cameOutOfIdle: false,
    consecutiveHighLayer: 0,
    lastPrefixHash: "",
  };
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionID: string): SessionState {
  let state = sessionStates.get(sessionID);
  if (!state) {
    state = makeSessionState();
    // Restore persisted forceMinLayer from DB — survives process restarts.
    // Critical for "prompt too long" recovery: the error handler sets
    // forceMinLayer=2, but if OpenCode restarts before the next turn,
    // the in-memory escalation would be lost without this.
    state.forceMinLayer = loadForceMinLayer(sessionID) as SafetyLayer;
    sessionStates.set(sessionID, state);
  }
  return state;
}

/**
 * Detect cold-cache resumption and refresh byte-identity caches.
 *
 * Anthropic's prompt cache evicts entries after ~5 minutes (default tier) /
 * ~1 hour (extended tier). When a session resumes after the eviction window,
 * the cache is provably cold — every prefix we've been carefully keeping
 * byte-stable (`prefixCache`, `rawWindowCache`, plus the host's per-session
 * LTM cache) provides no benefit on this turn. Worse, the LTM block was
 * scored against the conversation context as it was on the previous turn,
 * which may have drifted significantly in N hours.
 *
 * On resume after `thresholdMs`:
 *   - reset the distilled prefix cache (next turn re-renders from scratch)
 *   - reset the raw window pin cache (next turn picks a fresh cutoff)
 *   - set `cameOutOfIdle` so the OpenCode host can also clear `ltmSessionCache`
 *     and bypass the conversation-vs-LTM cost comparison in the LTM
 *     degraded-recovery branch
 *
 * Importantly, this does NOT touch:
 *   - reasoning blocks (Anthropic's April 23 postmortem identifies dropping
 *     reasoning blocks as the root cause of forgetfulness/repetition; Lore
 *     preserves reasoning by policy across all gradient layers)
 *   - the gradient layer (cold cache doesn't change token budgets;
 *     calibration's actualInput = input + cache.read + cache.write already
 *     accounts for cache misses correctly)
 *   - calibration state (`lastKnownInput`, overhead EMA, message-ID set) —
 *     the next API response will refresh these via the normal calibrate() path
 *
 * Set `thresholdMs <= 0` to disable. Returns true if a reset fired so the
 * caller can log/observe.
 */
export function onIdleResume(
  sessionID: string,
  thresholdMs: number,
  now: number = Date.now(),
): { triggered: false } | { triggered: true; idleMs: number } {
  if (thresholdMs <= 0) return { triggered: false };
  const state = getSessionState(sessionID);
  if (state.lastTurnAt === 0) return { triggered: false }; // first turn — nothing to refresh
  const idleMs = now - state.lastTurnAt;
  if (idleMs < thresholdMs) return { triggered: false };
  state.prefixCache = null;
  state.rawWindowCache = null;
  state.cameOutOfIdle = true;
  return { triggered: true, idleMs };
}

/**
 * Read-and-clear the cameOutOfIdle flag. The OpenCode host's LTM degraded-
 * recovery branch consumes this to decide whether to bypass the
 * conversation-vs-LTM token comparison on a post-idle turn.
 */
export function consumeCameOutOfIdle(sessionID: string): boolean {
  const state = sessionStates.get(sessionID);
  if (!state || !state.cameOutOfIdle) return false;
  state.cameOutOfIdle = false;
  return true;
}

// LTM tokens injected via system transform hook this turn.
// Set by setLtmTokens() after the system hook runs; consumed by transform().
let ltmTokens = 0;

export function setModelLimits(limits: { context: number; output: number }) {
  contextLimit = limits.context || 200_000;
  // NOTE: this cap of 32K matches what @ai-sdk/anthropic sends as max_tokens for
  // claude-opus-4-6 (the SDK doesn't recognise the -6 variant and falls back to
  // the generic claude-opus-4- pattern with maxOutputTokens=32K).  If the SDK is
  // updated to send the model's actual limit (128K for opus-4-6), this cap will
  // become wrong — the effective max input would drop from 168K to 72K but our
  // budget would still assume 168K.  At that point, remove the cap.
  outputReserved = Math.min(limits.output || 32_000, 32_000);
}

/**
 * Set the cost-aware layer-0 token cap. When the cap > 0, the layer-0
 * passthrough gate uses `min(maxInput, cap)` instead of `maxInput` alone.
 *
 * Call from the host adapter after computing the cap from model pricing:
 * `cap = max(targetCostPerTurn / model.cost.cache.read, MIN_LAYER0_FLOOR)`
 */
export function setMaxLayer0Tokens(tokens: number) {
  maxLayer0Tokens = Math.max(0, Math.floor(tokens));
}

/** Compute the layer-0 token cap from a per-turn cost target and cache-read price. */
export function computeLayer0Cap(
  targetCostPerTurn: number,
  cacheReadCostPerToken: number,
): number {
  if (targetCostPerTurn <= 0 || cacheReadCostPerToken <= 0) return 0;
  const rawCap = Math.floor(targetCostPerTurn / cacheReadCostPerToken);
  return Math.max(rawCap, MIN_LAYER0_FLOOR);
}

/** Called by the system transform hook after formatting LTM knowledge. */
export function setLtmTokens(tokens: number) {
  ltmTokens = tokens;
}

/** Returns the current LTM token count (for tests and diagnostics). */
export function getLtmTokens(): number {
  return ltmTokens;
}

/**
 * Returns the token budget available for LTM system-prompt injection.
 * This is the usable context (after output + overhead) multiplied by
 * the configured ltm budget fraction. Call this from the system transform
 * hook to cap how many tokens formatKnowledge may use.
 */
export function getLtmBudget(ltmFraction: number): number {
  const overhead = calibratedOverhead ?? FIRST_TURN_OVERHEAD;
  const usable = Math.max(0, contextLimit - outputReserved - overhead);
  return Math.floor(usable * ltmFraction);
}

// Called after each assistant message completes with real token usage data.
// actualInput    = tokens.input + tokens.cache.read + tokens.cache.write
// sessionID      = session that produced this response (for exact-tracking validity)
// messageCount   = number of messages that were sent (for delta estimation)
//
// Overhead calibration uses lastTransformEstimate (the token estimate from the
// compressed window that was actually sent to the model) instead of re-estimating
// all session messages. On compressed sessions, all-message estimate >> actualInput,
// which clamped overhead to 0 and broke budget calculations.
export function calibrate(
  actualInput: number,
  sessionID?: string,
  messageCount?: number,
) {
  // Use the transform's own estimate for the compressed window it produced.
  // This is the correct baseline: it estimates the same messages the model saw.
  const messageEstimate = sessionID
    ? getSessionState(sessionID).lastTransformEstimate
    : 0;

  // Update global overhead calibration (shared across sessions — model-level).
  // Skip when actualInput > 0 but no transform estimate exists yet (no baseline
  // to compare against). Allow when both are 0 (test setup to zero overhead) or
  // when we have a real transform estimate.
  if (messageEstimate > 0 || actualInput === 0) {
    const overhead = Math.max(0, actualInput - messageEstimate);
    calibratedOverhead =
      calibratedOverhead === null
        ? overhead
        : Math.round(calibratedOverhead * 0.7 + overhead * 0.3);
  }

  // Store per-session exact counts for the proactive layer 0 decision.
  if (sessionID !== undefined) {
    const state = getSessionState(sessionID);
    state.lastKnownInput = actualInput;
    state.lastKnownLtm = ltmTokens;
    if (messageCount !== undefined) state.lastKnownMessageCount = messageCount;
  }
}

export function getOverhead(): number {
  return calibratedOverhead ?? FIRST_TURN_OVERHEAD;
}

/**
 * Returns the number of messages in the most recent transform() output for
 * the given session. Used by calibrate() to track the compressed window size.
 */
export function getLastTransformedCount(sessionID: string): number {
  return sessionStates.get(sessionID)?.lastTransformedCount ?? 0;
}

/** Returns the token estimate from the most recent transform() output. */
export function getLastTransformEstimate(sessionID: string): number {
  return sessionStates.get(sessionID)?.lastTransformEstimate ?? 0;
}

/** Returns the layer used by the most recent transform() call. For testing. */
export function getLastLayer(sessionID?: string): SafetyLayer {
  if (sessionID) return sessionStates.get(sessionID)?.lastLayer ?? 0;
  // Fallback for tests: return from the first (and usually only) session state
  const first = sessionStates.values().next().value;
  return first?.lastLayer ?? 0;
}

/**
 * Force the next transform() call for this session to use at least the given layer.
 * Called when the API returns "prompt is too long" so the next attempt
 * trims the context enough to fit within the model's context window.
 */
export function setForceMinLayer(layer: SafetyLayer, sessionID?: string) {
  if (sessionID) {
    getSessionState(sessionID).forceMinLayer = layer;
    saveForceMinLayer(sessionID, layer);
  } else {
    // Fallback for tests / callers without session ID: set on all active sessions
    for (const [sid, state] of sessionStates.entries()) {
      state.forceMinLayer = layer;
      saveForceMinLayer(sid, layer);
    }
  }
}

// For testing only — reset all calibration and force-escalation state
export function resetCalibration(sessionID?: string) {
  calibratedOverhead = null;
  if (sessionID) {
    saveForceMinLayer(sessionID, 0); // clear persisted state
    sessionStates.delete(sessionID);
  } else {
    for (const sid of sessionStates.keys()) {
      saveForceMinLayer(sid, 0);
    }
    sessionStates.clear();
  }
}

/**
 * For testing only — observe session-state cache fields without exposing the
 * full type. Returns null when the session has no state. The boolean fields
 * answer "does this cache hold something right now?" — sufficient for asserting
 * that onIdleResume() reset them.
 */
export function inspectSessionState(sessionID: string): {
  hasPrefixCache: boolean;
  hasRawWindowCache: boolean;
  cameOutOfIdle: boolean;
  lastTurnAt: number;
} | null {
  const state = sessionStates.get(sessionID);
  if (!state) return null;
  return {
    hasPrefixCache: state.prefixCache !== null,
    hasRawWindowCache: state.rawWindowCache !== null,
    cameOutOfIdle: state.cameOutOfIdle,
    lastTurnAt: state.lastTurnAt,
  };
}

/**
 * For testing only — set the session's lastTurnAt field. Used to simulate
 * idle gaps without sleeping. Creates the session state if not present so
 * tests don't need to seed it via a transform() call.
 */
export function setLastTurnAtForTest(sessionID: string, ms: number): void {
  getSessionState(sessionID).lastTurnAt = ms;
}

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  token_count: number;
  created_at: number;
  session_id: string;
};

// Load non-archived distillations for the in-context prefix.
// Archived gen-0 entries (preserved after meta-distillation) are excluded here
// but remain searchable via the recall tool's searchDistillations().
function loadDistillations(
  projectPath: string,
  sessionID?: string,
): Distillation[] {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? AND session_id = ? AND archived = 0 ORDER BY created_at ASC"
    : "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? AND archived = 0 ORDER BY created_at ASC";
  const params = sessionID ? [pid, sessionID] : [pid];
  return db()
    .query(query)
    .all(...params) as Distillation[];
}

// Strip all <system-reminder>...</system-reminder> blocks from message text.
// For the user-message wrapper pattern, extracts the actual user text.
// For all other reminders (build-switch, plan reminders, etc.), drops them entirely.
// These tags are added by OpenCode in-memory or persisted as synthetic parts —
// leaving them in the raw window causes the model to echo the format.
function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, (match) => {
      const inner = match.match(
        /The user sent the following message:\n([\s\S]*?)\n\nPlease address/,
      );
      return inner ? inner[1].trim() + "\n" : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanParts(parts: LorePart[]): LorePart[] {
  const cleaned = parts.map((part) => {
    if (!isTextPart(part)) return part;
    const text = stripSystemReminders(part.text);
    if (text === part.text) return part;
    return { ...part, text } as LorePart;
  });
  // Filter out text parts that became empty after stripping
  const filtered = cleaned.filter(
    (part) =>
      !isTextPart(part) ||
      part.text.trim().length > 0,
  );
  // If all parts were stripped (e.g. a user message that was purely build-switch synthetic
  // content), keep a minimal placeholder so the message survives toModelMessages.
  // Without this, the message gets dropped and the conversation ends with an assistant message,
  // causing Anthropic's "does not support assistant message prefill" error.
  if (filtered.length === 0 && parts.length > 0) {
    const first = parts[0];
    if (isTextPart(first)) {
      return [{ ...first, text: "..." } as LorePart];
    }
  }
  return filtered.length > 0 ? filtered : parts;
}

// Upper bound on how much of the output the path-extraction regex scans.
// Two mitigations for catastrophic backtracking in `PATH_RE`:
//   1. Skip entirely if the input contains no '/' (a path requires at least
//      one separator, so without one the regex has no possible match yet
//      still backtracks O(n²) on long runs of [\w.-]).
//   2. Cap the scanned slice at this limit so even crafted inputs with a
//      '/' somewhere don't stall the worker. The annotation only needs a
//      few representative paths — sampling the first 64KB is plenty.
const ANNOTATION_PATH_SCAN_LIMIT = 64 * 1024;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/g;

// Build a metadata annotation for a stripped tool output, preserving key signals
// about what was lost without requiring an LLM call. Inspired by the per-token
// scalar bias β from "Fast KV Compaction via Attention Matching" (Zweiger et al.,
// 2025) — when tokens are removed, preserving metadata about the removed content
// helps the model compensate for information loss and decide whether to recall.
// Reference: https://arxiv.org/abs/2602.16284
export function toolStripAnnotation(toolName: string, output: string): string {
  const lines = output.split("\n").length;

  // Detect key signals via lightweight heuristics — no LLM call
  const hasError = /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/i.test(output);

  // Path extraction: skip entirely if no '/' is present (cheap O(n) check
  // via indexOf) to avoid PATH_RE's O(n²) backtracking on long runs of
  // [\w.-] without a separator. Otherwise sample the first N KB.
  let uniquePaths: string[] = [];
  if (output.indexOf("/") !== -1) {
    const pathScan =
      output.length > ANNOTATION_PATH_SCAN_LIMIT
        ? output.slice(0, ANNOTATION_PATH_SCAN_LIMIT)
        : output;
    const paths = pathScan.match(PATH_RE);
    if (paths) uniquePaths = [...new Set(paths)].slice(0, 5);
  }

  let annotation = `[output omitted — ${toolName}: ${lines} lines`;
  if (hasError) annotation += ", contained errors";
  if (uniquePaths.length > 0) annotation += `, paths: ${uniquePaths.join(", ")}`;
  annotation += " — use recall for details]";
  return annotation;
}

// ---------------------------------------------------------------------------
// Content-aware deduplication
// ---------------------------------------------------------------------------
// Inspired by Dirac's ContextManager file-read deduplication: detects when the
// same content appears multiple times in the conversation (e.g., the same file
// read multiple times, or the same command output repeated) and replaces earlier
// occurrences with compact annotations. This reduces token pressure before layer
// selection, potentially keeping sessions at lower (less lossy) gradient layers.

// Minimum output size (chars) to consider for dedup — annotations for smaller
// outputs would cost more tokens than the original content.
const DEDUP_MIN_CHARS = 600;

/** Fast FNV-1a hash for content comparison. */
function simpleHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/** Extract file path from a tool's input JSON.
 *  Handles common formats: {"path": "/foo.ts"}, {"filePath": "/foo.ts"},
 *  and plain text fallback. */
function extractFilePath(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input);
    return parsed.path || parsed.filePath || parsed.file;
  } catch {
    // Plain text — try to extract a path-like string
    const match = input.match(/(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/);
    return match?.[0];
  }
}

/** Annotation for deduplicated tool output — follows the toolStripAnnotation() pattern. */
function dedupAnnotation(toolName: string, filePath?: string): string {
  if (filePath) {
    return `[earlier version of ${filePath} — see latest read below for current content]`;
  }
  return `[duplicate output — same content as later ${toolName} in this session — use recall for details]`;
}

/**
 * Replace duplicate tool outputs with compact back-references, keeping only
 * the latest occurrence of each unique output. Reduces context token usage
 * without information loss — the model sees the most recent content intact.
 *
 * Deduplicates by:
 * 1. Exact content hash: identical tool outputs (same file read twice, same command output)
 * 2. Same-file reads: read_file outputs for the same path (content may differ due to edits)
 *
 * The current turn (from currentTurnIdx onward) is never touched — the model
 * needs full context for its active work. Tool parts are never removed entirely;
 * only state.output is replaced with a compact annotation.
 *
 * Returns the original array reference (not a copy) when no duplicates exist.
 */
export function deduplicateToolOutputs(
  messages: MessageWithParts[],
  currentTurnIdx: number,
): MessageWithParts[] {
  // Track latest occurrence: contentKey → latest message index
  const contentLatest = new Map<string, number>();
  // Track latest read by file path: "read:path" → latest message index
  const fileLatest = new Map<string, number>();

  // Also include current-turn reads in the "latest" tracking so we properly
  // recognize earlier reads as duplicates of current-turn content.
  for (let i = 0; i < messages.length; i++) {
    for (const part of messages[i].parts) {
      if (!isToolPart(part) || part.state.status !== "completed") continue;
      const output = part.state.output;
      if (!output || output.length < DEDUP_MIN_CHARS) continue;

      const key = `${part.tool}:${simpleHash(output)}`;
      contentLatest.set(key, i);

      // For read-type tools, also track by file path
      if (part.tool === "read_file" || part.tool === "read") {
        const inputStr = typeof part.state.input === "string"
          ? part.state.input
          : JSON.stringify(part.state.input);
        const fp = extractFilePath(inputStr);
        if (fp) fileLatest.set(`read:${fp}`, i);
      }
    }
  }

  // Second pass: replace earlier occurrences (but never touch the current turn)
  let changed = false;
  const result = messages.map((msg, msgIdx) => {
    if (msgIdx >= currentTurnIdx) return msg; // sacred boundary

    let partsChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolPart(part) || part.state.status !== "completed") return part;
      const output = part.state.output;
      if (!output || output.length < DEDUP_MIN_CHARS) return part;

      // Check exact-match dedup: is this the latest occurrence of this content?
      const contentKey = `${part.tool}:${simpleHash(output)}`;
      const isLatestContent = contentLatest.get(contentKey) === msgIdx;

      // Check file-path dedup for read tools: is this the latest read of this file?
      let filePath: string | undefined;
      let isLatestFile = true;
      if (part.tool === "read_file" || part.tool === "read") {
        const inputStr = typeof part.state.input === "string"
          ? part.state.input
          : JSON.stringify(part.state.input);
        filePath = extractFilePath(inputStr);
        if (filePath) isLatestFile = fileLatest.get(`read:${filePath}`) === msgIdx;
      }

      // Keep if this is both the latest content AND latest file read (or not a read tool)
      if (isLatestContent && isLatestFile) return part;

      // This is a duplicate — replace with compact annotation
      partsChanged = true;
      return {
        ...part,
        state: {
          ...part.state,
          output: dedupAnnotation(part.tool, filePath),
        },
      } as LorePart;
    });

    if (!partsChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });

  return changed ? result : messages;
}

// Ensure every tool part in the window has a terminal state (completed or error).
// Pending/running tool parts produce tool_use blocks at the API level but have no
// output to generate a matching tool_result — causing Anthropic to reject the request
// with "tool_use ids were found without tool_result blocks immediately after".
// This happens when a session errors mid-tool-execution (e.g. context overflow) and
// the tool part remains in pending/running state on the next transform.
// Converting to error state generates both tool_use + tool_result(is_error=true).
function sanitizeToolParts(
  messages: MessageWithParts[],
): MessageWithParts[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.info.role !== "assistant") return msg;

    let partsChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolPart(part)) return part;
      const { status } = part.state;
      if (status === "completed" || status === "error") return part;

      // pending or running → convert to error so SDK emits tool_result
      partsChanged = true;
      const now = Date.now();
      return {
        ...part,
        state: {
          status: "error" as const,
          input: part.state.input,
          error: "[tool execution interrupted — session recovered]",
          metadata:
            "metadata" in part.state ? part.state.metadata : undefined,
          time: {
            start: "time" in part.state ? part.state.time.start : now,
            end: now,
          },
        },
      } as LorePart;
    });

    if (!partsChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });

  return changed ? result : messages;
}

function stripToolOutputs(parts: LorePart[]): LorePart[] {
  return parts.map((part) => {
    if (!isToolPart(part)) return part;
    if (part.state.status !== "completed") return part;
    return {
      ...part,
      state: {
        ...part.state,
        output: toolStripAnnotation(part.tool, part.state.output),
      },
    } as LorePart;
  });
}

function stripToTextOnly(parts: LorePart[]): LorePart[] {
  const stripped = parts
    .filter(isTextPart)
    .map((p) => ({
      ...p,
      text: normalize(stripSystemReminders(p.text)),
    }))
    .filter((p) => p.text.trim().length > 0) as LorePart[];
  // Guard against empty result — keep a placeholder so the message survives
  // toModelMessages and the conversation doesn't end with an assistant message.
  if (stripped.length === 0 && parts.length > 0) {
    const first = parts.find(isTextPart);
    if (first) return [{ ...first, text: "..." } as LorePart];
  }
  return stripped;
}

// --- Phase 2: Temporal anchoring at read time ---

function formatRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 60) return "1 month ago";
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`;
}

function parseDateFromContent(s: string): Date | null {
  // "Month Day, Year" e.g. "January 15, 2026"
  const simple = s.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (simple) {
    const d = new Date(`${simple[1]} ${simple[2]}, ${simple[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  // "Month D-D, Year" range — use start
  const range = s.match(/([A-Z][a-z]+)\s+(\d{1,2})-\d{1,2},?\s+(\d{4})/);
  if (range) {
    const d = new Date(`${range[1]} ${range[2]}, ${range[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  // "late/early/mid Month Year"
  const vague = s.match(/(late|early|mid)[- ]?([A-Z][a-z]+)\s+(\d{4})/i);
  if (vague) {
    const day =
      vague[1].toLowerCase() === "early"
        ? 7
        : vague[1].toLowerCase() === "late"
          ? 23
          : 15;
    const d = new Date(`${vague[2]} ${day}, ${vague[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Expand "(meaning DATE)" and "(estimated DATE)" annotations with a relative offset.
// Past future-intent lines get "(likely already happened)" appended.
function expandInlineEstimatedDates(text: string, now: Date): string {
  return text.replace(
    /\(((?:meaning|estimated)\s+)([^)]+\d{4})\)/gi,
    (match, prefix: string, dateContent: string) => {
      const d = parseDateFromContent(dateContent);
      if (!d) return match;
      const rel = formatRelativeTime(d, now);
      // Detect future-intent by looking backwards on the same line
      const matchIdx = text.indexOf(match);
      const lineStart = text.lastIndexOf("\n", matchIdx) + 1;
      const linePrefix = text.slice(lineStart, matchIdx);
      const isFutureIntent =
        /\b(?:will|plans?\s+to|planning\s+to|going\s+to|intends?\s+to)\b/i.test(
          linePrefix,
        );
      if (d < now && isFutureIntent)
        return `(${prefix}${dateContent} — ${rel}, likely already happened)`;
      return `(${prefix}${dateContent} — ${rel})`;
    },
  );
}

// Add relative time annotations to "Date: Month D, Year" section headers
// and gap markers between non-consecutive dates.
function addRelativeTimeToObservations(text: string, now: Date): string {
  // First pass: expand inline "(meaning DATE)" annotations
  const withInline = expandInlineEstimatedDates(text, now);

  // Second pass: annotate date headers and add gap markers
  const dateHeaderRe = /^(Date:\s*)([A-Z][a-z]+ \d{1,2}, \d{4})$/gm;
  const found: Array<{
    index: number;
    date: Date;
    full: string;
    prefix: string;
    ds: string;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = dateHeaderRe.exec(withInline)) !== null) {
    const d = new Date(m[2]);
    if (!isNaN(d.getTime()))
      found.push({
        index: m.index,
        date: d,
        full: m[0],
        prefix: m[1],
        ds: m[2],
      });
  }
  if (!found.length) return withInline;

  let result = "";
  let last = 0;
  for (let i = 0; i < found.length; i++) {
    const curr = found[i];
    const prev = found[i - 1];
    result += withInline.slice(last, curr.index);
    // Gap marker between non-consecutive dates
    if (prev) {
      const gapDays = Math.floor(
        (curr.date.getTime() - prev.date.getTime()) / 86400000,
      );
      if (gapDays > 1) {
        const gap =
          gapDays < 7
            ? `[${gapDays} days later]`
            : gapDays < 14
              ? "[1 week later]"
              : gapDays < 30
                ? `[${Math.floor(gapDays / 7)} weeks later]`
                : gapDays < 60
                  ? "[1 month later]"
                  : `[${Math.floor(gapDays / 30)} months later]`;
        result += `\n${gap}\n\n`;
      }
    }
    result += `${curr.prefix}${curr.ds} (${formatRelativeTime(curr.date, now)})`;
    last = curr.index + curr.full.length;
  }
  result += withInline.slice(last);
  return result;
}

// Build synthetic user/assistant message pair wrapping formatted distillation text.
// Shared by the cached and non-cached prefix paths.
function buildPrefixMessages(formatted: string): MessageWithParts[] {
  return [
    {
      info: {
        id: "lore-distilled-user",
        sessionID: "",
        role: "user" as const,
        time: { created: 0 },
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: "lore-distilled-user-part",
          sessionID: "",
          messageID: "lore-distilled-user",
          type: "text" as const,
          text: "[Memory context follows — do not reference this format in your responses]",
          time: { start: 0, end: 0 },
        },
      ],
    },
    {
      info: {
        id: "lore-distilled-assistant",
        sessionID: "",
        role: "assistant" as const,
        time: { created: 0 },
        parentID: "lore-distilled-user",
        modelID: "",
        providerID: "",
        mode: "memory",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: "lore-distilled-assistant-part",
          sessionID: "",
          messageID: "lore-distilled-assistant",
          type: "text" as const,
          text: formatted + "\n\nI'm ready to continue.",
          time: { start: 0, end: 0 },
        },
      ],
    },
  ];
}

// Build a synthetic message pair containing the distilled history.
// Non-cached path — used by layers 2-4 which already cause full cache invalidation.
function distilledPrefix(distillations: Distillation[]): MessageWithParts[] {
  if (!distillations.length) return [];
  const now = new Date();
  const annotated = distillations.map((d) => ({
    ...d,
    observations: addRelativeTimeToObservations(d.observations, now),
  }));
  const formatted = formatDistillations(annotated);
  if (!formatted) return [];
  return buildPrefixMessages(formatted);
}

// --- Approach C: Append-only distillation prefix cache ---
//
// Caches the rendered prefix text per session. When new distillations arrive,
// only renders the new rows and appends them to the cached text. This keeps
// the prefix byte-identical between distillation runs, preserving the prompt
// cache. Only meta-distillation (which rewrites gen-0 rows into gen-1) causes
// a full re-render — and that happens roughly every 80-100 turns.

type PrefixCache = {
  /** The session this cache belongs to */
  sessionID: string;
  /** ID of the last distillation row included in the cached text */
  lastDistillationID: string;
  /** Number of rows that produced the cached text */
  rowCount: number;
  /** The rendered text (used to build delta appends) */
  cachedText: string;
  /** Ready-to-use message pair */
  prefixMessages: MessageWithParts[];
  /** Token estimate of prefixMessages */
  prefixTokens: number;
};

/**
 * Return the distilled prefix messages, reusing cached content when possible.
 * Uses per-session state from sessState.prefixCache (no module-level cache).
 *
 * Cache hit  — no new rows: returns the exact same prefixMessages object
 *              (byte-identical content, prompt cache preserved).
 * Cache miss — new rows appended: renders only the delta, appends to cached
 *              text, updates cache.
 * Full reset — first call, or rows were rewritten by meta-distillation:
 *              renders everything from scratch.
 */
function distilledPrefixCached(
  distillations: Distillation[],
  sessionID: string,
  sessState: SessionState,
): { messages: MessageWithParts[]; tokens: number } {
  if (!distillations.length) {
    sessState.prefixCache = null;
    return { messages: [], tokens: 0 };
  }

  const lastRow = distillations[distillations.length - 1];
  const prefixCache = sessState.prefixCache;

  // Cache is valid when: same session, row count only grew (no rewrites),
  // and the last previously-cached row still exists at the same position.
  const cacheValid =
    prefixCache !== null &&
    prefixCache.sessionID === sessionID &&
    prefixCache.rowCount <= distillations.length &&
    (prefixCache.rowCount === 0 ||
      distillations[prefixCache.rowCount - 1]?.id ===
        prefixCache.lastDistillationID);

  if (cacheValid) {
    if (prefixCache!.lastDistillationID === lastRow.id) {
      // No new rows — return cached prefix as-is (byte-identical for prompt cache)
      return {
        messages: prefixCache!.prefixMessages,
        tokens: prefixCache!.prefixTokens,
      };
    }

    // New rows appended — render only the delta and append to cached text
    const newRows = distillations.slice(prefixCache!.rowCount);
    const now = new Date();
    const annotated = newRows.map((d) => ({
      ...d,
      observations: addRelativeTimeToObservations(d.observations, now),
    }));
    const deltaText = formatDistillations(annotated);

    if (deltaText) {
      const fullText = prefixCache!.cachedText + "\n\n" + deltaText;
      const messages = buildPrefixMessages(fullText);
      const tokens = messages.reduce((sum, m) => sum + estimateMessage(m), 0);
      sessState.prefixCache = {
        sessionID,
        lastDistillationID: lastRow.id,
        rowCount: distillations.length,
        cachedText: fullText,
        prefixMessages: messages,
        prefixTokens: tokens,
      };
      return { messages, tokens };
    }
  }

  // Full re-render: first call or meta-distillation rewrote rows
  const now = new Date();
  const annotated = distillations.map((d) => ({
    ...d,
    observations: addRelativeTimeToObservations(d.observations, now),
  }));
  const fullText = formatDistillations(annotated);
  if (!fullText) {
    sessState.prefixCache = null;
    return { messages: [], tokens: 0 };
  }

  const messages = buildPrefixMessages(fullText);
  const tokens = messages.reduce((sum, m) => sum + estimateMessage(m), 0);
  sessState.prefixCache = {
    sessionID,
    lastDistillationID: lastRow.id,
    rowCount: distillations.length,
    cachedText: fullText,
    prefixMessages: messages,
    prefixTokens: tokens,
  };
  return { messages, tokens };
}

// For testing only — reset prefix cache state for a specific session (or all)
export function resetPrefixCache(sessionID?: string) {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) state.prefixCache = null;
  } else {
    for (const state of sessionStates.values()) state.prefixCache = null;
  }
}

// --- Approach B: Lazy raw window eviction ---
//
// Tracks the ID of the first (oldest) message in the previous raw window.
// On the next turn, if the window starting at that message still fits within
// the raw budget, the cutoff is pinned — no messages are evicted and the raw
// window stays byte-identical for caching purposes. Only when the pinned
// window no longer fits (e.g. a large tool response pushed us over) is the
// cutoff allowed to advance forward by one message at a time.
//
// This eliminates the "window sliding on every turn" problem that was the
// dominant source of cache misses in gradient mode: each new turn appends a
// message to the conversation, but the start of the raw window only moves
// when it must.
//
// Reset conditions: session changes, or layer escalates to 2+ (the pinned
// window was too large even with stripping — something genuinely changed).

type RawWindowCache = {
  sessionID: string;
  /** ID of the first message in the pinned raw window */
  firstMessageID: string;
};

// For testing only — reset raw window cache state for a specific session (or all)
export function resetRawWindowCache(sessionID?: string) {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) state.rawWindowCache = null;
  } else {
    for (const state of sessionStates.values()) state.rawWindowCache = null;
  }
}

/**
 * Layer-1 tryFit with lazy eviction.
 * Uses per-session rawWindowCache from sessState (no module-level cache).
 *
 * Attempts to reuse the previous raw window cutoff before falling back to a
 * full backward scan. If the pinned window fits, returns it unchanged (same
 * message objects, byte-identical for prompt caching). If it doesn't fit,
 * delegates to the normal tryFit which finds the new minimal cutoff and
 * updates the cache.
 */
function tryFitStable(input: {
  messages: MessageWithParts[];
  prefix: MessageWithParts[];
  prefixTokens: number;
  distilledBudget: number;
  rawBudget: number;
  sessionID: string;
  sessState: SessionState;
}): Omit<TransformResult, "layer" | "usable" | "distilledBudget" | "rawBudget"> | null {
  // If the prefix already overflows its budget there's no point trying.
  if (input.prefixTokens > input.distilledBudget && input.prefix.length > 0)
    return null;

  const rawWindowCache = input.sessState.rawWindowCache;
  const cacheValid =
    rawWindowCache !== null && rawWindowCache.sessionID === input.sessionID;

  if (cacheValid) {
    const pinnedIdx = input.messages.findIndex(
      (m) => m.info.id === rawWindowCache!.firstMessageID,
    );

    if (pinnedIdx !== -1) {
      // Measure the token cost of the pinned window.
      const pinnedWindow = input.messages.slice(pinnedIdx);
      const pinnedTokens = pinnedWindow.reduce(
        (sum, m) => sum + estimateMessage(m),
        0,
      );

      if (pinnedTokens <= input.rawBudget) {
        // Pinned window still fits — keep it. Apply system-reminder cleanup
        // only (strip:"none" is the layer-1 mode), returning the same message
        // object references wherever nothing changed.
        const processed = pinnedWindow.map((msg) => {
          const parts = cleanParts(msg.parts);
          return parts !== msg.parts ? { info: msg.info, parts } : msg;
        });
        const total = input.prefixTokens + pinnedTokens;
        return {
          messages: [...input.prefix, ...processed],
          distilledTokens: input.prefixTokens,
          rawTokens: pinnedTokens,
          totalTokens: total,
        };
      }
      // Pinned window is too large — fall through to the normal scan below.
    }
  }

  // Normal backward scan to find the tightest fitting cutoff.
  const result = tryFit({
    messages: input.messages,
    prefix: input.prefix,
    prefixTokens: input.prefixTokens,
    distilledBudget: input.distilledBudget,
    rawBudget: input.rawBudget,
    strip: "none",
  });

  if (result) {
    // Update the raw window cache: the first non-prefix message is the oldest
    // raw message in the new window. Pin to its ID for the next turn.
    const rawStart = result.messages[input.prefix.length];
    if (rawStart) {
      input.sessState.rawWindowCache = {
        sessionID: input.sessionID,
        firstMessageID: rawStart.info.id,
      };
    }
  }

  return result;
}

export type SafetyLayer = 0 | 1 | 2 | 3 | 4;

export type TransformResult = {
  messages: MessageWithParts[];
  layer: SafetyLayer;
  distilledTokens: number;
  rawTokens: number;
  totalTokens: number;
  // Budget context (for display in context inspector)
  usable: number;
  distilledBudget: number;
  rawBudget: number;
};

// Signal that we need urgent distillation
let urgentDistillation = false;
export function needsUrgentDistillation(): boolean {
  const v = urgentDistillation;
  urgentDistillation = false;
  return v;
}

function transformInner(input: {
  messages: MessageWithParts[];
  projectPath: string;
  sessionID?: string;
}): TransformResult {
  const cfg = config();
  const overhead = getOverhead();
  // Usable = full context minus output reservation minus fixed overhead (system + tools)
  // minus LTM tokens already injected into the system prompt this turn.
  const usable = Math.max(
    0,
    contextLimit - outputReserved - overhead - ltmTokens,
  );
  const distilledBudget = Math.floor(usable * cfg.budget.distilled);
  const rawBudget = Math.floor(usable * cfg.budget.raw);

  // --- Force escalation (reactive error recovery) ---
  // When the API previously rejected with "prompt is too long", skip layers
  // below the forced minimum to ensure enough trimming on the next attempt.
  // One-shot: consumed here and reset to 0 (both in-memory and on disk).
  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  const sessState = sid ? getSessionState(sid) : makeSessionState();
  let effectiveMinLayer = sessState.forceMinLayer;
  sessState.forceMinLayer = 0;
  if (sid && effectiveMinLayer > 0) saveForceMinLayer(sid, 0);

  // --- Approach A: Cache-preserving passthrough ---
  // Use exact token count from the previous API response when available.
   // Only the delta (messages added since last call) uses chars/3 estimation,
   // making the layer-0 decision highly accurate from the API's own tokenizer.
  // maxInput = absolute ceiling the API enforces: input_tokens + max_tokens <= context
  const maxInput = contextLimit - outputReserved;

  // True when we have real API token data from a previous turn in this session.
  // When false (first turn / session change), chars/3 estimates may still diverge
  // from the real tokenizer — so tryFit output must be validated with a safety
  // multiplier before being used.
  const calibrated = sessState.lastKnownInput > 0;

  // On uncalibrated turns, apply this multiplier to tryFit's estimated total to
  // approximate the real token count. chars/3 undercounts by ~1.68x on real data,
  // but overhead EMA captures most of the gap. 1.5 provides a safe margin.
  const UNCALIBRATED_SAFETY = 1.5;

  // Returns true if the tryFit result is safe to use: either we have calibrated
  // data (exact) or the estimated total * safety factor fits within maxInput.
  function fitsWithSafetyMargin(result: { totalTokens: number } | null): boolean {
    if (!result) return false;
    if (calibrated) return true;
    return result.totalTokens * UNCALIBRATED_SAFETY <= maxInput;
  }

  // --- Sticky layer guard (Option C) ---
  // After a compressed turn (layer >= 1), don't allow layer 0 re-entry until
  // the session genuinely shrinks (e.g. after compaction deletes messages).
  // Prevents the calibration oscillation: a compressed turn stores
  // lastKnownInput=100K for a 50-message window, but the next turn's
  // input.messages has 300 raw messages. The delta estimation treats the 250
  // evicted messages as "new" and undercounts their tokens, producing an
  // expectedInput that fits in layer 0 — but the actual tokens are ~190K.
  // Only applied when calibrated (same session, per-session state) to avoid
  // affecting other sessions including worker sessions.
  if (calibrated && sessState.lastLayer >= 1 && input.messages.length >= sessState.lastKnownMessageCount) {
    effectiveMinLayer = Math.max(effectiveMinLayer, 1) as SafetyLayer;
  }

  let expectedInput: number;
  if (calibrated) {
    // Exact approach: prior API count + estimate of only genuinely new messages.
    // Use message ID tracking (Option B) to identify new messages accurately.
    // After compression, the "last window" is a subset of the full message array —
    // counting by index would treat evicted messages as new (off-by-250 error).
    const newMessages = sessState.lastWindowMessageIDs.size > 0
      ? input.messages.filter((m) => !sessState.lastWindowMessageIDs.has(m.info.id))
      : input.messages.slice(-Math.max(0, input.messages.length - sessState.lastKnownMessageCount));
    const newMsgTokens = newMessages.reduce((s, m) => s + estimateMessage(m), 0);
    const ltmDelta = ltmTokens - sessState.lastKnownLtm;
    expectedInput = sessState.lastKnownInput + newMsgTokens + ltmDelta;
  } else {
    // First turn or session change: fall back to chars/3 estimate + overhead.
    const messageTokens = input.messages.reduce((s, m) => s + estimateMessage(m), 0);
    expectedInput = messageTokens + overhead + ltmTokens;
  }

  // When uncalibrated, apply safety multiplier to the layer-0 decision too.
  // chars/3 undercounts by ~1.63x on real sessions — without this, a session
  // estimated at 146K passes layer 0 but actually costs 214K → overflow.
  const layer0Input = calibrated ? expectedInput : expectedInput * UNCALIBRATED_SAFETY;

  // Cost-aware layer-0 cap: use the smaller of the API limit and the cost-derived
  // cap. When maxLayer0Tokens is 0 (disabled), fall back to pure maxInput.
  let layer0Ceiling = maxLayer0Tokens > 0
    ? Math.min(maxInput, maxLayer0Tokens)
    : maxInput;

  // Cold-cache awareness: on the first turn (uncalibrated = no prior API data),
  // the entire context is a cache WRITE at 12.5× the cache-read price. Use 70%
  // of the normal cap to reduce the cold-write cost.
  if (!calibrated && layer0Ceiling < maxInput) {
    layer0Ceiling = Math.floor(layer0Ceiling * 0.7);
  }

  if (effectiveMinLayer === 0 && layer0Input <= layer0Ceiling) {
    // All messages fit — return unmodified to preserve append-only prompt-cache pattern.
    // Raw messages are strictly better context than lossy distilled summaries.
    const messageTokens = calibrated
      ? expectedInput - (ltmTokens - sessState.lastKnownLtm)  // approximate raw portion
      : expectedInput - overhead - ltmTokens;
    return {
      messages: input.messages,
      layer: 0,
      distilledTokens: 0,
      rawTokens: Math.max(0, messageTokens),
      totalTokens: Math.max(0, messageTokens),
      usable,
      distilledBudget,
      rawBudget,
    };
  }

  // --- Gradient mode: context exhausted (or force-escalated), compress older messages ---

  // Pre-pass: deduplicate repeated tool outputs before layer selection.
  // Keeps only the latest occurrence of each unique output, replacing earlier
  // ones with compact annotations. This can save thousands of tokens for sessions
  // with repeated file reads, potentially avoiding escalation to higher layers.
  const turnStart = currentTurnStart(input.messages);
  const dedupMessages = deduplicateToolOutputs(input.messages, turnStart);

  const distillations = sid ? loadDistillations(input.projectPath, sid) : [];

  // Layer 1 uses the append-only cached prefix (Approach C) to keep the
  // distilled content byte-identical between distillation runs, preserving
  // the prompt cache. Layers 2-4 already cause full cache invalidation via
  // tool stripping / message restructuring, so they use the non-cached path.
  const cached = sid
    ? distilledPrefixCached(distillations, sid, sessState)
    : (() => {
        const msgs = distilledPrefix(distillations);
        return { messages: msgs, tokens: msgs.reduce((sum, m) => sum + estimateMessage(m), 0) };
      })();

  // Layer 1: Normal budget allocation with lazy raw window eviction (Approach B).
  // tryFitStable reuses the previous cutoff when it still fits, keeping the raw
  // window byte-identical across turns for prompt caching. Only advances the
  // cutoff when a genuinely oversized message forces eviction.
  // Skipped when force-escalated to layer 2+ (previous attempt already failed at this level).
  if (effectiveMinLayer <= 1) {
    const layer1 = sid
      ? tryFitStable({
          messages: dedupMessages,
          prefix: cached.messages,
          prefixTokens: cached.tokens,
          distilledBudget,
          rawBudget,
          sessionID: sid,
          sessState,
        })
      : tryFit({
          messages: dedupMessages,
          prefix: cached.messages,
          prefixTokens: cached.tokens,
          distilledBudget,
          rawBudget,
          strip: "none",
        });
    if (fitsWithSafetyMargin(layer1)) return { ...layer1!, layer: 1, usable, distilledBudget, rawBudget };
  }

  // Layer 1 didn't fit (or was force-skipped) — reset the raw window cache.
  // Layers 2-4 use full scans and already break the prompt cache.
  sessState.rawWindowCache = null;

  // Layer 2: Strip tool outputs from older messages, keep last 2 turns
  // Skipped when force-escalated to layer 3+.
  if (effectiveMinLayer <= 2) {
    const layer2 = tryFit({
      messages: dedupMessages,
      prefix: cached.messages,
      prefixTokens: cached.tokens,
      distilledBudget,
      rawBudget: Math.floor(usable * 0.5), // give raw more room
      strip: "old-tools",
      protectedTurns: 2,
    });
    if (fitsWithSafetyMargin(layer2)) {
      urgentDistillation = true;
      return { ...layer2!, layer: 2, usable, distilledBudget, rawBudget };
    }
  }

  // Layer 3: Strip ALL tool outputs, drop oldest distillations
  const trimmedDistillations = distillations.slice(-5);
  const trimmedPrefix = distilledPrefix(trimmedDistillations);
  const trimmedPrefixTokens = trimmedPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );
  const layer3 = tryFit({
    messages: dedupMessages,
    prefix: trimmedPrefix,
    prefixTokens: trimmedPrefixTokens,
    distilledBudget: Math.floor(usable * 0.15),
    rawBudget: Math.floor(usable * 0.55),
    strip: "all-tools",
  });
  if (fitsWithSafetyMargin(layer3)) {
    urgentDistillation = true;
    return { ...layer3!, layer: 3, usable, distilledBudget, rawBudget };
  }

  // Layer 4: Emergency — last 2 distillations + token-budget raw tail.
  // We do NOT strip tool parts here: doing so would cause an infinite tool-call loop because
  // the model would lose sight of its own in-progress tool calls and re-invoke them endlessly.
  // Instead, we aggressively drop old messages and rely on the `recall` tool (which the model
  // is always instructed to use) to retrieve any older details it needs.
  //
  // Token-budget tail (F7): instead of a fixed `slice(-3)`, size the raw
  // tail using `clamp(usable * 0.25, 2_000, 8_000)` tokens — matching
  // upstream OpenCode's tail-budget formula for compaction. The current
  // agentic turn (from `currentTurnStart()`) is ALWAYS fully included even
  // if it alone exceeds the tail budget — layer 4 is the terminal layer
  // and must always return. Remaining budget is filled backward with older
  // messages.
  urgentDistillation = true;
  const nuclearDistillations = distillations.slice(-2);
  const nuclearPrefix = distilledPrefix(nuclearDistillations);
  const nuclearPrefixTokens = nuclearPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

  // Token budget for the raw tail. clamp(usable * 0.25, 2K, 8K).
  const tailBudget = Math.max(2_000, Math.min(8_000, Math.floor(usable * 0.25)));

  // Current turn is always included (non-negotiable — dropping it causes
  // the infinite tool-call loop). Clean parts but never strip tool outputs.
  const nuclearTurnStart = currentTurnStart(input.messages);
  const currentTurn = input.messages.slice(nuclearTurnStart).map((m) => ({
    info: m.info,
    parts: cleanParts(m.parts),
  }));
  const currentTurnTokens = currentTurn.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

  // Fill remaining budget walking backward from the turn boundary.
  const olderMessages: MessageWithParts[] = [];
  let olderTokens = 0;
  const remaining = Math.max(0, tailBudget - currentTurnTokens);
  for (let i = nuclearTurnStart - 1; i >= 0 && olderTokens < remaining; i--) {
    const msg = input.messages[i];
    const est = estimateMessage(msg);
    if (olderTokens + est > remaining) break;
    olderMessages.unshift({
      info: msg.info,
      parts: cleanParts(msg.parts),
    });
    olderTokens += est;
  }

  const nuclearRaw = [...olderMessages, ...currentTurn];
  const nuclearRawTokens = olderTokens + currentTurnTokens;

  return {
    messages: [...nuclearPrefix, ...nuclearRaw],
    layer: 4,
    distilledTokens: nuclearPrefixTokens,
    rawTokens: nuclearRawTokens,
    totalTokens: nuclearPrefixTokens + nuclearRawTokens,
    usable,
    distilledBudget,
    rawBudget,
  };
}

// Public wrapper: records the compressed message count for calibration.
// Calibration needs to know how many messages were SENT to the model (the
// compressed window), not the total DB count. On layer 0 these are equal;
// on layers 1-4 the compressed window is smaller, and the delta on the next
// turn must be computed relative to the compressed count — otherwise the
// expected input on the next turn is anchored to the compressed input token
// count but the "new messages" delta is computed against the full DB count,
// making newMsgCount ≈ 0 and causing layer 0 passthrough on an overflowing session.
export function transform(input: {
  messages: MessageWithParts[];
  projectPath: string;
  sessionID?: string;
}): TransformResult {
  const result = transformInner(input);

  // Sanitize non-terminal tool parts before the window reaches the SDK.
  // Must run after transformInner (covers all layers 0-4) and before the
  // trailing-drop loop in index.ts sees the messages.
  result.messages = sanitizeToolParts(result.messages);

  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  if (sid) {
    const state = getSessionState(sid);
    state.lastTransformedCount = result.messages.length;
    state.lastTransformEstimate = result.totalTokens;
    state.lastLayer = result.layer;
    state.lastWindowMessageIDs = new Set(result.messages.map((m) => m.info.id));
    // Mark wall-clock for onIdleResume() — must record on every transform()
    // so the next-turn idle check has an accurate baseline. Done after the
    // result fields above so a thrown transformInner doesn't update it.
    state.lastTurnAt = Date.now();

    // --- Cache-bust diagnostics (LORE_DEBUG only) ---
    // Track byte-identity of the message prefix. When the prefix hash changes
    // between consecutive turns, it means Anthropic's prompt cache is invalidated
    // and the entire context is re-written (12.5× cache-read price). This helps
    // identify which code paths are breaking byte-identity.
    const prefixIds = result.messages.slice(0, 5).map((m) => m.info.id).join(",");
    const prefixHash = `${result.layer}:${prefixIds}`;
    if (state.lastPrefixHash && state.lastPrefixHash !== prefixHash) {
      log.info(
        `cache-bust detected: session=${sid} layer=${state.lastLayer}→${result.layer}` +
        ` msgs=${state.lastTransformedCount}→${result.messages.length}` +
        ` prefix=${state.lastPrefixHash.slice(0, 30)}→${prefixHash.slice(0, 30)}`,
      );
    }
    state.lastPrefixHash = prefixHash;

    // --- Compaction hint ---
    if (result.layer >= 2) {
      state.consecutiveHighLayer++;
      if (state.consecutiveHighLayer === 3) {
        log.info(
          `session ${sid} has been at gradient layer ${result.layer}+ for 3 consecutive turns.` +
          ` Consider running /compact to reset the context window.`,
        );
      }
    } else {
      state.consecutiveHighLayer = 0;
    }

    log.info(
      `gradient: session=${sid} layer=${result.layer} tokens=${result.totalTokens}` +
      ` (distilled=${result.distilledTokens} raw=${result.rawTokens})` +
      ` usable=${result.usable} cap=${maxLayer0Tokens || "off"}`,
    );
  }
  return result;
}

// Compute our message-only estimate for a set of messages (for calibration use)
export function estimateMessages(messages: MessageWithParts[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
}

// Identify the current agentic turn: the last user message plus all subsequent
// assistant messages that share its ID as parentID. These messages form an atomic
// unit — the model must see all of them or it will lose track of its own prior
// tool calls and re-issue them in an infinite loop.
function currentTurnStart(messages: MessageWithParts[]): number {
  // Find the last user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return 0; // no user message — treat all as current turn
  return lastUserIdx;
}

function tryFit(input: {
  messages: MessageWithParts[];
  prefix: MessageWithParts[];
  prefixTokens: number;
  distilledBudget: number;
  rawBudget: number;
  strip: "none" | "old-tools" | "all-tools";
  protectedTurns?: number;
}): Omit<TransformResult, "layer" | "usable" | "distilledBudget" | "rawBudget"> | null {
  // If distilled prefix exceeds its budget, fail this layer
  if (input.prefixTokens > input.distilledBudget && input.prefix.length > 0)
    return null;

  // Identify the current turn (last user message + all following assistant messages).
  // These are always included — they must never be evicted. If they alone exceed the
  // raw budget, escalate to the next layer (which strips tool outputs to reduce size).
  const turnStart = currentTurnStart(input.messages);
  const currentTurn = input.messages.slice(turnStart);
  const currentTurnTokens = currentTurn.reduce((s, m) => s + estimateMessage(m), 0);

  if (currentTurnTokens > input.rawBudget) {
    // Current turn alone exceeds budget — can't fit even with everything else dropped.
    // Signal failure so the caller escalates to the next layer (tool-output stripping).
    return null;
  }

  // Walk backwards through older messages (before the current turn),
  // filling the remaining budget after reserving space for the current turn.
  const olderMessages = input.messages.slice(0, turnStart);
  const remainingBudget = input.rawBudget - currentTurnTokens;
  let olderTokens = 0;
  let cutoff = olderMessages.length; // default: include none of the older messages
  const protectedTurns = input.protectedTurns ?? 0;

  for (let i = olderMessages.length - 1; i >= 0; i--) {
    const msg = olderMessages[i];
    const tokens = estimateMessage(msg);
    if (olderTokens + tokens > remainingBudget) {
      cutoff = i + 1;
      break;
    }
    olderTokens += tokens;
    if (i === 0) cutoff = 0;
  }

  const rawMessages = [...olderMessages.slice(cutoff), ...currentTurn];
  const rawTokens = olderTokens + currentTurnTokens;

  // Apply system-reminder stripping + optional tool output stripping.
  // The current turn (end of rawMessages) is always "protected" — never stripped.
  const currentTurnSet = new Set(currentTurn.map((m) => m.info.id));
  const processed = rawMessages.map((msg, idx) => {
    const fromEnd = rawMessages.length - idx;
    const isCurrentTurn = currentTurnSet.has(msg.info.id);
    const isProtected =
      isCurrentTurn ||
      input.strip === "none" ||
      (input.strip === "old-tools" && fromEnd <= protectedTurns * 2);
    const parts = isProtected
      ? cleanParts(msg.parts)
      : cleanParts(
          input.strip === "all-tools"
            ? stripToolOutputs(msg.parts)
            : stripToolOutputs(msg.parts),
        );
    const changed = parts !== msg.parts;
    return changed ? { info: msg.info, parts } : msg;
  });

  const total = input.prefixTokens + rawTokens;
  return {
    messages: [...input.prefix, ...processed],
    distilledTokens: input.prefixTokens,
    rawTokens,
    totalTokens: total,
  };
}
