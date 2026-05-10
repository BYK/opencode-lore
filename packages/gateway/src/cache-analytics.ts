/**
 * Cache analytics — deterministic cache-bust detection using API request
 * body prefix comparison and Anthropic response cache fields.
 *
 * Instead of fingerprinting internal message representations, this module
 * compares the actual serialized JSON request body byte-for-byte across
 * turns. When the prefix diverges, it maps the byte offset back to a
 * semantic location in the JSON structure (e.g. "messages[3].content[1]").
 *
 * The API response's `cache_read_input_tokens` and
 * `cache_creation_input_tokens` provide ground-truth confirmation.
 *
 * Request bodies are stored zstd-compressed (~99.9% reduction on
 * repetitive JSON) to keep per-session memory overhead low.
 */

import type {
  CacheAnalytics,
  CacheTurnAnalysis,
  GatewayUsage,
} from "./translate/types.ts";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// Compression helpers (Bun built-in zstd, zero dependencies)
// ---------------------------------------------------------------------------

export function compressBody(body: string): Uint8Array {
  return Bun.zstdCompressSync(Buffer.from(body));
}

export function decompressBody(compressed: Uint8Array): string {
  return Buffer.from(
    Bun.zstdDecompressSync(compressed as Uint8Array<ArrayBuffer>),
  ).toString();
}

// ---------------------------------------------------------------------------
// Body normalization for stable comparison
// ---------------------------------------------------------------------------

/**
 * Normalize a serialized request body for cache comparison by stripping
 * volatile metadata that clients embed in the request.
 *
 * The upstream request is NEVER modified — only the analytics copy.
 * Both the stored (previous) and current bodies are normalized, so
 * variable-width replacements are safe (offsets stay aligned across turns).
 */

/** Claude Code content-cache hash: changes every turn. */
const CCH_PATTERN = /cch=[0-9a-fA-F]+;/g;
const CCH_REPLACEMENT = "cch=__;";

/**
 * Claude Code version suffix: 3 hex chars derived from
 * sha256(salt + chars_from_first_user_message + version).
 * Changes between sessions. Only the suffix is normalized —
 * the base version (e.g. 2.1.37) is preserved so genuine
 * version upgrades still show as divergence.
 */
const CC_VERSION_SUFFIX_PATTERN =
  /(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]{3};/g;
const CC_VERSION_SUFFIX_REPLACEMENT = "$1.___;";

/**
 * Top-level max_tokens: Claude Code may vary this between turns.
 * Anchored to the JSON body start so it only matches the top-level
 * field, not occurrences in message content or tool descriptions.
 */
const TOP_LEVEL_MAX_TOKENS = /^(\{"model":"[^"]+","max_tokens":)\d+/;

export function normalizeBodyForComparison(body: string): string {
  return body
    .replace(CCH_PATTERN, CCH_REPLACEMENT)
    .replace(CC_VERSION_SUFFIX_PATTERN, CC_VERSION_SUFFIX_REPLACEMENT)
    .replace(TOP_LEVEL_MAX_TOKENS, "$1_");
}

// ---------------------------------------------------------------------------
// Byte-level prefix comparison
// ---------------------------------------------------------------------------

/**
 * Find the byte offset where two strings first differ.
 * Returns the length of the shorter string if one is a prefix of the other.
 */
export function findDivergenceOffset(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

// ---------------------------------------------------------------------------
// Semantic location mapping
// ---------------------------------------------------------------------------

/**
 * Map a byte offset in a serialized JSON string to a semantic JSON path.
 *
 * Walks the JSON structure character-by-character, tracking the current
 * path (keys and array indices). Stops when we reach the target offset.
 *
 * Returns a human-readable path like "messages[3].content[1].text" or
 * "system" or "tools[2].name".
 */
export function mapOffsetToJsonPath(json: string, offset: number): string {
  if (offset >= json.length) return "<end>";
  if (offset === 0) return "<start>";

  // Stack-based JSON path tracker. Each frame represents a nesting level.
  // - object frames: { kind: "object", key: current key or "" }
  // - array frames:  { kind: "array", index: current element index }
  type Frame =
    | { kind: "object"; key: string }
    | { kind: "array"; index: number };

  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let currentKey = "";
  let collectingKey = false;

  for (let i = 0; i < json.length && i < offset; i++) {
    const ch = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        if (collectingKey) currentKey += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        if (collectingKey) currentKey += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        collectingKey = false;
        continue;
      }
      if (collectingKey) currentKey += ch;
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        // Determine if this quote starts a key (object context, key position)
        collectingKey = isObjectKeyPosition(json, i);
        if (collectingKey) currentKey = "";
        break;

      case "{":
        stack.push({ kind: "object", key: "" });
        break;

      case "[":
        stack.push({ kind: "array", index: 0 });
        break;

      case "}":
      case "]":
        stack.pop();
        break;

      case ":":
        // Assign the collected key to the current object frame
        if (currentKey && stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === "object") {
            top.key = currentKey;
          }
          currentKey = "";
        }
        break;

      case ",":
        // In array context, advance to the next element
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === "array") {
            top.index++;
          }
        }
        break;
    }
  }

  // Build path from the stack
  const parts: string[] = [];
  for (const frame of stack) {
    if (frame.kind === "object" && frame.key) {
      parts.push(parts.length === 0 ? frame.key : `.${frame.key}`);
    } else if (frame.kind === "array") {
      parts.push(`[${frame.index}]`);
    }
  }

  return parts.length === 0 ? "<root>" : parts.join("");
}

