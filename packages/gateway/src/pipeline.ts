/**
 * Core request processing pipeline for the Lore gateway.
 *
 * Orchestrates the full flow for every request:
 *   session identification → LTM injection → gradient transform →
 *   upstream forwarding → response accumulation → calibration →
 *   temporal storage → background work scheduling.
 *
 * Three request classes are handled:
 *  1. Compaction requests → intercepted, never forwarded upstream.
 *  2. Title/summary requests → forwarded transparently, no Lore processing.
 *  3. Normal conversation turns → full pipeline.
 */
import type { LoreMessageWithParts, LLMClient } from "@loreai/core";
import {
  load,
  config as loreConfig,
  ensureProject,
  temporal,
  ltm,
  distillation,
  curator,
  log,
  transform,
  setModelLimits,
  setLtmTokens,
  getLtmBudget,
  setMaxLayer0Tokens,
  computeLayer0Cap,
  setMaxContextTokens,
  computeContextCap,
  updateBustRate,
  calibrate,
  getLastTransformedCount,
  onIdleResume,
  consumeCameOutOfIdle,
  needsUrgentDistillation,
  formatKnowledge,
  buildCompactPrompt,
} from "@loreai/core";

import type {
  GatewayRequest,
  GatewayResponse,
  GatewayContentBlock,
  GatewayToolUseBlock,
  GatewayToolResultBlock,
  SessionState,
} from "./translate/types";
import type { GatewayConfig } from "./config";
import { getProjectPath, resolveUpstreamRoute } from "./config";
import {
  generateSessionID,
  fingerprintMessages,
  MESSAGE_COUNT_PROXIMITY_THRESHOLD,
  extractKnownSessionHeader,
  extractParentSessionId,
  learnHeaders,
} from "./session";
import {
  isCompactionRequest,
  isStructuralCompaction,
  isTitleOrSummaryRequest,
  extractPreviousSummary,
  buildCompactionResponse,
  scaleUsageForClient,
} from "./compaction";
import {
  buildAnthropicRequest,
  buildAnthropicNonStreamResponse,
  type AnthropicCacheOptions,
} from "./translate/anthropic";
import {
  buildOpenAIUpstreamRequest,
  buildOpenAIResponse,
} from "./translate/openai";
import {
  createStreamAccumulator,
  createRecallAwareAccumulator,
  parseSSEStream,
  buildSSETextResponse,
  formatSSEEvent,
  type StreamAccumulator,
} from "./stream/anthropic";
import {
  gatewayMessagesToLore,
  updateAssistantMessageTokens,
  resolveToolResults,
} from "./temporal-adapter";
import { createGatewayLLMClient } from "./llm-adapter";
import { createBatchLLMClient } from "./batch-queue";
import {
  extractAuth,
  authFingerprint,
  setLastSeenAuth,
  setSessionAuth,
  resolveAuth,
} from "./auth";
import type { UpstreamInterceptor } from "./recorder";
import { startIdleScheduler, buildIdleWorkHandler } from "./idle";
import { getWorkerModel, resetWorkerModelState, fetchModelData, getModelEntrySync } from "./worker-model";
import * as Sentry from "@sentry/bun";
import { captureBillingPrefix, resignBody } from "./cch";
import { analyzeCacheTurn, categorizeBust } from "./cache-analytics";
import {
   setSentryRequestContext,
   setSentryCacheContext,
   setSentryLightContext,
   setGenAiUsageAttributes,
   setCacheAnalyticsAttributes,
   emitCostMetric,
   emitCacheBustMetric,
   type AnthropicUsage,
} from "./sentry";
import {
  RECALL_GATEWAY_TOOL,
  RECALL_TOOL_NAME,
  executeRecall,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  buildRecallFollowUp,
  buildRecallMarker,
  recallStoreKey,
  expandRecallMarkers,
  cleanupRecallStore,
  replaceRecallWithMarker,
} from "./recall";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** One-time initialization flag. */
let initialized = false;

/** Active upstream interceptor — used for recording/replay. */
let activeInterceptor: UpstreamInterceptor | undefined;

/**
 * Set (or clear) the module-level upstream interceptor.
 *
 * When set, every call to `forwardToUpstream` passes through the interceptor
 * instead of calling `fetch` directly.  Used by the recording and replay
 * scripts to capture or replay upstream traffic without modifying individual
 * call sites.
 */
export function setUpstreamInterceptor(
  interceptor: UpstreamInterceptor | undefined,
): void {
  activeInterceptor = interceptor;
}

/**
 * Reset all module-level singleton state.
 *
 * Intended for test harnesses only — allows multiple independent gateway
 * instances to run sequentially in the same Bun process without leaking
 * session state, initialization flags, or cached project paths across test
 * suites.
 */
export async function resetPipelineState(): Promise<void> {
  initialized = false;
  cachedProjectPath = null;
  sessions.clear();
  ltmSessionCache.clear();
  ltmPinnedText.clear();
  // Shut down batch queue gracefully before clearing the client
  if (llmClient && "shutdown" in llmClient) {
    await (llmClient as LLMClient & { shutdown: () => Promise<void> }).shutdown();
  }
  llmClient = null;
  activeInterceptor = undefined;
  if (stopIdleScheduler) {
    stopIdleScheduler();
    stopIdleScheduler = null;
  }
  lastSeenSessionModel = null;
  resetWorkerModelState();
}

/** Cached project path from the first request that carried a system prompt. */
let cachedProjectPath: string | null = null;

/** Per-session state tracked across requests. */
const sessions = new Map<string, SessionState>();

/**
 * Reverse lookup: maps header-based session ID values to internal session IDs.
 * Key: `headerName:headerValue` (e.g. `x-claude-code-session-id:uuid-1234`).
 * Value: internal session ID (the key in `sessions`).
 *
 * Populated for both Tier 1 (known headers) and Tier 2 (learned headers).
 */
const headerSessionIndex = new Map<string, string>();

/**
 * Per-session LTM cache for byte-stability.
 *
 * Without caching, `ltm.forSession()` re-scores entries against evolving
 * session context every turn, producing different formatted text → system
 * prompt changes at byte 0 → total cache invalidation on every turn.
 */
const ltmSessionCache = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/**
 * Pinned LTM text per session — the text currently being injected into the
 * system prompt. When ltmSessionCache is invalidated and recomputed, we
 * compare the new text against the pin. Only update if >5% character
 * difference to avoid cache busts from minor BM25 re-ranking changes.
 */
const ltmPinnedText = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/**
 * Measure character-level difference between two strings as a ratio (0..1).
 * Uses a simple length + common-prefix heuristic — not a full diff, but
 * sufficient to detect "substantially the same" vs "meaningfully different".
 */
function textDiffRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;

  // Common prefix length
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  let common = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) common++;
    else break;
  }

  // Common suffix length (non-overlapping with prefix)
  let suffix = 0;
  for (let i = 0; i < minLen - common; i++) {
    if (a[a.length - 1 - i] === b[b.length - 1 - i]) suffix++;
    else break;
  }

  const matched = common + suffix;
  return 1 - matched / maxLen;
}

/** Cached LLM client for background workers. */
let llmClient: LLMClient | null = null;

/** Cleanup function for the idle scheduler timer. */
let stopIdleScheduler: (() => void) | null = null;

/** Last seen session model ID — used for worker model discovery context. */
let lastSeenSessionModel: string | null = null;

// ---------------------------------------------------------------------------
// Model limits — fetched from models.dev, fallback for unknown
// ---------------------------------------------------------------------------

type ModelSpec = {
  context: number;
  output: number;
  /** Cache-read cost per token in USD. */
  cacheReadCost?: number;
  /** Cache-write cost per token in USD (Anthropic: 1.25× input). */
  cacheWriteCost?: number;
  /** Input cost per million tokens (for cost-tier decisions). */
  inputCostPerMillion?: number;
};

const DEFAULT_MODEL_SPEC: ModelSpec = { context: 200_000, output: 8_192 };

