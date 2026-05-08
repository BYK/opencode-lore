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
 */
export function inferDivergenceReason(
  path: string,
  prevLength: number,
  currLength: number,
): string {
  if (path === "<end>") {
    return currLength > prevLength
      ? "new content appended"
      : "content truncated";
  }
  if (path === "<start>") return "request structure changed from start";
  if (path === "<root>") return "top-level structure changed";

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
    const rest = path.slice(msgMatch[0].length);

    if (!rest) return `message ${idx} structure changed`;
    if (rest === ".role") return `message ${idx} role changed`;
    if (rest.startsWith(".content"))
      return `message ${idx} content changed`;
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

  // Compare with previous body if available
  if (analytics.lastRequestBody !== null) {
    const prevBody = decompressBody(analytics.lastRequestBody);
    const prevLength = prevBody.length;
    const currLength = currentBody.length;

    prefixMatchBytes = findDivergenceOffset(prevBody, currentBody);
    const minLength = Math.min(prevLength, currLength);
    prefixMatchPercent = minLength > 0 ? prefixMatchBytes / minLength : 0;

    if (prefixMatchBytes < minLength) {
      // Actual divergence within the shared prefix
      divergencePoint = mapOffsetToJsonPath(currentBody, prefixMatchBytes);
      divergenceReason = inferDivergenceReason(
        divergencePoint,
        prevLength,
        currLength,
      );
    } else if (prevLength !== currLength) {
      // One is a prefix of the other — new content appended/removed
      divergencePoint = "<end>";
      divergenceReason = currLength > prevLength
        ? "new content appended (likely new messages)"
        : "content truncated (context window compressed)";
    } else {
      // Identical bodies
      divergencePoint = "<identical>";
      divergenceReason = "request bodies are identical";
    }
  }

  // Store compressed body for next turn
  analytics.lastRequestBody = compressBody(currentBody);
  analytics.lastRequestBodyLength = currentBody.length;
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
