/**
 * Claude Code billing header (`cch`) computation for worker requests.
 *
 * Claude Code OAuth bearer tokens require an `x-anthropic-billing-header`
 * as the first system prompt block. The `cch` field is an xxHash64 of the
 * entire serialized request body, masked to 20 bits (5 hex chars).
 *
 * The standalone Claude binary computes this in custom Zig code injected
 * into nativeFetch. We replicate the algorithm for our worker calls which
 * build requests from scratch and can't piggyback on the binary's signing.
 *
 * Algorithm (from https://a10k.co/b/reverse-engineering-claude-code-cch.html):
 *   1. Build body JSON with `cch=00000` placeholder
 *   2. cch = xxHash64(body_bytes, seed) & 0xFFFFF → 5-char hex
 *   3. Replace `cch=00000` with computed value
 *
 * Seed: 0x6E52736AC806831E (baked into Claude Code's custom Bun binary)
 *
 * Per-session state: each conversation turn captures its own prefix into the
 * session registry. Worker calls look up the prefix by `sessionID` so a
 * Claude Code 2.1.x session and a 2.0.x session running on the same gateway
 * process don't sign each other's worker calls. Mirrors the per-session
 * `sessionAuth` registry in `auth.ts`. See LOREAI-CCH-1 for the singleton
 * cross-contamination bug this replaces.
 */

const CCH_SEED = 0x6E52736AC806831En; // BigInt for Bun.hash.xxHash64
const CCH_PLACEHOLDER = "cch=00000";

/**
 * Compute the `cch` hash for a JSON request body containing `cch=00000`.
 * Returns the body with the placeholder replaced by the computed hash.
 *
 * @param bodyWithPlaceholder — JSON string containing `cch=00000`
 * @returns body with `cch=00000` replaced by `cch=XXXXX`
 */
export function signBody(bodyWithPlaceholder: string): string {
  const hash = Bun.hash.xxHash64(bodyWithPlaceholder, CCH_SEED);
  const cch = (hash & 0xFFFFFn).toString(16).padStart(5, "0");
  return bodyWithPlaceholder.replace(CCH_PLACEHOLDER, `cch=${cch}`);
}

// ---------------------------------------------------------------------------
// Per-session billing prefix registry
// ---------------------------------------------------------------------------

/**
 * Regex to extract the billing header prefix — everything up to the `cch=`
 * value. We capture the part BEFORE `cch=` so we can reconstruct the header
 * with our own placeholder for worker calls.
 *
 * Example input (first system text block):
 *   "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;"
 *
 * We extract: "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; "
 */
const BILLING_PREFIX_RE =
  /^(x-anthropic-billing-header:\s*cc_version=[^;]+;\s*cc_entrypoint=[^;]+;\s*)cch=[0-9a-fA-F]+;/;

/** Per-session billing prefix. Keyed by sessionID; populated by
 *  `captureBillingPrefix()` on each conversation turn. */
const sessionBillingPrefix = new Map<string, string>();

/**
 * Extract and store the billing header prefix from a system prompt string
 * for a specific session. Called on each conversation turn. Returns true if
 * a prefix was found and stored.
 *
 * Sessions whose system prompts do not match the regex (API-key clients,
 * non-Claude-Code clients) leave their slot untouched — `getBillingPrefix`
 * returns null for them.
 */
export function captureBillingPrefix(
  sessionID: string,
  system: string,
): boolean {
  const match = BILLING_PREFIX_RE.exec(system);
  if (match) {
    sessionBillingPrefix.set(sessionID, match[1]);
    return true;
  }
  return false;
}

/**
 * Build a billing header system block for a worker request belonging to
 * `sessionID`. Returns null if the session never captured a prefix
 * (non-Claude-Code clients, or worker fired before the first turn).
 */
export function buildBillingBlock(
  sessionID: string | undefined,
): { type: string; text: string } | null {
  if (!sessionID) return null;
  const prefix = sessionBillingPrefix.get(sessionID);
  if (!prefix) return null;
  return {
    type: "text",
    text: `${prefix}${CCH_PLACEHOLDER};`,
  };
}

/** Drop the billing prefix for a session (used by session eviction). */
export function deleteBillingPrefix(sessionID: string): void {
  sessionBillingPrefix.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  sessionBillingPrefix.clear();
}