/**
 * Look up model limits and cost data from models.dev.
 *
 * Uses the sync cache populated by `fetchModelData()` during init.
 * Falls back to sensible defaults if the cache isn't warm yet.
 */
function getModelSpec(model: string): ModelSpec {
  const entry = getModelEntrySync(model);
  return {
    context: entry.limit?.context ?? DEFAULT_MODEL_SPEC.context,
    output: entry.limit?.output ?? DEFAULT_MODEL_SPEC.output,
    cacheReadCost: entry.cost?.cache_read != null
      ? entry.cost.cache_read / 1_000_000  // models.dev is per-million, we need per-token
      : undefined,
    cacheWriteCost: entry.cost?.cache_write != null
      ? entry.cost.cache_write / 1_000_000
      : entry.cost?.input != null
        ? (entry.cost.input * 1.25) / 1_000_000  // Anthropic: cache_write = 1.25× input
        : undefined,
    inputCostPerMillion: entry.cost?.input ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * One-time init: load Lore config, ensure project exists in DB, start idle scheduler.
 * Safe to call multiple times — only the first call does work.
 */
async function initIfNeeded(projectPath: string, config?: GatewayConfig): Promise<void> {
  if (initialized) return;

  await load(projectPath);
  ensureProject(projectPath);
  initialized = true;
  cachedProjectPath = projectPath;

  // Pre-warm models.dev pricing/limits cache so synchronous lookups in the
  // request hot path (getModelSpec, emitCostMetric) resolve from memory.
  fetchModelData().catch((e) => log.warn("models.dev pre-warm failed:", e));

  // Start the idle scheduler for background work (distillation, curation,
  // pruning, AGENTS.md export). Uses a 30s poll interval and fires for any
  // session whose lastRequestTime exceeds the idle timeout.
  if (config && !stopIdleScheduler) {
    const llm = getLLMClient(config);
    const idleHandler = buildIdleWorkHandler(
      projectPath,
      llm,
    );
    stopIdleScheduler = startIdleScheduler(config, sessions, idleHandler);
  }

  log.info(`gateway pipeline initialized: ${projectPath}`);
}

function getLLMClient(config: GatewayConfig): LLMClient {
  if (!llmClient) {
    const cfg = loreConfig();
    const defaultModel = cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    };
    const inner = createGatewayLLMClient(
      config.upstreamAnthropic,
      resolveAuth,
      defaultModel,
    );

    // Wrap with batch queue for 50% cost savings on non-urgent worker calls.
    // Enabled by default — disable via LORE_BATCH_DISABLED=1.
    const batchDisabled = process.env.LORE_BATCH_DISABLED === "1";
    if (Sentry.isInitialized()) {
      Sentry.setTag("batch_enabled", String(!batchDisabled));
    }
    if (batchDisabled) {
      llmClient = inner;
    } else {
      llmClient = createBatchLLMClient(
        inner,
        config.upstreamAnthropic,
        resolveAuth,
        defaultModel,
      );
    }
  }
  return llmClient;
}

// ---------------------------------------------------------------------------
// Session management helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(
  sessionID: string,
  projectPath: string,
): SessionState {
  let state = sessions.get(sessionID);
  if (!state) {
    state = {
      sessionID,
      projectPath,
      fingerprint: "",
      lastRequestTime: Date.now(),
      messageCount: 0,
      turnsSinceCuration: 0,
      recallStore: new Map(),
      cacheAnalytics: {
        lastRequestBody: null,
        lastRequestBodyLength: 0,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
    };
    sessions.set(sessionID, state);
  }
  state.lastRequestTime = Date.now();

  // Ensure recallStore exists (upgrade from older session state)
  if (!state.recallStore) {
    state.recallStore = new Map();
  }

  return state;
}

/**
 * Identify or create a session from the incoming request.
 *
 * Uses a 3-tier strategy:
 *  1. **Known headers** — `x-claude-code-session-id`, `x-session-affinity`,
 *     `x-parent-session-id`. Immediate match, survives compaction & model changes.
 *  2. **Learned headers** — `x-` headers discovered via fingerprint-bootstrapped
 *     learning. Promoted after 3 stable turns + cross-session uniqueness.
 *  3. **Fingerprint fallback** — SHA-256 of first user message + auth suffix
 *     (no model). Message-count proximity for fork disambiguation.
 *
 * Priority: Tier 1 > Tier 2 > Tier 3.
 */
async function identifySession(
  req: GatewayRequest,
  _projectPath: string,
): Promise<{ sessionID: string; isNew: boolean; tier: 1 | 2 | 3 }> {
  const headers = req.rawHeaders;

  // --- Tier 1: Known headers ---

  // Check for parent session header first (sub-agent → parent merge).
  const parentId = extractParentSessionId(headers);
  if (parentId) {
    // Look up the parent session by its header value across all known headers.
    for (const [indexKey, sid] of headerSessionIndex) {
      if (indexKey.endsWith(`:${parentId}`)) {
        return { sessionID: sid, isNew: false, tier: 1 };
      }
    }
    // Parent not found — fall through to check if this request also carries
    // its own session header (some clients send both).
  }

  const known = extractKnownSessionHeader(headers);
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const existingSid = headerSessionIndex.get(indexKey);
    if (existingSid && sessions.has(existingSid)) {
      return { sessionID: existingSid, isNew: false, tier: 1 };
    }

    // New session with a known header — create and index it.
    const sessionID = generateSessionID();
    headerSessionIndex.set(indexKey, sessionID);
    return { sessionID, isNew: true, tier: 1 };
  }

  // --- Tier 2: Learned headers ---
  // Check if any existing session has a promoted header that matches
  // a header value in the current request.
  for (const [sid, state] of sessions) {
    if (!state.headerSessionId || !state.headerName) continue;
    const currentValue = headers[state.headerName];
    if (currentValue && currentValue === state.headerSessionId) {
      return { sessionID: sid, isNew: false, tier: 2 };
    }
  }

  // --- Tier 3: Fingerprint fallback ---
  const rawMessages = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const cred = extractAuth(req.rawHeaders);
  const fingerprint = await fingerprintMessages(rawMessages, {
    authSuffix: cred ? authFingerprint(cred) : "",
  });
  const msgCount = req.messages.length;

  // Find the best matching session: same fingerprint + closest message count
  let bestMatch: { sid: string; countDiff: number } | null = null;

  for (const [sid, state] of sessions) {
    if (state.fingerprint !== fingerprint) continue;

    const diff = msgCount - state.messageCount;

    // Normal session: count grows by 2–6 per turn.
    // Fork: count drops significantly (parent at 600, fork at 300).
    // Reject if the count dropped too far (likely a fork).
    if (diff < -MESSAGE_COUNT_PROXIMITY_THRESHOLD) continue;

    const absDiff = Math.abs(diff);
    if (!bestMatch || absDiff < bestMatch.countDiff) {
      bestMatch = { sid, countDiff: absDiff };
    }
  }

  if (bestMatch) {
    // Run header learning on the matched session (Tier 2 bootstrap).
    const state = sessions.get(bestMatch.sid);
    if (state && !state.headerSessionId) {
      const result = learnHeaders(state.candidateHeaders, headers);
      state.candidateHeaders = result.updatedCandidates;
      if (result.promoted) {
        state.headerSessionId = result.promoted.value;
        state.headerName = result.promoted.name;
        // Index the promoted header for future Tier 2 lookups.
        const indexKey = `${result.promoted.name}:${result.promoted.value}`;
        headerSessionIndex.set(indexKey, bestMatch.sid);
        log.info(
          `session ${bestMatch.sid.slice(0, 16)}: promoted header ${result.promoted.name} for Tier 2 identification`,
        );
      }
    }
    return { sessionID: bestMatch.sid, isNew: false, tier: 3 };
  }

  // No matching session → create new.
  const sessionID = generateSessionID();
  return { sessionID, isNew: true, tier: 3 };
}

// ---------------------------------------------------------------------------
// Upstream forwarding
// ---------------------------------------------------------------------------