/**
 * Determine if a '"' at `offset` starts an object key.
 * Scans backwards to find the last structural character — if it's '{' or ','
 * we're in key position (not value position).
 */
function isObjectKeyPosition(json: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = json[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    // After '{' or ',' in object = key position
    return ch === "{" || ch === ",";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Divergence reason inference
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable reason from the semantic path.
 *
 * Maps raw JSON paths to intuitive descriptions:
 *  - system[0] → host system prompt (stable, cached)
 *  - system[1] → LTM knowledge block (our injection)
 *  - messages near end → "new user/assistant message"
 *  - messages mid-conversation → "earlier message modified" (distillation rewrite)
 *
 * @param messageCount - total messages in the current request (for end-detection)
 */
export function inferDivergenceReason(
  path: string,
  prevLength: number,
  currLength: number,
  messageCount?: number,
): string {
  if (path === "<end>") {
    return currLength > prevLength
      ? "new message appended (normal conversation growth)"
      : "context window compressed (gradient eviction)";
  }
  if (path === "<start>") return "request structure changed from start";
  if (path === "<root>") return "top-level structure changed";

  // System prompt blocks:
  //  system[0] = host system prompt (stable, cached with 1h TTL)
  //  system[1] = LTM knowledge block (Lore's injection, changes on curation)
  //  bare "system" = plain string system prompt (no array structure)
  if (path === "system[0]" || path.startsWith("system[0]"))
    return "host system prompt changed";
  if (path === "system[1]" || path.startsWith("system[1]"))
    return "LTM knowledge block updated (background curation/consolidation)";
  if (path === "system" || path.startsWith("system"))
    return "system prompt changed";

  if (path === "model") return "model changed";
  if (path === "max_tokens") return "max_tokens changed";
  if (path === "tools" || path.startsWith("tools"))
    return "tool definitions changed";

  // messages[N] patterns
  const msgMatch = path.match(/^messages\[(\d+)\]/);
  if (msgMatch) {
    const idx = parseInt(msgMatch[1], 10);

    // Determine if this is a new message at the end or a mid-conversation change
    if (messageCount != null && messageCount > 0) {
      // New messages: index near the end of the conversation (within last 2 messages)
      if (idx >= messageCount - 2) {
        return "new conversation message (normal turn progression)";
      }
      // Early messages: likely distilled prefix rewrite
      if (idx <= 1) {
        return "distilled conversation prefix changed (meta-distillation rewrite)";
      }
      // Mid-conversation: window shift or content edit
      return `earlier message modified at position ${idx} (window shift or content change)`;
    }

    // Fallback without message count context
    const rest = path.slice(msgMatch[0].length);
    if (!rest) return `message at position ${idx} structure changed`;
    if (rest === ".role") return `message at position ${idx} role changed`;
    if (rest.startsWith(".content"))
      return `message at position ${idx} content changed`;
  }

  return `changed at ${path}`;
}

// ---------------------------------------------------------------------------
// Main analytics function
// ---------------------------------------------------------------------------

/**
 * Analyze cache performance for a turn. Compares the current request body
 * with the previous turn's (stored compressed) and incorporates the API
 * response's cache usage fields.
 *
 * Updates `analytics` state in-place and returns the per-turn analysis.
 */
export function analyzeCacheTurn(
  analytics: CacheAnalytics,
  currentBody: string,
  usage: GatewayUsage,
  sessionID?: string,
  /** Number of messages in the current request (for human-friendly divergence reasons). */
  messageCount?: number,
): CacheTurnAnalysis {
  analytics.turnCount++;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const inputTokens = usage.inputTokens ?? 0;
  const totalInput = cacheRead + cacheCreation + inputTokens;
  const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

  // Track confirmed busts (API says no cache hit + new cache written)
  if (cacheRead === 0 && cacheCreation > 0 && analytics.turnCount > 1) {
    analytics.bustCount++;
  }

  // Default values for first turn (no previous body to compare)
  let prefixMatchBytes = 0;
  let prefixMatchPercent = 0;
  let divergencePoint = "<first-turn>";
  let divergenceReason = "first turn — no previous request to compare";
  let prevSnippet: string | undefined;
  let currSnippet: string | undefined;

  // Normalize the current body for comparison: strip volatile client metadata
  // (e.g. Claude Code's per-turn `cch=XXXXX;` hash) so it doesn't pollute
  // prefix comparison. The previous body was already normalized before storage.
  const normalizedBody = normalizeBodyForComparison(currentBody);

  // Compare with previous body if available
  if (analytics.lastRequestBody !== null) {
    const prevBody = decompressBody(analytics.lastRequestBody);
    const prevLength = prevBody.length;
    const currLength = normalizedBody.length;

    prefixMatchBytes = findDivergenceOffset(prevBody, normalizedBody);
    const minLength = Math.min(prevLength, currLength);
    prefixMatchPercent = minLength > 0 ? prefixMatchBytes / minLength : 0;

    if (prefixMatchBytes < minLength) {
      // Actual divergence within the shared prefix
      divergencePoint = mapOffsetToJsonPath(normalizedBody, prefixMatchBytes);
      divergenceReason = inferDivergenceReason(
        divergencePoint,
        prevLength,
        currLength,
        messageCount,
      );

      // Capture and log diverging byte snippets for early divergences (< 5%
      // prefix match) to help diagnose what the client is changing (e.g.
      // timestamps, turn counters). Snippets are also stored on the result
      // for Sentry span enrichment.
      if (prefixMatchPercent < 0.05) {
        const start = Math.max(0, prefixMatchBytes - 20);
        const end = prefixMatchBytes + 80;
        prevSnippet = prevBody.slice(start, Math.min(prevLength, end));
        currSnippet = normalizedBody.slice(start, Math.min(currLength, end));
        log.info(
          `cache-analytics: early divergence at byte ${prefixMatchBytes}` +
            `\n  prev: ${JSON.stringify(prevSnippet)}` +
            `\n  curr: ${JSON.stringify(currSnippet)}`,
        );
      }
    } else if (prevLength !== currLength) {
      // One is a prefix of the other — new content appended/removed
      divergencePoint = "<end>";
      divergenceReason = currLength > prevLength
        ? "new message appended (normal conversation growth)"
        : "context window compressed (gradient eviction)";
    } else {
      // Identical bodies
      divergencePoint = "<identical>";
      divergenceReason = "request bodies are identical";
    }
  }

  // Store normalized + compressed body for next turn. We store the normalized
  // version so the next turn's comparison is apples-to-apples (both sides
  // have volatile metadata stripped).
  analytics.lastRequestBody = compressBody(normalizedBody);
  analytics.lastRequestBodyLength = normalizedBody.length;
  analytics.lastCacheRead = cacheRead;
  analytics.lastCacheCreation = cacheCreation;

  const result: CacheTurnAnalysis = {
    turn: analytics.turnCount,
    cacheRead,
    cacheCreation,
    inputTokens,
    cacheHitRate,
    prefixMatchBytes,
    prefixMatchPercent,
    divergencePoint,
    divergenceReason,
    prevSnippet,
    currSnippet,
  };

  // Log structured analysis
  if (analytics.turnCount > 1) {
    const bustStr = cacheRead === 0 && cacheCreation > 0 ? " [BUST]" : "";
    const sidStr = sessionID ? ` session=${sessionID.slice(0, 16)}` : "";
    log.info(
      `cache-analytics:${sidStr} turn=${result.turn}` +
        ` hit=${(result.cacheHitRate * 100).toFixed(0)}%` +
        ` read=${cacheRead} create=${cacheCreation} input=${inputTokens}` +
        ` prefixMatch=${(result.prefixMatchPercent * 100).toFixed(1)}%` +
        ` (${prefixMatchBytes}/${analytics.lastRequestBodyLength}B)` +
        ` divergence="${divergencePoint}" reason="${divergenceReason}"` +
        bustStr,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bust cause categorization
// ---------------------------------------------------------------------------

/** Cache event categories for telemetry. */
export type CacheBustCause =
  | "first-turn"       // session's first request (unavoidable)
  | "system-change"    // divergence in system blocks (LTM update)
  | "tools-change"     // tool definitions changed
  | "prefix-rewrite"   // distilled prefix content changed (meta-distillation)
  | "window-shift"     // raw window eviction changed message positions
  | "idle-resume"      // first turn after idle detection (cold cache)
  | "incremental"      // normal append (cache hit, write only new tail)
  | "unknown";         // unclassified

/**
 * Categorize a cache event from the turn analysis.
 *
 * Uses the divergence point from byte-level prefix comparison plus the
 * API's cache usage fields to classify what caused the event.
 *
 * @param analysis - Per-turn analysis from analyzeCacheTurn()
 * @param isPostIdle - Whether this turn is a post-idle resume
 */
export function categorizeBust(
  analysis: CacheTurnAnalysis,
  isPostIdle: boolean,
): CacheBustCause {
  const { turn, cacheRead, cacheCreation, divergencePoint } = analysis;

  // First turn — no prior request to compare
  if (turn <= 1 || divergencePoint === "<first-turn>") return "first-turn";

  // Not a bust: cache read > 0, creation is only the new tail
  if (cacheRead > 0 && cacheCreation > 0) return "incremental";
  if (cacheRead > 0 && cacheCreation === 0) return "incremental";

  // Full bust: cacheRead === 0 and cacheCreation > 0
  if (cacheRead === 0 && cacheCreation > 0) {
    // Post-idle: cold cache regardless of divergence reason
    if (isPostIdle) return "idle-resume";

    // Classify by divergence location
    if (divergencePoint === "<identical>") return "unknown"; // shouldn't happen with a bust
    if (divergencePoint === "<start>" || divergencePoint === "<root>")
      return "prefix-rewrite";
    if (divergencePoint === "system" || divergencePoint.startsWith("system"))
      return "system-change";
    if (divergencePoint === "tools" || divergencePoint.startsWith("tools"))
      return "tools-change";

    // Message-level divergence
    const msgMatch = divergencePoint.match(/^messages\[(\d+)\]/);
    if (msgMatch) {
      const idx = parseInt(msgMatch[1], 10);
      // Early message changes (index 0 or 1) likely indicate prefix rewrite
      // (distilled prefix is injected as messages[0] and messages[1])
      if (idx <= 1) return "prefix-rewrite";
      // Later message changes indicate window shift (raw window eviction)
      return "window-shift";
    }

    return "unknown";
  }

  // No cache activity at all (unusual)
  return "unknown";
}

/**
 * Log a cache analytics summary for the session.
 * Suitable for calling on session cleanup or periodically.
 */
export function logCacheAnalyticsSummary(
  sessionID: string,
  analytics: CacheAnalytics,
): void {
  if (analytics.turnCount === 0) return;

  const bustRate = analytics.turnCount > 1
    ? analytics.bustCount / (analytics.turnCount - 1)
    : 0;

  log.info(
    `cache-analytics summary: session=${sessionID.slice(0, 16)}` +
      ` turns=${analytics.turnCount}` +
      ` busts=${analytics.bustCount}` +
      ` bustRate=${(bustRate * 100).toFixed(0)}%`,
  );
}
