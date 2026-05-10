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
 * The seed is a 64-bit constant baked into Claude Code's custom Bun binary.
 * It changes between releases and is not stored as a raw byte pattern —
 * the Zig compiler inlines it into the instruction stream or computes it
 * at comptime, leaving no searchable trace in the binary.
 *
 * We maintain a version→seed mapping. Workers pin their billing header to
 * a version with a known seed so the cch hash is valid. Conversation
 * requests are forwarded as-is with the client's own signed cch.
 *
 * Per-session state: each conversation turn records whether the session
 * uses bearer-token auth (Claude Code OAuth) so workers know to inject
 * the billing header. Keyed by sessionID to prevent cross-session
 * contamination. Mirrors the per-session `sessionAuth` in `auth.ts`.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Version→seed mapping
// ---------------------------------------------------------------------------

/**
 * Known version→seed pairs. Seeds are extracted from the ARM64 macOS Claude
 * Code binary using the oracle approach:
 *   1. Collect (body_with_placeholder, signed_cch) pairs from live traffic
 *   2. Download `@anthropic-ai/claude-code-darwin-arm64@VERSION` from npm
 *   3. Test every 8-byte aligned offset in the binary as candidate seed
 *   4. Two oracle pairs eliminate all false positives (~8s scan time)
 *   5. Validate the candidate seed against all collected pairs
 *
 * See `scripts/extract-cch-seed.ts` for the automated extraction tool.
 */
const VERSION_SEEDS: Record<string, bigint> = {
  "2.1.37": 0x6E52736AC806831En,
  // Future versions: extract and add entries here.
};

/** Version we pin worker billing headers to (must have a known seed). */
const WORKER_VERSION = "2.1.37";
const WORKER_SEED = VERSION_SEEDS[WORKER_VERSION]!;

/**
 * Salt for the cc_version suffix computation. Embedded in Claude Code's
 * JavaScript source (extractable from the Bun binary). This is per-version
 * but easily found by searching the extracted JS for the suffix function.
 */
const WORKER_SALT = "59cf53e54c78";

const CCH_PLACEHOLDER = "cch=00000";

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Compute the `cch` hash for a JSON request body containing `cch=00000`.
 * Returns the body with the placeholder replaced by the computed hash.
 *
 * @param bodyWithPlaceholder — JSON string containing `cch=00000`
 * @returns body with `cch=00000` replaced by `cch=XXXXX`
 */
export function signBody(bodyWithPlaceholder: string): string {
  const hash = Bun.hash.xxHash64(bodyWithPlaceholder, WORKER_SEED);
  const cch = (hash & 0xFFFFFn).toString(16).padStart(5, "0");
  return bodyWithPlaceholder.replace(CCH_PLACEHOLDER, `cch=${cch}`);
}

/**
 * Compute the 3-char hex cc_version suffix.
 *
 * Algorithm from the article:
 *   1. Take chars at indices 4, 7, 20 from the first user message
 *      (pad with '0' if message is shorter)
 *   2. suffix = sha256(salt + chars + version).hex()[:3]
 */