/** Result from forwardToUpstream — includes the serialized body for cache analytics. */
type UpstreamResult = {
  response: Response;
  /** The serialized JSON body sent to the upstream provider. */
  serializedBody: string;
};

/**
 * Forward a request to the upstream provider (Anthropic or OpenAI).
 *
 * When an interceptor is provided (or a module-level one is active), the
 * interceptor is called instead of `fetch` directly.  This enables recording
 * and replay without modifying individual call sites.
 *
 * Returns the raw fetch Response alongside the serialized request body
 * (for cache analytics prefix comparison).
 */
async function forwardToUpstream(
  req: GatewayRequest,
  config: GatewayConfig,
  interceptor?: UpstreamInterceptor,
  cache?: AnthropicCacheOptions,
): Promise<UpstreamResult> {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  // Infer upstream from model name; fall back to protocol + env-var defaults.
  const route = resolveUpstreamRoute(req.model);
  const effectiveProtocol = route?.protocol ?? req.protocol;
  const effectiveUpstreamBase = route?.url ?? (effectiveProtocol === "openai" ? config.upstreamOpenAI : config.upstreamAnthropic);

  if (effectiveProtocol === "openai") {
    const result = buildOpenAIUpstreamRequest(req, effectiveUpstreamBase);
    url = result.url;
    headers = result.headers;
    body = result.body;
  } else {
    const result = buildAnthropicRequest(req, cache);
    url = `${effectiveUpstreamBase}${result.url}`;
    headers = result.headers;
    body = result.body;
  }

  let serializedBody = JSON.stringify(body);

  // Re-sign the billing header cch after body reconstruction.
  // buildAnthropicRequest completely rebuilds the body (different JSON key
  // ordering, cache_control wrappers, toAnthropicBlock transforms) which
  // invalidates the client's original cch signature. resignBody detects
  // billing headers and re-signs with our known seed + version.
  if (effectiveProtocol === "anthropic") {
    const firstUserMsg = req.messages.find((m) => m.role === "user");
    const firstUserText =
      firstUserMsg?.content.find((b) => b.type === "text" && "text" in b);
    serializedBody = resignBody(
      serializedBody,
      (firstUserText as { text: string } | undefined)?.text ?? "",
    );
  }

  const effectiveInterceptor = interceptor ?? activeInterceptor;

  if (effectiveInterceptor) {
    const response = await effectiveInterceptor(
      body,
      req.model,
      req.stream,
      () =>
        fetch(url, {
          method: "POST",
          headers,
          body: serializedBody,
        }),
    );
    return { response, serializedBody };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: serializedBody,
  });
  return { response, serializedBody };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Create a streaming SSE response from upstream with parallel accumulation.
 *
 * When `recallContext` is provided, uses a recall-aware accumulator that
 * transparently intercepts recall tool_use blocks:
 *  - **Case 1 (recall-only)**: pauses client stream, executes recall, sends
 *    a follow-up request, and pipes the continuation into the same HTTP
 *    response stream.
 *  - **Case 2 (mixed tools)**: suppresses recall blocks, stores the pending
 *    result for injection into the next request.
 */
