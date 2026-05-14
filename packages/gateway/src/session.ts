/**
 * Session identification for the Lore gateway proxy.
 *
 * Uses a 3-tier identification strategy:
 *
 *  **Tier 1 — Known headers** (immediate match):
 *    `x-claude-code-session-id` (Claude Code), `x-session-affinity`
 *    (OpenCode). These persist for the entire client session and survive
 *    model changes, compaction, and context rewriting.
 *    `x-parent-session-id` links sub-agent requests to a parent session.
 *
 *  **Tier 2 — Learned headers** (bootstrapped via fingerprint):
 *    During the first few fingerprinted turns, collect candidate `x-`
 *    headers with ID-like values. Promote a header after it is stable
 *    within a session (same value across 3 turns) AND varies across
 *    different sessions (not a global constant like client version).
 *
 *  **Tier 3 — Fingerprint fallback** (bootstrap + unknown clients):
 *    SHA-256 of the first user message + auth suffix. Used to bootstrap
 *    Tier 2 learning and as permanent fallback for headerless clients.
 *    Model is intentionally excluded (model strings change mid-session).
 *
 * The session ID packs 8 random bytes + 4 bytes of unix timestamp
 * (seconds, big-endian) into 12 bytes, then base62-encodes them to a
 * compact alphanumeric string (~17 chars).
 *
 * This module has zero dependencies on `@loreai/core` — pure utility.
 */

// ---------------------------------------------------------------------------
// Base62 encoding
// ---------------------------------------------------------------------------

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;

/**
 * Encode a byte array to a base62 string.
 *
 * Interprets `bytes` as an unsigned big-endian integer, then repeatedly
 * divmods by 62, mapping each remainder to `BASE62_ALPHABET`. The result
 * is reversed so the most-significant digit comes first and zero-padded
 * to `minLength` for consistent output width.
 */
export function base62Encode(bytes: Uint8Array, minLength = 0): string {
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }

  if (n === 0n) return BASE62_ALPHABET[0].repeat(Math.max(1, minLength));

  const chars: string[] = [];
  while (n > 0n) {
    chars.push(BASE62_ALPHABET[Number(n % BASE)]);
    n /= BASE;
  }

  chars.reverse();

  // Pad to minLength for consistent width
  while (chars.length < minLength) {
    chars.unshift(BASE62_ALPHABET[0]);
  }

  return chars.join("");
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/** 12 bytes → base62 → at most 17 alphanumeric characters. */
const SESSION_ID_MIN_LENGTH = 17;

/**
 * Generate a new session ID.
 *
 * Layout (12 bytes):
 *   [0..7]  — 8 random bytes (session hash)
 *   [8..11] — 4 bytes unix timestamp (seconds, big-endian)
 */
export function generateSessionID(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf.subarray(0, 8));

  const ts = Math.floor(Date.now() / 1000);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(8, ts >>> 0, false); // big-endian

  return base62Encode(buf, SESSION_ID_MIN_LENGTH);
}

// ---------------------------------------------------------------------------
// Marker formatting / parsing
// ---------------------------------------------------------------------------

const MARKER_RE = /\[lore:([a-zA-Z0-9]+)\]/;

/** Format a session ID as the injectable text marker. */
export function formatMarker(sessionID: string): string {
  return `[lore:${sessionID}]`;
}

/**
 * Extract a session ID from a marker string, or `null` if the text
 * does not contain a valid marker.
 */
export function parseMarker(text: string): string | null {
  const m = MARKER_RE.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Message scanning
// ---------------------------------------------------------------------------

/**
 * Extract text from a single message's content field.
 *
 * Handles both Anthropic-style content (array of `{type:"text", text}` blocks)
 * and OpenAI-style content (plain string).
 */
function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        texts.push(block.text);
      }
    }
    return texts;
  }

  return [];
}

/**
 * Scan a message array for a `[lore:<sessionID>]` marker inside any
 * text content block. Returns the extracted session ID or `null`.
 */
