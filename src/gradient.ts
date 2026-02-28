import type { Message, Part } from "@opencode-ai/sdk";
import { db, ensureProject, loadForceMinLayer, saveForceMinLayer } from "./db";
import { config } from "./config";
import { formatDistillations } from "./prompt";
import { normalize } from "./markdown";

type MessageWithParts = { info: Message; parts: Part[] };

// Token estimate: ~3 chars per token. Validated against real API data across
// 200+ turn-pairs: chars/3 gives ~1.68x ratio (actual/estimate), best among
// heuristics tested. The gap is overhead (system prompt, tool definitions,
// conversation structure) which calibratedOverhead captures via EMA.
function estimate(text: string): number {
  return Math.ceil(text.length / 3);
}

function estimateParts(parts: Part[]): number {
  let total = 0;
  for (const part of parts) {
    if (part.type === "text") total += estimate(part.text);
    else if (part.type === "reasoning" && part.text)
      total += estimate(part.text);
    else if (part.type === "tool" && part.state.status === "completed")
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

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  token_count: number;
  created_at: number;
  session_id: string;
};

function loadDistillations(
  projectPath: string,
  sessionID?: string,
): Distillation[] {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC"
    : "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? ORDER BY created_at ASC";
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

function cleanParts(parts: Part[]): Part[] {
  const cleaned = parts.map((part) => {
    if (part.type !== "text") return part;
    const text = stripSystemReminders(part.text);
    if (text === part.text) return part;
    return { ...part, text } as Part;
  });
  // Filter out text parts that became empty after stripping
  const filtered = cleaned.filter(
    (part) =>
      part.type !== "text" ||
      (part as Extract<Part, { type: "text" }>).text.trim().length > 0,
  );
  // If all parts were stripped (e.g. a user message that was purely build-switch synthetic
  // content), keep a minimal placeholder so the message survives toModelMessages.
  // Without this, the message gets dropped and the conversation ends with an assistant message,
  // causing Anthropic's "does not support assistant message prefill" error.
  if (filtered.length === 0 && parts.length > 0) {
    const first = parts[0];
    if (first.type === "text") {
      return [{ ...first, text: "..." } as Part];
    }
  }
  return filtered.length > 0 ? filtered : parts;
}

function stripToolOutputs(parts: Part[]): Part[] {
  return parts.map((part) => {
    if (part.type !== "tool") return part;
    if (part.state.status !== "completed") return part;
    return {
      ...part,
      state: {
        ...part.state,
        output: "[output omitted — use recall for details]",
      },
    } as Part;
  });
}

function stripToTextOnly(parts: Part[]): Part[] {
  const stripped = parts
    .filter((p) => p.type === "text")
    .map((p) => ({
      ...p,
      text: normalize(stripSystemReminders(p.text)),
    }))
    .filter((p) => p.text.trim().length > 0) as Part[];
  // Guard against empty result — keep a placeholder so the message survives
  // toModelMessages and the conversation doesn't end with an assistant message.
  if (stripped.length === 0 && parts.length > 0) {
    const first = parts.find((p) => p.type === "text");
    if (first) return [{ ...first, text: "..." } as Part];
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

  if (effectiveMinLayer === 0 && layer0Input <= maxInput) {
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
          messages: input.messages,
          prefix: cached.messages,
          prefixTokens: cached.tokens,
          distilledBudget,
          rawBudget,
          sessionID: sid,
          sessState,
        })
      : tryFit({
          messages: input.messages,
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
      messages: input.messages,
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
    messages: input.messages,
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

  // Layer 4: Emergency — last 2 distillations, last 3 raw messages with tool parts intact.
  // We do NOT strip tool parts here: doing so would cause an infinite tool-call loop because
  // the model would lose sight of its own in-progress tool calls and re-invoke them endlessly.
  // Instead, we aggressively drop old messages and rely on the `recall` tool (which the model
  // is always instructed to use) to retrieve any older details it needs.
  urgentDistillation = true;
  const nuclearDistillations = distillations.slice(-2);
  const nuclearPrefix = distilledPrefix(nuclearDistillations);
  const nuclearPrefixTokens = nuclearPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );
  const nuclearRaw = input.messages.slice(-3).map((m) => ({
    info: m.info,
    parts: cleanParts(m.parts),
  }));
  const nuclearRawTokens = nuclearRaw.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

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
  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  if (sid) {
    const state = getSessionState(sid);
    state.lastTransformedCount = result.messages.length;
    state.lastTransformEstimate = result.totalTokens;
    state.lastLayer = result.layer;
    state.lastWindowMessageIDs = new Set(result.messages.map((m) => m.info.id));
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