function buildStreamingResponse(
  upstreamResponse: Response,
  onComplete: (response: GatewayResponse) => void,
  recallContext?: {
    modifiedReq: GatewayRequest;
    config: GatewayConfig;
    sessionState: SessionState;
    cacheOptions: AnthropicCacheOptions;
  },
): Response {
  const recallAccum = recallContext
    ? createRecallAwareAccumulator(RECALL_TOOL_NAME, { scaleClientUsage: true })
    : null;
  const accumulator: StreamAccumulator =
    recallAccum ?? createStreamAccumulator({ scaleClientUsage: true });
  const encoder = new TextEncoder();

  // Client-disconnect detection: shared between start() and cancel()
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Guard helpers for client-disconnect safety
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (cancelled) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };
      const safeClose = (): void => {
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          // Already closed/cancelled
        }
      };

      try {
        // Parse and forward upstream SSE events
        const reader = upstreamResponse.body!.getReader();
        activeReader = reader;
        for await (const { event, data } of parseSSEStream(reader)) {
          const forwarded = accumulator.processEvent(event, data);
          if (forwarded) {
            if (!safeEnqueue(encoder.encode(forwarded))) break;
          }
        }

        // --- Recall interception (streaming) ---
        if (recallAccum?.hasRecall()) {
          const resp = recallAccum.getResponse();
          const recallBlock = findRecallToolUse(resp);

          if (recallBlock && recallContext) {
            const { result, input } = await executeRecall(
              recallBlock,
              recallContext.sessionState.projectPath,
              recallContext.sessionState.sessionID,
            );

            const scope = input.scope ?? "all";

            // Store recall result for marker round-trip expansion
            const storeKey = recallStoreKey(input.query, scope);
            const position = resp.content.indexOf(recallBlock);
            recallContext.sessionState.recallStore.set(storeKey, {
              toolUseId: recallBlock.id,
              input,
              position,
              result,
            });

            // Emit marker text block in place of the suppressed recall block
            const markerText = buildRecallMarker(input.query, scope);
            const markerIdx = recallAccum.clientBlockCount();
            const syntheticMarker = [
              formatSSEEvent("content_block_start", JSON.stringify({
                type: "content_block_start",
                index: markerIdx,
                content_block: { type: "text", text: "" },
              })),
              formatSSEEvent("content_block_delta", JSON.stringify({
                type: "content_block_delta",
                index: markerIdx,
                delta: { type: "text_delta", text: markerText },
              })),
              formatSSEEvent("content_block_stop", JSON.stringify({
                type: "content_block_stop",
                index: markerIdx,
              })),
            ].join("");
            if (!safeEnqueue(encoder.encode(syntheticMarker))) return;

            if (recallAccum.hasOtherTools()) {
              // Forward held-back events, close stream
              log.info(
                `recall (stream, mixed): stored result for session ` +
                  `${recallContext.sessionState.sessionID.slice(0, 16)}`,
              );

              const heldBack = recallAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }

              // Post-stream: store response with marker text (not raw tool_use)
              const markerResp = replaceRecallWithMarker(resp);
              onComplete(markerResp);
              safeClose();
              return;
            }

            // Recall-only — send follow-up, pipe continuation
            log.info(
              `recall (stream, only): executing follow-up for session ` +
                `${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            const followUp = buildRecallFollowUp(
              recallContext.modifiedReq,
              resp,
              result,
              recallBlock,
            );
             let followUpResponse: Response;
            try {
              ({ response: followUpResponse } = await forwardToUpstream(
                followUp,
                recallContext.config,
                undefined,
                recallContext.cacheOptions,
              ));
            } catch (fetchErr) {
              log.error(
                `recall follow-up fetch error for session ${recallContext.sessionState.sessionID.slice(0, 16)}:`,
                fetchErr,
              );
              const heldBack = recallAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }
              const markerResp = replaceRecallWithMarker(resp);
              onComplete(markerResp);
              safeClose();
              return;
            }

            log.info(
              `recall follow-up response: status=${followUpResponse.status} ` +
                `hasBody=${!!followUpResponse.body} session=${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            if (!followUpResponse.ok) {
              const errorBody = await followUpResponse.text();
              log.error(
                `recall follow-up upstream error: ${followUpResponse.status} ${errorBody.slice(0, 500)}`,
              );
              // Forward the held-back events to close the stream gracefully
              const heldBack = recallAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }
              const markerResp = replaceRecallWithMarker(resp);
              onComplete(markerResp);
              safeClose();
              return;
            }

            // Pipe the continuation stream into the same HTTP response.
            // Suppress message_start (client already has one) and re-index
            // content blocks to continue from where the client left off.
            // +1 accounts for the synthetic marker block.
            const blockOffset = recallAccum.clientBlockCount() + 1;
            const contReader = followUpResponse.body!.getReader();
            activeReader = contReader;
            let contEventCount = 0;

            for await (const { event: contEvent, data: contData } of parseSSEStream(contReader)) {
              contEventCount++;
              if (contEvent === "message_start") {
                // Suppress — client already received one
                continue;
              }

              // Re-index content block events
              if (
                contEvent === "content_block_start" ||
                contEvent === "content_block_delta" ||
                contEvent === "content_block_stop"
              ) {
                try {
                  const parsed = JSON.parse(contData) as Record<string, unknown>;
                  if (typeof parsed.index === "number") {
                    parsed.index = (parsed.index as number) + blockOffset;
                    const adjusted = formatSSEEvent(
                      contEvent,
                      JSON.stringify(parsed),
                    );
                    if (!safeEnqueue(encoder.encode(adjusted))) break;
                    continue;
                  }
                } catch {
                  // Fall through to forward as-is
                }
              }

              // Forward message_delta, message_stop, and other events.
              // Scale usage in message_delta to prevent client auto-compaction.
              if (contEvent === "message_delta") {
                try {
                  const parsed = JSON.parse(contData) as Record<string, unknown>;
                  const deltaUsage = parsed.usage as Record<string, number> | undefined;
                  if (deltaUsage && typeof deltaUsage.output_tokens === "number") {
                    const innerResp = accumulator.getResponse();
                    const scaled = scaleUsageForClient({
                      input_tokens: innerResp.usage.inputTokens,
                      output_tokens: deltaUsage.output_tokens,
                      cache_read_input_tokens: innerResp.usage.cacheReadInputTokens,
                      cache_creation_input_tokens: innerResp.usage.cacheCreationInputTokens,
                    });
                    parsed.usage = { ...deltaUsage, output_tokens: scaled.output_tokens };
                    const adjusted = formatSSEEvent(contEvent, JSON.stringify(parsed));
                    if (!safeEnqueue(encoder.encode(adjusted))) break;
                    continue;
                  }
                } catch {
                  // Fall through to forward as-is
                }
              }
              const forwarded = formatSSEEvent(contEvent, contData);
              if (!safeEnqueue(encoder.encode(forwarded))) break;
            }

            log.info(
              `recall follow-up stream complete: ${contEventCount} events piped, ` +
                `session=${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            // Post-stream: store response with marker text for temporal storage.
            // The marker replaces the raw tool_use, so future turns can
            // round-trip the marker ↔ tool_use/tool_result correctly.
            const markerResp = replaceRecallWithMarker(resp);
            onComplete(markerResp);
            safeClose();
            return;
          }
        }

        // No recall — normal path
        const response = accumulator.getResponse();
        onComplete(response);
        safeClose();
      } catch (err) {
        log.error("streaming pipeline error:", err);
        try {
          controller.error(err);
        } catch {
          // Controller already closed or cancelled — error already logged above
        }
      }
    },
    cancel() {
      cancelled = true;
      try { activeReader?.cancel(); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Accumulate a non-streaming upstream response into a GatewayResponse.
 */
async function accumulateNonStreamResponse(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  const json = (await upstreamResponse.json()) as Record<string, unknown>;

  const content: GatewayContentBlock[] = [];
  const rawContent = json.content as Array<Record<string, unknown>> | undefined;
  if (rawContent) {
    for (const block of rawContent) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: String(block.text ?? "") });
          break;
        case "thinking":
          content.push({
            type: "thinking",
            thinking: String(block.thinking ?? ""),
            ...(block.signature
              ? { signature: String(block.signature) }
              : undefined),
          });
          break;
        case "tool_use":
          content.push({
            type: "tool_use",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: block.input,
          });
          break;
      }
    }
  }

  const usage = json.usage as Record<string, number> | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason: String(
      (json.stop_reason as string) ?? "end_turn",
    ),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
    },
  };
}

/**
 * Accumulate a streaming upstream SSE response into a GatewayResponse.
 *
 * Used for OpenAI requests where we need to convert the accumulated
 * response to OpenAI format before returning to the client.
 */
async function accumulateStreamResponse(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  const accumulator = createStreamAccumulator();
  const reader = upstreamResponse.body!.getReader();

  for await (const { event, data } of parseSSEStream(reader)) {
    accumulator.processEvent(event, data);
  }

  return accumulator.getResponse();
}

/**
 * Convert a GatewayResponse to a non-streaming HTTP Response.
 * Scales usage fields to prevent client auto-compaction.
 */
function nonStreamHttpResponse(resp: GatewayResponse): Response {
  // Scale usage so the client's token total stays below auto-compact threshold.
  // postResponse() has already consumed the real values for calibration/bustRate.
  const scaledUsage = scaleUsageForClient({
    input_tokens: resp.usage.inputTokens,
    output_tokens: resp.usage.outputTokens,
    cache_read_input_tokens: resp.usage.cacheReadInputTokens,
    cache_creation_input_tokens: resp.usage.cacheCreationInputTokens,
  });
  const scaledResp: GatewayResponse = {
    ...resp,
    usage: {
      inputTokens: scaledUsage.input_tokens,
      outputTokens: scaledUsage.output_tokens,
      cacheReadInputTokens: scaledUsage.cache_read_input_tokens,
      cacheCreationInputTokens: scaledUsage.cache_creation_input_tokens,
    },
  };
  const body = buildAnthropicNonStreamResponse(scaledResp);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Convert a GatewayResponse to a streaming SSE HTTP Response.
 */
function streamHttpResponse(resp: GatewayResponse): Response {
  // Build the full SSE text for a text-only response
  const textBlocks = resp.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  const fullText = textBlocks.map((b) => b.text).join("");

  const sseBody = buildSSETextResponse(resp.id, resp.model, fullText, {
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
  });

  return new Response(sseBody, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Post-response processing
// ---------------------------------------------------------------------------

/**
 * Run after a successful response: calibrate, store temporal messages,
 * and schedule background work (distillation, curation).
 */
function postResponse(
  req: GatewayRequest,
  resp: GatewayResponse,
  sessionState: SessionState,
  config: GatewayConfig,
  /** Serialized JSON body sent upstream — for cache prefix comparison. */
  requestBody?: string,
  /** Active gen_ai.chat span to finalize with usage attributes. */
  genAiSpan?: Sentry.Span,
): void {
  const { sessionID, projectPath } = sessionState;

  try {
    // --- Calibrate overhead from real token counts ---
    const actualInput =
      (resp.usage.inputTokens ?? 0) +
      (resp.usage.cacheReadInputTokens ?? 0) +
      (resp.usage.cacheCreationInputTokens ?? 0);
    calibrate(
      actualInput,
      sessionID,
      getLastTransformedCount(sessionID),
    );

    // --- Sentry cache context + cost metric ---
    setSentryCacheContext(resp.usage);
    const usageForSentry: AnthropicUsage = {
      input_tokens: resp.usage.inputTokens,
      output_tokens: resp.usage.outputTokens,
      cache_read_input_tokens: resp.usage.cacheReadInputTokens,
      cache_creation_input_tokens: resp.usage.cacheCreationInputTokens,
    };
    emitCostMetric(resp.model, usageForSentry, "conversation");
    if (genAiSpan) {
      setGenAiUsageAttributes(genAiSpan, usageForSentry, resp.model);
    }

    // --- Cache analytics + bust cause telemetry ---
    // Run BEFORE genAiSpan.end() so we can enrich the span with
    // divergence diagnostics (divergence point, prefix match, bust cause).
    if (requestBody) {
      const turnAnalysis = analyzeCacheTurn(
        sessionState.cacheAnalytics, requestBody, resp.usage, sessionID,
        sessionState.messageCount,
      );
      const bustCause = categorizeBust(
        turnAnalysis,
        sessionState.lastTurnWasIdle ?? false,
      );
      if (genAiSpan) {
        setCacheAnalyticsAttributes(
          genAiSpan, turnAnalysis, bustCause,
          turnAnalysis.prevSnippet, turnAnalysis.currSnippet,
        );
      }
      emitCacheBustMetric(
        bustCause,
        resp.usage.cacheCreationInputTokens ?? 0,
        resp.model,
      );
      sessionState.lastTurnWasIdle = false; // consumed

      // Track cold-cache turns for auto-TTL upgrade (rolling 20-turn window)
      const cacheRead = resp.usage.cacheReadInputTokens ?? 0;
      const cacheCreation = resp.usage.cacheCreationInputTokens ?? 0;
      const isColdTurn = cacheRead === 0 && cacheCreation > 0;
      if (!sessionState.coldCacheWindow) sessionState.coldCacheWindow = [];
      sessionState.coldCacheWindow.push(isColdTurn);
      if (sessionState.coldCacheWindow.length > 20) {
        sessionState.coldCacheWindow.shift();
      }
    }

    // --- Finalize gen_ai.chat span (after cache analytics enrichment) ---
    if (genAiSpan) {
      genAiSpan.end();
    }

    // --- Bust rate feedback for dynamic context cap ---
    updateBustRate(
      resp.usage.cacheCreationInputTokens ?? 0,
      resp.usage.cacheReadInputTokens ?? 0,
      sessionState.sessionID,
    );

    // --- Temporal storage ---
    // Store all messages (user + assistant) from this turn.
    // Convert gateway messages to Lore format.
    const loreMessages = gatewayMessagesToLore(req.messages, sessionID);
    resolveToolResults(loreMessages);

    // Store the latest user message (last user message in the array)
    for (let i = loreMessages.length - 1; i >= 0; i--) {
      if (loreMessages[i].info.role === "user") {
        temporal.store({
          projectPath,
          info: loreMessages[i].info,
          parts: loreMessages[i].parts,
        });
        break;
      }
    }

    // Build and store the assistant response message
    const assistantMsg = gatewayMessagesToLore(
      [{ role: "assistant", content: resp.content }],
      sessionID,
    )[0];
    updateAssistantMessageTokens(assistantMsg, resp.usage, resp.model);
    temporal.store({
      projectPath,
      info: assistantMsg.info,
      parts: assistantMsg.parts,
    });

    // Update session state
    sessionState.turnsSinceCuration =
      (sessionState.turnsSinceCuration ?? 0) + 1;

    // --- Schedule background work (fire-and-forget) ---
    scheduleBackgroundWork(sessionState, config);
  } catch (e) {
    log.error("post-response processing failed:", e);
  }
}

/**
 * Schedule background distillation and curation (fire-and-forget).
 */
function scheduleBackgroundWork(
  sessionState: SessionState,
  config: GatewayConfig,
): void {
  const { sessionID, projectPath } = sessionState;
  const llm = getLLMClient(config);
  const cfg = loreConfig();
  const model = getWorkerModel();

  // Check if urgent distillation is needed (gradient flagged it).
  // Mark urgent: true so these bypass the batch queue — the gradient is
  // in overflow and needs the result before the next user turn.
  if (needsUrgentDistillation(sessionState.sessionID)) {
    distillation
      .run({
        llm,
        projectPath,
        sessionID,
        model,
        force: true,
        urgent: true,
      })
      .catch((e) => log.error("background distillation failed:", e));
  }

  // Check if pending messages exceed maxSegment threshold
  const pending = temporal.undistilledCount(projectPath, sessionID);
  if (pending >= cfg.distillation.maxSegment) {
    log.info(
      `incremental distillation: ${pending} undistilled messages in ${sessionID.slice(0, 16)}`,
    );
    distillation
      .run({ llm, projectPath, sessionID, model })
      .catch((e) => log.error("background distillation failed:", e));
  }

  // Curation: run periodically when the knowledge system is enabled.
  // Cost-aware frequency: on expensive models, curate less often to reduce
  // the probability of LTM changes that bust the cache. Each LTM change
  // that exceeds the diff pinning threshold invalidates tools + messages.
  const modelInputCost = getModelEntrySync(
    getWorkerModel()?.modelID ?? "unknown",
  ).cost?.input ?? 3;
  const curationMultiplier = modelInputCost >= 5 ? 3 : modelInputCost >= 1 ? 2 : 1;
  const effectiveAfterTurns = cfg.curator.afterTurns * curationMultiplier;

  if (
    cfg.knowledge.enabled &&
    cfg.curator.onIdle &&
    sessionState.turnsSinceCuration >= effectiveAfterTurns
  ) {
    curator
      .run({ llm, projectPath, sessionID, model })
      .then(() => {
        sessionState.turnsSinceCuration = 0;
        // Invalidate LTM cache after curation changes knowledge entries
        ltmSessionCache.delete(sessionID);
      })
      .catch((e) => log.error("background curation failed:", e));
  }
}

// ---------------------------------------------------------------------------
// Case 1: Compaction interception
// ---------------------------------------------------------------------------

async function handleCompaction(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  // Identify session
  const projectPath = cachedProjectPath ?? getProjectPath(req.system, req.rawHeaders);
  await initIfNeeded(projectPath, config);

  const { sessionID } = await identifySession(req, projectPath);
  const sessionState = getOrCreateSession(sessionID, projectPath);
  const llm = getLLMClient(config);

  setSentryLightContext({ model: req.model, projectPath });

  log.info(`compaction intercepted for session ${sessionID.slice(0, 16)}`);

  // 1. Force-distill all undistilled messages.
  // Mark urgent: true — client is blocking on the compaction response.
  const model = getWorkerModel();
  await distillation.run({
    llm,
    projectPath,
    sessionID,
    model,
    force: true,
    urgent: true,
  });

  // 2. Load distillation summaries
  const distillations = distillation.loadForSession(projectPath, sessionID);

  // 3. Extract previous summary from the request (if any)
  const previousSummary = extractPreviousSummary(req);

  // 4. Build knowledge block
  const cfg = loreConfig();
  const entries = cfg.knowledge.enabled
    ? ltm.forProject(projectPath, cfg.crossProject)
    : [];
  const knowledge = entries.length
    ? formatKnowledge(
        entries.map((e) => ({
          category: e.category,
          title: e.title,
          content: e.content,
        })),
      )
    : "";

  // 5. Build the compact prompt
  const compactPrompt = buildCompactPrompt({
    hasDistillations: distillations.length > 0,
    knowledge,
    previousSummary,
  });

  // 6. Build context with distillation summaries
  let context = "";
  if (distillations.length > 0) {
    context =
      `## Lore Pre-computed Session Summaries\n\n` +
      `The following ${distillations.length} summary chunk(s) were pre-computed ` +
      `from the conversation history. Use these as the authoritative source.\n\n` +
      distillations
        .map(
          (d, i) =>
            `### Chunk ${i + 1}${d.generation > 0 ? " (consolidated)" : ""}\n${d.observations}`,
        )
        .join("\n\n");
  }

  // 7. Generate the compaction summary via LLM
  const userContent = context
    ? `${context}\n\n---\n\n${compactPrompt}`
    : compactPrompt;

  const summaryText = await llm.prompt(compactPrompt, userContent, {
    model: cfg.model,
    workerID: "lore-compact",
    urgent: true, // Client is blocking on this response
  });

  const summary = summaryText ?? "(Compaction failed — no summary generated.)";

  // 8. Build and return the response
  const resp = buildCompactionResponse(sessionID, summary, req.model);

  if (req.stream) {
    return streamHttpResponse(resp);
  }
  return nonStreamHttpResponse(resp);
}

// ---------------------------------------------------------------------------
// Case 2: Title/summary passthrough
// ---------------------------------------------------------------------------

async function handlePassthrough(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  setSentryLightContext({ model: req.model });

  const { response: upstreamResponse } = await forwardToUpstream(req, config);

  // For streaming, pipe through unchanged
  if (req.stream && upstreamResponse.body) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: {
        "content-type":
          upstreamResponse.headers.get("content-type") ??
          "text/event-stream",
      },
    });
  }

  // For non-streaming, pass through the JSON response as-is
  const body = await upstreamResponse.text();
  return new Response(body, {
    status: upstreamResponse.status,
    headers: {
      "content-type": "application/json",
    },
  });
}