function computeVersionSuffix(firstUserMessage: string): string {
  const chars = [4, 7, 20]
    .map((i) => (i < firstUserMessage.length ? firstUserMessage[i] : "0"))
    .join("");
  return createHash("sha256")
    .update(`${WORKER_SALT}${chars}${WORKER_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Re-signing conversation turn bodies
// ---------------------------------------------------------------------------

/**
 * Regex matching a billing header's cch field in a serialized JSON body.
 * The cch value is exactly 5 hex chars followed by a semicolon.
 * Used to detect conversation turns that need re-signing after body
 * reconstruction by buildAnthropicRequest.
 */
const CCH_IN_BODY_RE = /cch=([0-9a-fA-F]{5});/;

/**
 * Regex matching the cc_version field in a billing header.
 * Format: cc_version=MAJOR.MINOR.PATCH.SUFFIX (suffix is 3 hex chars).
 */
const CC_VERSION_RE = /cc_version=(\d+\.\d+\.\d+)\.([0-9a-f]{3});/;

/**
 * Re-sign a serialized request body that contains a client-signed billing
 * header. Called after `buildAnthropicRequest` + `JSON.stringify` which
 * reconstructs the body (different JSON key ordering, cache_control
 * wrappers, message transforms) — invalidating the client's original cch.
 *
 * The function:
 *   1. Detects `cch=XXXXX` in the serialized body — returns unchanged if absent
 *   2. Replaces `cc_version=X.Y.Z.abc` with our worker version + recomputed suffix
 *   3. Replaces `cch=XXXXX` with `cch=00000` placeholder
 *   4. Hashes with our known seed → compute new cch
 *   5. Replaces `cch=00000` with the computed value
 *
 * @param serializedBody — JSON string after JSON.stringify(body)
 * @param firstUserMessage — text of the first user message (for version suffix)
 * @returns re-signed body, or original body if no billing header detected
 */
export function resignBody(
  serializedBody: string,
  firstUserMessage: string,
): string {
  // Quick check: no billing header → return unchanged
  if (!CCH_IN_BODY_RE.test(serializedBody)) {
    return serializedBody;
  }

  let body = serializedBody;

  // Step 1: Replace cc_version with our worker version + recomputed suffix.
  // The suffix depends on chars[4,7,20] from the first user message.
  const suffix = computeVersionSuffix(firstUserMessage);
  body = body.replace(
    CC_VERSION_RE,
    `cc_version=${WORKER_VERSION}.${suffix};`,
  );

  // Step 2: Replace existing cch with placeholder
  body = body.replace(CCH_IN_BODY_RE, `${CCH_PLACEHOLDER};`);

  // Step 3: Hash and replace placeholder with computed value
  return signBody(body);
}

// ---------------------------------------------------------------------------
// Per-session bearer-token registry
// ---------------------------------------------------------------------------

/** Regex to detect a billing header in a system prompt. */
const BILLING_HEADER_RE =
  /^x-anthropic-billing-header:\s*cc_version=[^;]+;\s*cc_entrypoint=[^;]+;\s*cch=[0-9a-fA-F]+;/;

/** Sessions that use bearer-token auth and need billing headers on workers. */
const sessionNeedsBilling = new Map<string, boolean>();

/**
 * Check if a system prompt contains a billing header and record the result
 * for this session. Called on each conversation turn. Returns true if the
 * session uses billing headers (bearer-token / Claude Code OAuth).
 *
 * Sessions whose system prompts do not match the regex (API-key clients,
 * non-Claude-Code clients) leave their slot untouched — a subsequent turn
 * without a billing header doesn't erase a previously recorded flag.
 */
export function captureBillingPrefix(
  sessionID: string,
  system: string,
): boolean {
  const hasBilling = BILLING_HEADER_RE.test(system);
  if (hasBilling) {
    sessionNeedsBilling.set(sessionID, true);
  }
  return hasBilling;
}

/**
 * Build a billing header system block for a worker request belonging to
 * `sessionID`. The header is pinned to WORKER_VERSION with a known seed
 * so the cch hash can be computed correctly.
 *
 * Returns null if the session doesn't use billing headers (API-key clients,
 * non-Claude-Code clients, or worker fired before the first turn).
 *
 * @param sessionID — originating session
 * @param userMessage — the worker's user message (used for version suffix)
 */
export function buildBillingBlock(
  sessionID: string | undefined,
  userMessage: string,
): { type: string; text: string } | null {
  if (!sessionID) return null;
  if (!sessionNeedsBilling.get(sessionID)) return null;

  const suffix = computeVersionSuffix(userMessage);
  return {
    type: "text",
    text:
      `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix};` +
      ` cc_entrypoint=cli; ${CCH_PLACEHOLDER};`,
  };
}

/** Drop billing state for a session (used by session eviction). */
export function deleteBillingPrefix(sessionID: string): void {
  sessionNeedsBilling.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Seed validation (for detecting seed rotation in live traffic)
// ---------------------------------------------------------------------------

/**
 * Validate our known seeds against a live (body, cch) pair from a
 * conversation turn. Returns true if any known seed produces the same cch.
 * If false, the client is using a version with an unknown seed.
 *
 * Call this on conversation turns where we see a signed cch from the
 * client's Claude Code binary. Extracts the cch, replaces it with the
 * placeholder, hashes with each known seed, and compares.
 *
 * @param body — the raw request body as received (with signed cch)
 * @returns null if no cch found, true if a seed matches, false if none match
 */
export function validateSeed(body: string): boolean | null {
  const cchMatch = body.match(/cch=([0-9a-fA-F]{5});/);
  if (!cchMatch) return null;

  const clientCch = cchMatch[1].toLowerCase();
  const bodyWithPlaceholder = body.replace(
    `cch=${cchMatch[1]}`,
    CCH_PLACEHOLDER,
  );

  for (const seed of Object.values(VERSION_SEEDS)) {
    const hash = Bun.hash.xxHash64(bodyWithPlaceholder, seed);
    const ourCch = (hash & 0xFFFFFn).toString(16).padStart(5, "0");
    if (ourCch === clientCch) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  sessionNeedsBilling.clear();
}

/** @internal Exposed for tests. */
export {
  WORKER_VERSION,
  WORKER_SEED,
  WORKER_SALT,
  CCH_PLACEHOLDER,
  VERSION_SEEDS,
  computeVersionSuffix as _computeVersionSuffix,
};
