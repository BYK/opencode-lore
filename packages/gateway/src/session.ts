/**
 * Session identification for the Lore gateway proxy.
 *
 * Raw LLM API requests carry no session ID, so the gateway injects a
 * text-block marker `[lore:<base62>]` into the first response of a new
 * session. Subsequent requests from the same session echo it back in
 * the message history, allowing the gateway to correlate turns.
 *
 * The session ID packs 8 random bytes + 4 bytes of unix timestamp
 * (seconds, big-endian) into 12 bytes, then base62-encodes them to a
 * compact alphanumeric string (~17 chars).
 *
 * A SHA-256 fingerprint of the first user message serves as a
 * belt-and-suspenders fallback for sessions that haven't received their
 * marker yet (e.g. the very first request before any response).
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
 * Compute a SHA-256 fingerprint from the first user message's content.
 *
 * Returns the first 16 hex characters of the hash. Used as the primary
 * session correlator — combined with message-count proximity to
 * disambiguate forked sessions that share the same first message.
 */
export async function fingerprintMessages(
  messages: Array<{ role: string; content: unknown }>,
): Promise<string> {
  let firstUserContent = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      const texts = extractTextParts(msg.content);
      firstUserContent = texts.join("");
      break;
    }
  }

  const encoded = new TextEncoder().encode(firstUserContent);
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