// ---------------------------------------------------------------------------
// Case 3: Normal conversation turn — full pipeline
// ---------------------------------------------------------------------------

async function handleConversationTurn(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  // --- 1. Project path & init ---
  const projectPath = getProjectPath(req.system, req.rawHeaders);
  await initIfNeeded(projectPath, config);

  // --- 2. Capture auth credentials for background workers ---
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    setLastSeenAuth(cred);
  }

  // --- 3. Session identification ---
  const { sessionID, isNew, tier } = await identifySession(req, projectPath);
  const sessionState = getOrCreateSession(sessionID, projectPath);

  // Bind auth credential to this session for background workers
  if (cred) {
    setSessionAuth(sessionID, cred);
  }

  // Capture billing header prefix for worker cch computation, scoped to
  // this session. Bearer tokens (Claude Code OAuth) embed an
  // x-anthropic-billing-header in the system prompt; we extract the prefix
  // so workers can rebuild it. Per-session storage prevents cross-session
  // contamination when multiple Claude Code versions share one process.
  captureBillingPrefix(sessionID, req.system);

  // Track fingerprint for future correlation
  if (isNew) {
    const fingerprint = await fingerprintMessages(
      req.messages.map((m) => ({ role: m.role, content: m.content })),
      {
        authSuffix: cred ? authFingerprint(cred) : "",
      },
    );
    sessionState.fingerprint = fingerprint;

    // Seed header learning for new sessions (Tier 2 bootstrap).
    // Even Tier 1 sessions don't need this, but it's harmless and
    // avoids branching. For Tier 3 (fingerprinted) new sessions,
    // this seeds the first round of candidate collection.
    if (!sessionState.headerSessionId) {
      const result = learnHeaders(sessionState.candidateHeaders, req.rawHeaders);
      sessionState.candidateHeaders = result.updatedCandidates;
    }
  }

  // --- Compaction anomaly detection ---
  // If we reach here (normal turn) with a large message count drop, the client
  // performed compaction that slipped past both structural and pattern detection.
  const prevMsgCount = sessionState.messageCount;
  const currMsgCount = req.messages.length;
  if (prevMsgCount > 10 && currMsgCount < prevMsgCount * 0.5) {
    log.warn(
      `compaction anomaly: session=${sessionID.slice(0, 16)} ` +
        `messages dropped ${prevMsgCount}→${currMsgCount}. ` +
        `Client may have compacted outside gateway control.`,
    );
  }

  // Always update message count for proximity matching
  sessionState.messageCount = currMsgCount;

  // Track session model for worker model discovery
  lastSeenSessionModel = req.model;

  // --- Sentry scope enrichment ---
  setSentryRequestContext({
    authFingerprint: cred ? authFingerprint(cred) : null,
    sessionID,
    model: req.model,
    upstreamUrl: resolveUpstreamRoute(req.model)?.url ?? config.upstreamAnthropic,
    port: config.port,
    projectPath,
  });

  // --- Expand recall markers from previous turns ---
  // Scan all assistant messages for marker text blocks and restore them
  // to tool_use + tool_result pairs before forwarding upstream.
  if (sessionState.recallStore.size > 0) {
    const expanded = expandRecallMarkers(req, sessionState.recallStore);
    if (expanded) {
      log.info(
        `expanded recall markers for session ${sessionID.slice(0, 16)}`,
      );
    }
    // Clean up orphaned store entries (markers evicted by gradient)
    cleanupRecallStore(req, sessionState.recallStore);
  }

  log.info(
    `turn: session=${sessionID.slice(0, 16)} messages=${req.messages.length} ` +
      `model=${req.model} stream=${req.stream} new=${isNew} tier=${tier}`,
  );

  // --- 4. Set model limits ---
  const modelSpec = getModelSpec(req.model);
  setModelLimits({ context: modelSpec.context, output: modelSpec.output });

  // Cost-aware layer-0 cap: explicit config wins > cost formula > disabled.
  const cfg = loreConfig();
  if (cfg.budget.maxLayer0Tokens !== undefined) {
    setMaxLayer0Tokens(cfg.budget.maxLayer0Tokens);
  } else if (modelSpec.cacheReadCost && cfg.budget.targetCacheReadCostPerTurn > 0) {
    setMaxLayer0Tokens(computeLayer0Cap(
      cfg.budget.targetCacheReadCostPerTurn,
      modelSpec.cacheReadCost,
    ));
  }

  // Cost-aware total context cap (layer 1+): explicit config wins > cost formula > disabled.
  // Limits per-bust cache write cost. Dynamic adaptation per session is handled
  // in gradient.ts via updateBustRate() feedback from postResponse().
  if (cfg.budget.maxContextTokens !== undefined) {
    setMaxContextTokens(cfg.budget.maxContextTokens);
  } else if (modelSpec.cacheWriteCost && cfg.budget.targetBustCost > 0) {
    setMaxContextTokens(computeContextCap(
      cfg.budget.targetBustCost,
      modelSpec.cacheWriteCost,
    ));
  }

  // --- 5. Cold-cache idle-resume ---
  // Auto-sync idle threshold with conversation TTL: when 1h TTL is active
  // (explicit or auto-upgraded), use 60 min idle threshold instead of the
  // configured value (which defaults to 5 min for the default cache tier).
  const effectiveIdleMinutes =
    sessionState.resolvedConversationTTL === "1h" && cfg.idleResumeMinutes <= 5
      ? 60
      : cfg.idleResumeMinutes;
  const thresholdMs = effectiveIdleMinutes * 60_000;
  const idleResult = onIdleResume(sessionID, thresholdMs);
  sessionState.lastTurnWasIdle = idleResult.triggered;
  if (idleResult.triggered) {
    ltmSessionCache.delete(sessionID);
    log.info(
      `session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches`,
    );
  }

  // --- 6. LTM injection (kept separate from host system prompt for caching) ---
  let ltmText: string | undefined;
  if (cfg.knowledge.enabled) {
    try {
      let cached = ltmSessionCache.get(sessionID);

      if (!cached) {
        const ltmFraction = cfg.budget.ltm;
        const ltmBudget = getLtmBudget(ltmFraction);
        const entries = ltm.forSession(projectPath, sessionID, ltmBudget);
        if (entries.length) {
          const formatted = formatKnowledge(
            entries.map((e) => ({
              category: e.category,
              title: e.title,
              content: e.content,
            })),
            ltmBudget,
          );

          if (formatted) {
            const tokenCount = Math.ceil(formatted.length / 3);
            cached = { formatted, tokenCount };
            ltmSessionCache.set(sessionID, cached);
          }
        }
      }

      if (cached) {
        // Content-diff pinning: only update the injected LTM text if the
        // new content differs by more than a threshold from what's currently
        // pinned. This prevents cache busts from minor BM25 re-ranking after
        // background curation/consolidation invalidates the LTM cache.
        // Cost-aware threshold: on expensive models, tolerate larger diffs
        // before busting the cache prefix (opus: 15%, sonnet: 10%, haiku: 5%).
        const baseDiffThreshold = 0.05;
        const effectiveDiffThreshold = (modelSpec.inputCostPerMillion ?? 3) >= 5
          ? Math.min(baseDiffThreshold * 3, 0.20)  // opus: 15%
          : (modelSpec.inputCostPerMillion ?? 3) >= 1
            ? Math.min(baseDiffThreshold * 2, 0.15)  // sonnet: 10%
            : baseDiffThreshold;                       // haiku: 5%

        const pinned = ltmPinnedText.get(sessionID);
        if (pinned && textDiffRatio(pinned.formatted, cached.formatted) < effectiveDiffThreshold) {
          // Near-identical — keep the pinned text to preserve cache prefix
          ltmText = pinned.formatted;
          setLtmTokens(pinned.tokenCount, sessionID);
        } else {
          // Substantially different or first injection — pin the new text
          ltmPinnedText.set(sessionID, cached);
          ltmText = cached.formatted;
          setLtmTokens(cached.tokenCount, sessionID);
        }
      } else {
        setLtmTokens(0, sessionID);
      }
    } catch (e) {
      log.error("LTM injection failed:", e);
      setLtmTokens(0, sessionID);
    } finally {
      consumeCameOutOfIdle(sessionID);
    }
  } else {
    setLtmTokens(0, sessionID);
    consumeCameOutOfIdle(sessionID);
  }

  // --- 7. Gradient transform on messages ---
  const loreMessages = gatewayMessagesToLore(req.messages, sessionID);
  resolveToolResults(loreMessages);

  const result = transform({
    messages: loreMessages,
    projectPath,
    sessionID,
  });

  // Drop trailing pure-text assistant messages to prevent prefill errors
  while (
    result.messages.length > 0 &&
    result.messages.at(-1)!.info.role !== "user"
  ) {
    const last = result.messages.at(-1)!;
    const hasToolParts = last.parts.some((p) => p.type === "tool");
    if (hasToolParts) break;
    result.messages.pop();
  }

  // --- 8. Build the modified request ---
  // Reconstruct GatewayMessages from the transformed Lore messages.
  // loreMessagesToGateway reconstructs tool_result blocks from assistant's
  // completed/error tool parts; removeOrphanedToolResults is a safety net
  // that catches any remaining orphaned tool_result references.
  const transformedMessages = loreMessagesToGateway(result.messages);
  removeOrphanedToolResults(transformedMessages);

  const modifiedReq: GatewayRequest = {
    ...req,
    // Host system prompt is passed through unmodified — LTM is injected
    // as a separate system block via cache options for prefix stability.
    messages: transformedMessages,
  };

  // --- 8b. Inject recall tool (with git reminder appended to description) ---
  // Only inject if the client doesn't already have a recall tool (e.g. from
  // a host plugin like OpenCode) and the request has other tools (so it's a
  // coding agent, not a bare chat).
  if (modifiedReq.tools.length > 0 && !clientHasRecallTool(modifiedReq.tools)) {
    // Build the recall tool with git reminder baked into its description.
    // This keeps the reminder in the stable tools prefix (1h cache) rather
    // than the volatile system prompt.
    const recallTool = cfg.knowledge.enabled
      ? {
          ...RECALL_GATEWAY_TOOL,
          description:
            RECALL_GATEWAY_TOOL.description +
            "\n\nWhen making git commits, always check if .lore.md " +
            "has unstaged changes and include it in the commit. " +
            "This file contains shared project knowledge managed " +
            "by lore and must be version-controlled.",
        }
      : RECALL_GATEWAY_TOOL;
    modifiedReq.tools = [...modifiedReq.tools, recallTool];
  }

  // --- 9. Forward to upstream ---
  // Enable prompt caching for conversation turns with layered breakpoints:
  //  - System prompt: 1h TTL (host prompt is very stable within a session)
  //  - LTM: separate system block (no breakpoint, benefits from prefix)
  //  - Tools: 1h TTL on last tool (recall + git reminder are static)
  //  - Conversation: configurable TTL on last message block (5m default, 1h opt-in/auto)
  // Title/summary passthrough (handlePassthrough) never reaches here — it
  // forwards the raw request without buildAnthropicRequest, so no caching.

  // Resolve conversation cache TTL: explicit "5m"/"1h" pass through,
  // "auto" upgrades to 1h when cold-cache turns exceed 40% of recent window.
  let resolvedConversationTTL: "5m" | "1h" = sessionState.resolvedConversationTTL ?? "5m";
  const configTTL = cfg.cache.conversationTTL;
  if (configTTL === "5m" || configTTL === "1h") {
    resolvedConversationTTL = configTTL;
  } else if (configTTL === "auto") {
    const window = sessionState.coldCacheWindow;
    if (window && window.length >= 5) {
      const coldFraction = window.filter(Boolean).length / window.length;
      if (coldFraction > 0.4 && resolvedConversationTTL === "5m") {
        resolvedConversationTTL = "1h";
        log.info(
          `auto-upgrade conversation TTL to 1h: session=${sessionID.slice(0, 16)}` +
          ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
        );
      } else if (coldFraction < 0.2 && resolvedConversationTTL === "1h") {
        resolvedConversationTTL = "5m";
        log.info(
          `auto-downgrade conversation TTL to 5m: session=${sessionID.slice(0, 16)}` +
          ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
        );
      }
    }
  }
  sessionState.resolvedConversationTTL = resolvedConversationTTL;

  const cacheOptions: AnthropicCacheOptions = {
    systemTTL: "1h",
    ltmSystem: ltmText,
    cacheTools: true,
    cacheConversation: true,
    conversationTTL: resolvedConversationTTL,
  };

  // Start gen_ai.chat span before the upstream call so it captures real
  // wall-clock duration (including network latency and streaming time).
  // The span is ended in postResponse() after usage attributes are set.
  const genAiSpan = Sentry.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${req.model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": req.model,
      "gen_ai.provider.name":
        resolveUpstreamRoute(req.model)?.protocol ?? "anthropic",
      "gen_ai.response.streaming": req.stream,
      // NO gen_ai.input.messages — privacy (proxy for other people's projects)
    },
  });

  const { response: upstreamResponse, serializedBody: requestBody } =
    await forwardToUpstream(
      modifiedReq,
      config,
      undefined,
      cacheOptions,
    );

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    log.error(
      `upstream error: ${upstreamResponse.status} ${errorBody.slice(0, 500)}`,
    );
    genAiSpan.setStatus({ code: 2, message: `HTTP ${upstreamResponse.status}` });
    genAiSpan.end();
    return new Response(errorBody, {
      status: upstreamResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.stream && upstreamResponse.body) {
    // Streaming: forward events and accumulate in parallel.
    // Pass recall context so the accumulator can intercept recall tool_use.
    const hasRecallTool = modifiedReq.tools.some(
      (t) => t.name === RECALL_TOOL_NAME,
    );
    return buildStreamingResponse(
      upstreamResponse,
      (resp) => postResponse(req, resp, sessionState, config, requestBody, genAiSpan),
      hasRecallTool
        ? { modifiedReq, config, sessionState, cacheOptions }
        : undefined,
    );
  }

  // Non-streaming (also used for OpenAI protocol via accumulateStreamResponse)
  const resp = await accumulateNonStreamResponse(upstreamResponse);

  // --- Recall interception (non-streaming) ---
  if (hasRecallToolUse(resp)) {
    const recallBlock = findRecallToolUse(resp)!;
    const { result, input } = await executeRecall(
      recallBlock,
      sessionState.projectPath,
      sessionState.sessionID,
    );

    // Store recall result for marker round-trip expansion
    const storeKey = recallStoreKey(input.query, input.scope ?? "all");
    const position = resp.content.indexOf(recallBlock);
    sessionState.recallStore.set(storeKey, {
      toolUseId: recallBlock.id,
      input,
      position,
      result,
    });

    // Replace recall tool_use with marker text in the response
    const markerResp = replaceRecallWithMarker(resp);

    if (hasOtherToolUse(resp)) {
      // Mixed tools — return response with marker replacing recall tool_use
      log.info(
        `recall (non-stream, mixed): stored result for session ${sessionState.sessionID.slice(0, 16)}`,
      );
      postResponse(req, markerResp, sessionState, config, requestBody, genAiSpan);
      return nonStreamHttpResponse(markerResp);
    }

    // Recall-only — send follow-up request for seamless UX
    log.info(
      `recall (non-stream, only): executing follow-up for session ${sessionState.sessionID.slice(0, 16)}`,
    );
    const followUp = buildRecallFollowUp(modifiedReq, resp, result, recallBlock);
    let followUpResponse: Response;
    ({ response: followUpResponse } = await forwardToUpstream(
      followUp,
      config,
      undefined,
      cacheOptions,
    ));

    if (!followUpResponse.ok) {
      const errorBody = await followUpResponse.text();
      log.error(
        `recall follow-up upstream error: ${followUpResponse.status} ${errorBody.slice(0, 500)}`,
      );
      // Fall back to response with marker (no continuation)
      postResponse(req, markerResp, sessionState, config, requestBody, genAiSpan);
      return nonStreamHttpResponse(markerResp);
    }

    const continuationResp = await accumulateNonStreamResponse(followUpResponse);

    // Merge usage from both requests
    continuationResp.usage.inputTokens += resp.usage.inputTokens;
    continuationResp.usage.outputTokens += resp.usage.outputTokens;
    if (resp.usage.cacheReadInputTokens) {
      continuationResp.usage.cacheReadInputTokens =
        (continuationResp.usage.cacheReadInputTokens ?? 0) +
        resp.usage.cacheReadInputTokens;
    }
    if (resp.usage.cacheCreationInputTokens) {
      continuationResp.usage.cacheCreationInputTokens =
        (continuationResp.usage.cacheCreationInputTokens ?? 0) +
        resp.usage.cacheCreationInputTokens;
    }

    postResponse(req, continuationResp, sessionState, config, requestBody, genAiSpan);
    return nonStreamHttpResponse(continuationResp);
  }

  postResponse(req, resp, sessionState, config, requestBody, genAiSpan);
  return nonStreamHttpResponse(resp);
}