export function scanForMarker(
  messages: Array<{ role: string; content: unknown }>,
): string | null {
  for (const msg of messages) {
    for (const text of extractTextParts(msg.content)) {
      const id = parseMarker(text);
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fingerprinting (fallback)
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 fingerprint from the first user message's content,
 * optionally incorporating an auth credential suffix.
 *
 * Returns the first 16 hex characters of the hash. Used as the Tier 3
 * (fallback) session correlator — combined with message-count proximity
 * to disambiguate forked sessions that share the same first message.
 *
 * Model is intentionally excluded: model strings change mid-session
 * (e.g. `claude-opus-4-7` → `opus-4-6`) and including them caused
 * confirmed session splits in production.
 */
export async function fingerprintMessages(
  messages: Array<{ role: string; content: unknown }>,
  extras?: { authSuffix?: string },
): Promise<string> {
  let firstUserContent = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      const texts = extractTextParts(msg.content);
      firstUserContent = texts.join("");
      break;
    }
  }

  const material = firstUserContent + (extras?.authSuffix ?? "");
  const encoded = new TextEncoder().encode(material);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hash);

  // First 16 hex chars (8 bytes)
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Message-count proximity matching
// ---------------------------------------------------------------------------

/**
 * Maximum message count difference for two requests to be considered
 * part of the same session. Normal turns add 2–6 messages (user +
 * assistant + tool calls); a forked session drops to the fork point.
 * A threshold of 20 accommodates bursts of tool-call messages while
 * reliably distinguishing forks (which typically differ by 50+).
 */
export const MESSAGE_COUNT_PROXIMITY_THRESHOLD = 20;

// ===========================================================================
// 3-Tier Session Identification
// ===========================================================================

// ---------------------------------------------------------------------------
// Tier 1: Known session headers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client type detection
// ---------------------------------------------------------------------------

/**
 * Client type for behavioral decisions (e.g. max_tokens sizing).
 *
 * - "claude-code": manages its own max_tokens (32K for modern models)
 * - "opencode": uses x-session-affinity, currently sends no max_tokens
 * - "generic": unknown client
 */
export type ClientType = "claude-code" | "opencode" | "generic";

/**
 * Detect the client type from request headers.
 *
 * Detection hierarchy:
 *  1. x-claude-code-session-id → "claude-code"
 *  2. x-session-affinity → "opencode"
 *  3. absence of all → "generic"
 *
 * For edge cases (Claude Code OAuth without session header), callers can
 * additionally check hasBillingHeader() on the system prompt.
 */
export function detectClientType(
  rawHeaders: Record<string, string>,
): ClientType {
  if (rawHeaders["x-claude-code-session-id"]) return "claude-code";
  if (rawHeaders["x-session-affinity"]) return "opencode";
  return "generic";
}

// ---------------------------------------------------------------------------
// Session identification
// ---------------------------------------------------------------------------

/**
 * Well-known HTTP headers that carry a persistent, unique session ID.
 * Checked in order — first match wins.
 */
export const KNOWN_SESSION_HEADERS = [
  "x-claude-code-session-id", // Claude Code (UUID, persists for CLI session)
  "x-session-affinity",       // OpenCode  (nanoid, persists for session)
  "x-lore-session-id",        // Lore plugins (Pi, etc.) — injected via registerProvider
] as const;

/**
 * Headers that link a sub-agent request to its parent session.
 * When present, the request is attributed to the parent session
 * rather than creating a new one.
 */
export const PARENT_SESSION_HEADERS = [
  "x-parent-session-id", // OpenCode sub-sessions
] as const;

/**
 * Extract a session ID from known headers (Tier 1).
 *
 * Returns the session ID value and the header name that provided it,
 * plus an optional parent session ID for sub-agent merging.
 * Returns `null` if no known session header is present.
 */
export function extractKnownSessionHeader(
  rawHeaders: Record<string, string>,
): { sessionId: string; headerName: string } | null {
  for (const name of KNOWN_SESSION_HEADERS) {
    const value = rawHeaders[name];
    if (value && value.length > 0) {
      return { sessionId: value, headerName: name };
    }
  }
  return null;
}

/**
 * Extract a parent session ID from known parent headers.
 * Returns the parent session ID value, or `null` if not present.
 */
export function extractParentSessionId(
  rawHeaders: Record<string, string>,
): string | null {
  for (const name of PARENT_SESSION_HEADERS) {
    const value = rawHeaders[name];
    if (value && value.length > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2: Learned session headers
// ---------------------------------------------------------------------------

/** Pattern for header names likely to carry a session ID. */
const SESSION_HEADER_PATTERN =
  /^x-.*session(?!.*(?:token|cookie|auth|secret))/i;

/** Pattern for header names carrying affinity/routing IDs. */
const AFFINITY_HEADER_PATTERN = /^x-.*affinity/i;

/**
 * ID-like value heuristic: 8–128 characters, alphanumeric + dash/underscore.
 * Rejects JWTs (contain `.`), URLs (contain `/`), booleans, timestamps,
 * and long content strings.
 */
const ID_VALUE_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

/** Number of consecutive stable turns before promoting a candidate header. */
const LEARNING_THRESHOLD = 3;

/** Candidate header being tracked during the learning phase. */
export interface HeaderCandidate {
  value: string;
  seenCount: number;
}

/**
 * Global tracking of distinct header values across all sessions.
 *
 * Used for the cross-session uniqueness check (Y-axis filter):
 * if a header has the same value across multiple fingerprinted
 * sessions, it's a global constant (client version, auth hash)
 * rather than a per-session identifier.
 *
 * Key: lowercase header name. Value: set of distinct values observed.
 */
const globalHeaderValues = new Map<string, Set<string>>();

/** Reset global header tracking state. Exported for tests only. */
export function _resetGlobalHeaderValues(): void {
  globalHeaderValues.clear();
}

/**
 * Check whether a header name is a plausible session ID carrier.
 *
 * Returns `true` for:
 *  - Any `x-` header whose name contains "session" (excluding
 *    token/cookie/auth/secret variants)
 *  - Any `x-` header whose name contains "affinity"
 */
export function isSessionHeaderName(name: string): boolean {
  return SESSION_HEADER_PATTERN.test(name) || AFFINITY_HEADER_PATTERN.test(name);
}

/**
 * Check whether a value looks like an identifier (not a JWT, URL,
 * boolean, or long content string).
 */
export function isIdLikeValue(value: string): boolean {
  return ID_VALUE_PATTERN.test(value);
}

/**
 * Collect candidate headers from a request that could carry session IDs.
 *
 * Returns all `x-` prefixed headers with ID-like values — both those
 * matching the session/affinity name patterns and generic ones. The
 * learning algorithm will filter by stability over time.
 */
export function collectCandidateHeaders(
  rawHeaders: Record<string, string>,
): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!name.startsWith("x-")) continue;
    if (!isIdLikeValue(value)) continue;

    // Accept if name matches session/affinity pattern, or if the value
    // is ID-like (the stability filter will sort out false positives).
    candidates.set(name, value);
  }
  return candidates;
}

/**
 * Run the header learning algorithm for a session.
 *
 * Called on every fingerprinted turn (Tier 3). Updates per-session
 * candidate tracking and global cross-session value maps.
 *
 * Returns the promoted header `{ name, value }` if a candidate
 * reached the learning threshold and passed the cross-session
 * uniqueness check, or `null` if still learning.
 */
export function learnHeaders(
  candidates: Map<string, HeaderCandidate> | undefined,
  rawHeaders: Record<string, string>,
): {
  updatedCandidates: Map<string, HeaderCandidate>;
  promoted: { name: string; value: string } | null;
} {
  const currentCandidates = candidates ?? new Map<string, HeaderCandidate>();
  const incoming = collectCandidateHeaders(rawHeaders);

  // Update candidates: increment stable, reset changed, add new
  for (const [name, value] of incoming) {
    const existing = currentCandidates.get(name);
    if (existing) {
      if (existing.value === value) {
        existing.seenCount++;
      } else {
        // Value changed — reset. Not a stable session ID.
        existing.value = value;
        existing.seenCount = 1;
      }
    } else {
      currentCandidates.set(name, { value, seenCount: 1 });
    }

    // Update global cross-session tracking
    let globalSet = globalHeaderValues.get(name);
    if (!globalSet) {
      globalSet = new Set();
      globalHeaderValues.set(name, globalSet);
    }
    globalSet.add(value);
  }

  // Remove candidates that disappeared from this request
  for (const [name] of currentCandidates) {
    if (!incoming.has(name)) {
      currentCandidates.delete(name);
    }
  }

  // Check for promotion: stable within session + unique across sessions
  // Prioritize headers whose name matches session/affinity patterns
  let promoted: { name: string; value: string } | null = null;

  // First pass: prefer pattern-matched names
  for (const [name, candidate] of currentCandidates) {
    if (candidate.seenCount < LEARNING_THRESHOLD) continue;
    if (!isSessionHeaderName(name)) continue;

    const globalSet = globalHeaderValues.get(name);
    if (globalSet && globalSet.size > 1) {
      promoted = { name, value: candidate.value };
      break;
    }
  }

  // Second pass: any ID-like header that passes both axes
  if (!promoted) {
    for (const [name, candidate] of currentCandidates) {
      if (candidate.seenCount < LEARNING_THRESHOLD) continue;

      const globalSet = globalHeaderValues.get(name);
      if (globalSet && globalSet.size > 1) {
        promoted = { name, value: candidate.value };
        break;
      }
    }
  }

  return { updatedCandidates: currentCandidates, promoted };
}
