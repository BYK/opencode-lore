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
// Billing header prefix extraction from conversation system prompts
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

/** Extracted billing header prefix (without cch). Null if no CC client seen. */
let billingPrefix: string | null = null;

/**
 * Extract and store the billing header prefix from a system prompt string.
 * Called on each conversation turn. Returns true if a prefix was found.
 */
export function captureBillingPrefix(system: string): boolean {
  const match = BILLING_PREFIX_RE.exec(system);
  if (match) {
    billingPrefix = match[1];
    return true;
  }
  return false;
}

/**
 * Build a billing header system block for worker requests.
 * Uses the captured prefix from conversation turns + `cch=00000` placeholder.
 * Returns null if no billing prefix has been captured yet.
 */
export function buildBillingBlock(): { type: string; text: string } | null {
  if (!billingPrefix) return null;
  return {
    type: "text",
    text: `${billingPrefix}${CCH_PLACEHOLDER};`,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  billingPrefix = null;
}