// ---------------------------------------------------------------------------
// Lore message → Gateway message conversion
// ---------------------------------------------------------------------------

/**
 * Convert transformed Lore messages back to gateway message format.
 *
 * This reverses `gatewayMessagesToLore` after gradient transform has
 * potentially trimmed/reordered messages.
 *
 * Completed/error tool parts on assistant messages produce BOTH a `tool_use`
 * block on the assistant AND a corresponding `tool_result` block injected at
 * the start of the following user message. This makes the conversion
 * self-contained: tool pairing is reconstructed from whatever messages
 * survived gradient eviction, without depending on cross-message `tool_result`
 * parts that can become orphaned when the assistant message is evicted.
 *
 * `resolveToolResults()` strips `tool: "result"` parts from user messages
 * after pairing, so under normal operation those parts are gone. The fallback
 * handling for residual `tool: "result"` parts is kept for robustness.
 */
/** @internal Exported for tests. */
export function loreMessagesToGateway(
  messages: LoreMessageWithParts[],
): Array<{ role: "user" | "assistant"; content: GatewayContentBlock[] }> {
  const out: Array<{
    role: "user" | "assistant";
    content: GatewayContentBlock[];
  }> = [];

  // tool_result blocks reconstructed from the preceding assistant message's
  // completed/error tool parts. Injected at the start of the next user message.
  let pendingToolResults: GatewayContentBlock[] = [];

  for (const msg of messages) {
    const content: GatewayContentBlock[] = [];

    if (msg.info.role === "user") {
      // Inject reconstructed tool_result blocks from preceding assistant
      content.push(...pendingToolResults);
      pendingToolResults = [];
    } else {
      // New assistant message — reset pending results (shouldn't have any
      // in well-formed conversations, but handles back-to-back assistants)
      pendingToolResults = [];
    }

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          content.push({
            type: "text",
            text: (part as { text: string }).text,
          });
          break;
        case "reasoning":
          content.push({
            type: "thinking",
            thinking: (part as { text: string }).text ?? "",
            ...((part as { signature?: string }).signature != null
              ? { signature: (part as { signature?: string }).signature }
              : undefined),
          });
          break;
        case "tool": {
          const toolPart = part as {
            type: "tool";
            tool: string;
            callID: string;
            state: {
              status: string;
              input?: unknown;
              output?: string;
              error?: string;
            };
          };
          if (toolPart.tool === "result") {
            // Residual tool_result part (should have been stripped by
            // resolveToolResults, but handle gracefully for robustness)
            content.push({
              type: "tool_result",
              toolUseId: toolPart.callID,
              content: toolPart.state.output ?? "",
            });
          } else {
            // Emit tool_use on this assistant message
            content.push({
              type: "tool_use",
              id: toolPart.callID,
              name: toolPart.tool,
              input: toolPart.state.input ?? {},
            });
            // Completed/error tool parts: queue a tool_result for the next
            // user message. This reconstructs the Anthropic API's split-
            // message format from Lore's single-message representation.
            if (toolPart.state.status === "completed") {
              pendingToolResults.push({
                type: "tool_result",
                toolUseId: toolPart.callID,
                content: toolPart.state.output ?? "",
              });
            } else if (toolPart.state.status === "error") {
              pendingToolResults.push({
                type: "tool_result",
                toolUseId: toolPart.callID,
                content: toolPart.state.error ?? "[error]",
                isError: true,
              });
            }
            // Pending tool parts (not yet resolved) only emit tool_use —
            // the model will see an unresolved tool call. sanitizeToolParts
            // in gradient.ts converts these to error state before this point.
          }
          break;
        }
        // Generic / unknown parts — skip or represent as text
        default:
          if ("text" in part && typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
          }
          break;
      }
    }

    out.push({ role: msg.info.role as "user" | "assistant", content });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Post-conversion validation: remove orphaned tool_result blocks
// ---------------------------------------------------------------------------

/**
 * Belt-and-suspenders safety net: ensures every `tool_result` block on a user
 * message references a `tool_use` block on the immediately preceding assistant
 * message. Removes orphans and logs a warning.
 *
 * This should never fire under normal operation (resolveToolResults strips
 * redundant tool_result parts, and loreMessagesToGateway reconstructs them
 * from the assistant's completed tool parts). But if a future code path
 * introduces orphaned references, this catches them before they reach the API.
 */
/** @internal Exported for tests. */
export function removeOrphanedToolResults(
  messages: Array<{
    role: "user" | "assistant";
    content: GatewayContentBlock[];
  }>,
): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    if (!msg.content.some((b) => b.type === "tool_result")) continue;

    // Collect tool_use IDs from the preceding assistant message
    const prev =
      i > 0 && messages[i - 1]!.role === "assistant"
        ? messages[i - 1]!
        : null;
    const toolUseIds = new Set(
      (prev?.content ?? [])
        .filter((b): b is GatewayToolUseBlock => b.type === "tool_use")
        .map((b) => b.id),
    );

    // Remove tool_result blocks that reference missing tool_use IDs
    const before = msg.content.length;
    msg.content = msg.content.filter(
      (b) =>
        b.type !== "tool_result" ||
        toolUseIds.has((b as GatewayToolResultBlock).toolUseId),
    );
    if (msg.content.length < before) {
      log.warn(
        `removed ${before - msg.content.length} orphaned tool_result block(s) from message ${i}`,
      );
    }
    // If the user message is now empty, add placeholder text so the API
    // doesn't reject an empty content array.
    if (msg.content.length === 0) {
      msg.content = [{ type: "text", text: "[tool results provided]" }];
    }
  }
}

// ---------------------------------------------------------------------------
// Error response builder
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "server_error",
        message,
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process an incoming gateway request through the full Lore pipeline.
 *
 * Returns a standard `Response` object — either a streaming SSE response
 * or a JSON response, depending on the client's `stream` setting.
 */
export async function handleRequest(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  try {
    // Capture auth credentials early for background workers
    const earlyAuth = extractAuth(req.rawHeaders);
    if (earlyAuth) {
      setLastSeenAuth(earlyAuth);
    }

    // --- Quick Tier-1 session lookup for structural compaction detection ---
    // O(1) header + map lookup — lets us compare message counts before routing.
    let priorState: SessionState | undefined;
    const known = extractKnownSessionHeader(req.rawHeaders);
    if (known) {
      const indexKey = `${known.headerName}:${known.sessionId}`;
      const sid = headerSessionIndex.get(indexKey);
      if (sid) priorState = sessions.get(sid);
    }

    // --- Case 1: Compaction request → intercept ---
    // Structural detection (session-aware) first, pattern matching as fallback.
    if (
      isStructuralCompaction(req, priorState) ||
      isCompactionRequest(req)
    ) {
      return await handleCompaction(req, config);
    }

    // --- Case 2: Title/summary request → passthrough ---
    if (isTitleOrSummaryRequest(req)) {
      return await handlePassthrough(req, config);
    }

    // --- Case 3: Normal conversation turn → full pipeline ---
    return await handleConversationTurn(req, config);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown gateway error";
    log.error("pipeline error:", err);
    return errorResponse(502, message);
  }
}
