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
  isFirstRun,
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
} from "./session";
import {
  isCompactionRequest,
  isTitleOrSummaryRequest,
  extractPreviousSummary,
  buildCompactionResponse,
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
import { getWorkerModel, resetWorkerModelState } from "./worker-model";
import {
  RECALL_GATEWAY_TOOL,
  RECALL_TOOL_NAME,
  executeRecall,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  isPendingRecallValid,
  injectPendingRecall,
  buildRecallFollowUp,
  stripRecallFromResponse,
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

/** Cached LLM client for background workers. */
let llmClient: LLMClient | null = null;

/** Cleanup function for the idle scheduler timer. */
let stopIdleScheduler: (() => void) | null = null;

/** Last seen session model ID — used for worker model discovery context. */
let lastSeenSessionModel: string | null = null;

// ---------------------------------------------------------------------------
// Model limits — hardcoded for known models, fallback for unknown
// ---------------------------------------------------------------------------

type ModelSpec = {
  context: number;
  output: number;
  /** Cache-read cost per token in USD (Anthropic: 10% of input price). */
  cacheReadCost?: number;
};

const MODEL_SPECS: Record<string, ModelSpec> = {
  // Pricing: https://docs.anthropic.com/en/docs/about-claude/models
  // Cache-read = input_price / 1_000_000 * 0.1 (10% of input for Anthropic)
  "claude-opus-4":     { context: 200_000, output: 32_000, cacheReadCost: 15 / 1_000_000 * 0.1 },
  "claude-sonnet-4":   { context: 200_000, output: 16_000, cacheReadCost: 3 / 1_000_000 * 0.1 },
  "claude-sonnet-3-5": { context: 200_000, output: 8_192,  cacheReadCost: 3 / 1_000_000 * 0.1 },
  "claude-haiku-3-5":  { context: 200_000, output: 8_192,  cacheReadCost: 0.80 / 1_000_000 * 0.1 },
};

const DEFAULT_MODEL_SPEC: ModelSpec = { context: 200_000, output: 8_192 };

function getModelSpec(model: string): ModelSpec {
  // Check for prefix matches: "claude-opus-4-20250514" → "claude-opus-4"
  for (const [prefix, spec] of Object.entries(MODEL_SPECS)) {
    if (model.startsWith(prefix)) return spec;
  }
  return DEFAULT_MODEL_SPEC;
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

  // Start the idle scheduler for background work (distillation, curation,
  // pruning, AGENTS.md export). Uses a 30s poll interval and fires for any
  // session whose lastRequestTime exceeds the idle timeout.
  if (config && !stopIdleScheduler) {
    const llm = getLLMClient(config);
    const sessionModelID = lastSeenSessionModel ?? (loreConfig().model?.modelID ?? "claude-sonnet-4-20250514");
    const idleHandler = buildIdleWorkHandler(
      projectPath,
      llm,
      config.upstreamAnthropic,
      () => resolveAuth(),
      sessionModelID,
      // onLtmInvalidated: clear the LTM session cache
      () => ltmSessionCache.clear(),
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
    };
    sessions.set(sessionID, state);
  }
  state.lastRequestTime = Date.now();

  // Lazy cleanup: discard expired pending recall on access
  if (state.pendingRecall && !isPendingRecallValid(state.pendingRecall)) {
    log.warn(
      `lazy cleanup: discarding expired pending recall for session ${sessionID.slice(0, 16)}`,
    );
    state.pendingRecall = undefined;
  }

  return state;
}

/**
 * Identify or create a session from the incoming request messages.
 *
 * Uses a fingerprint of the first user message combined with
 * message-count proximity to correlate requests to sessions.
 * Forked sessions (which share the same first message) are
 * disambiguated by a significant drop in message count.
 */
async function identifySession(
  req: GatewayRequest,
  _projectPath: string,
): Promise<{ sessionID: string; isNew: boolean }> {
  const rawMessages = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const cred = extractAuth(req.rawHeaders);
  const fingerprint = await fingerprintMessages(rawMessages, {
    model: req.model,
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
    return { sessionID: bestMatch.sid, isNew: false };
  }

  // No matching session → create new
  const sessionID = generateSessionID();
  return { sessionID, isNew: true };
}

// ---------------------------------------------------------------------------
// Upstream forwarding
// ---------------------------------------------------------------------------

/**
 * Forward a request to the upstream provider (Anthropic or OpenAI).
 *
 * When an interceptor is provided (or a module-level one is active), the
 * interceptor is called instead of `fetch` directly.  This enables recording
 * and replay without modifying individual call sites.
 *
 * Returns the raw fetch Response (may be streaming or non-streaming).
 */
async function forwardToUpstream(
  req: GatewayRequest,
  config: GatewayConfig,
  interceptor?: UpstreamInterceptor,
  cache?: AnthropicCacheOptions,
): Promise<Response> {
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

  const effectiveInterceptor = interceptor ?? activeInterceptor;

  if (effectiveInterceptor) {
    return effectiveInterceptor(
      body,
      req.model,
      req.stream,
      () =>
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
    );
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
    ? createRecallAwareAccumulator(RECALL_TOOL_NAME)
    : null;
  const accumulator: StreamAccumulator = recallAccum ?? createStreamAccumulator();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Parse and forward upstream SSE events
        const reader = upstreamResponse.body!.getReader();
        for await (const { event, data } of parseSSEStream(reader)) {
          const forwarded = accumulator.processEvent(event, data);
          if (forwarded) {
            controller.enqueue(encoder.encode(forwarded));
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

            if (recallAccum.hasOtherTools()) {
              // Case 2: mixed tools — store pending, forward held-back events
              const position = resp.content.indexOf(recallBlock);
              recallContext.sessionState.pendingRecall = {
                toolUseId: recallBlock.id,
                input,
                position,
                result,
                timestamp: Date.now(),
              };
              log.info(
                `recall (stream, mixed): stored pending result for session ` +
                  `${recallContext.sessionState.sessionID.slice(0, 16)}`,
              );

              // Emit a synthetic "[Searching memory...]" text block after all
              // other tool blocks. The accumulator already re-indexed other
              // tools to fill the gap, so this goes at clientBlockCount.
              const searchingIdx = recallAccum.clientBlockCount();
              const syntheticCase2 = [
                formatSSEEvent("content_block_start", JSON.stringify({
                  type: "content_block_start",
                  index: searchingIdx,
                  content_block: { type: "text", text: "" },
                })),
                formatSSEEvent("content_block_delta", JSON.stringify({
                  type: "content_block_delta",
                  index: searchingIdx,
                  delta: { type: "text_delta", text: "\n\n[Searching memory...]" },
                })),
                formatSSEEvent("content_block_stop", JSON.stringify({
                  type: "content_block_stop",
                  index: searchingIdx,
                })),
              ].join("");
              controller.enqueue(encoder.encode(syntheticCase2));

              // Forward the held-back message_delta + message_stop
              const heldBack = recallAccum.heldBackEvents();
              if (heldBack) {
                controller.enqueue(encoder.encode(heldBack));
              }

              controller.close();

              // Post-stream: use stripped response for temporal storage
              const cleanResp = stripRecallFromResponse(resp);
              onComplete(cleanResp);
              return;
            }

            // Case 1: recall-only — send follow-up, pipe continuation
            log.info(
              `recall (stream, only): executing follow-up for session ` +
                `${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            // Emit a synthetic "[Searching memory...]" text block at the
            // suppressed recall index so the client sees a natural indicator
            // during the pause while the recall executes.
            const searchingIndex = recallAccum.clientBlockCount();
            const syntheticBlock = [
              formatSSEEvent("content_block_start", JSON.stringify({
                type: "content_block_start",
                index: searchingIndex,
                content_block: { type: "text", text: "" },
              })),
              formatSSEEvent("content_block_delta", JSON.stringify({
                type: "content_block_delta",
                index: searchingIndex,
                delta: { type: "text_delta", text: "\n\n[Searching memory...]" },
              })),
              formatSSEEvent("content_block_stop", JSON.stringify({
                type: "content_block_stop",
                index: searchingIndex,
              })),
            ].join("");
            controller.enqueue(encoder.encode(syntheticBlock));

            const followUp = buildRecallFollowUp(
              recallContext.modifiedReq,
              resp,
              result,
              recallBlock,
            );
            const followUpResponse = await forwardToUpstream(
              followUp,
              recallContext.config,
              undefined,
              recallContext.cacheOptions,
            );

            if (!followUpResponse.ok) {
              const errorBody = await followUpResponse.text();
              log.error(
                `recall follow-up upstream error: ${followUpResponse.status} ${errorBody.slice(0, 500)}`,
              );
              // Forward the held-back events to close the stream gracefully
              const heldBack = recallAccum.heldBackEvents();
              if (heldBack) {
                controller.enqueue(encoder.encode(heldBack));
              }
              controller.close();
              const cleanResp = stripRecallFromResponse(resp);
              onComplete(cleanResp);
              return;
            }

            // Pipe the continuation stream into the same HTTP response.
            // Suppress message_start (client already has one) and re-index
            // content blocks to continue from where the client left off.
            // +1 accounts for the synthetic "[Searching memory...]" block.
            // Use clientBlockCount (not recallBlockIndex) — this is the number
            // of blocks the client has already seen, so continuation blocks
            // start at clientBlockCount + 1 (for the synthetic block).
            const blockOffset = recallAccum.clientBlockCount() + 1;
            const contReader = followUpResponse.body!.getReader();

            for await (const { event: contEvent, data: contData } of parseSSEStream(contReader)) {
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
                    controller.enqueue(encoder.encode(adjusted));
                    continue;
                  }
                } catch {
                  // Fall through to forward as-is
                }
              }

              // Forward message_delta, message_stop, and other events as-is
              const forwarded = formatSSEEvent(contEvent, contData);
              controller.enqueue(encoder.encode(forwarded));
            }

            controller.close();

            // Post-stream: accumulate the continuation for temporal storage.
            // We use resp (original) + continuation for a complete picture,
            // but for simplicity just store the continuation response since
            // it's what the model actually produced for the client.
            // The continuation accumulator was not wired — use the original
            // response's pre-recall content + continuation's content.
            // For now, call onComplete with the original response so at least
            // the pre-recall content is stored. The continuation's text is
            // visible to the client but not separately stored — acceptable
            // since temporal storage captures the full conversation on next turn.
            onComplete(resp);
            return;
          }
        }

        // No recall — normal path
        controller.close();
        const response = accumulator.getResponse();
        onComplete(response);
      } catch (err) {
        log.error("streaming pipeline error:", err);
        controller.error(err);
      }
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
 */
function nonStreamHttpResponse(resp: GatewayResponse): Response {
  const body = buildAnthropicNonStreamResponse(resp);
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
  if (needsUrgentDistillation()) {
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

  // Curation: run periodically when the knowledge system is enabled
  if (
    cfg.knowledge.enabled &&
    cfg.curator.onIdle &&
    sessionState.turnsSinceCuration >= cfg.curator.afterTurns
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
  const upstreamResponse = await forwardToUpstream(req, config);

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
  const { sessionID, isNew } = await identifySession(req, projectPath);
  const sessionState = getOrCreateSession(sessionID, projectPath);

  // Bind auth credential to this session for background workers
  if (cred) {
    setSessionAuth(sessionID, cred);
  }

  // Track fingerprint for future correlation
  if (isNew) {
    const fingerprint = await fingerprintMessages(
      req.messages.map((m) => ({ role: m.role, content: m.content })),
      {
        model: req.model,
        authSuffix: cred ? authFingerprint(cred) : "",
      },
    );
    sessionState.fingerprint = fingerprint;
  }

  // Always update message count for proximity matching
  sessionState.messageCount = req.messages.length;

  // Track session model for worker model discovery
  lastSeenSessionModel = req.model;

  // --- Inject pending recall from previous turn (Case 2: mixed tools) ---
  if (sessionState.pendingRecall) {
    if (isPendingRecallValid(sessionState.pendingRecall)) {
      const injected = injectPendingRecall(req, sessionState.pendingRecall);
      if (injected) {
        log.info(
          `injected pending recall result into request for session ${sessionID.slice(0, 16)}`,
        );
      } else {
        log.warn(
          `failed to inject pending recall — conversation structure mismatch`,
        );
      }
    } else {
      log.warn(
        `discarding expired pending recall for session ${sessionID.slice(0, 16)}`,
      );
    }
    sessionState.pendingRecall = undefined;
  }

  log.info(
    `turn: session=${sessionID.slice(0, 16)} messages=${req.messages.length} ` +
      `model=${req.model} stream=${req.stream} new=${isNew}`,
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

  // --- 5. Cold-cache idle-resume ---
  const thresholdMs = cfg.idleResumeMinutes * 60_000;
  const idleResult = onIdleResume(sessionID, thresholdMs);
  if (idleResult.triggered) {
    ltmSessionCache.delete(sessionID);
    log.info(
      `session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches`,
    );
  }

  // --- 6. LTM injection into system prompt ---
  let modifiedSystem = req.system;
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
        setLtmTokens(cached.tokenCount, sessionID);
        modifiedSystem = `${req.system}\n\n${cached.formatted}`;
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

  // First-run greeting
  if (isFirstRun()) {
    modifiedSystem +=
      "\n\n[Lore plugin] This is the first time Lore has been activated. " +
      "Briefly let the user know that Lore is now active and their " +
      "coding agent will get progressively smarter on this codebase " +
      "over time as knowledge accumulates across sessions.";
  }

  // Lore knowledge file commit reminder
  if (cfg.knowledge.enabled) {
    const filesToTrack = [".lore.md"];
    if (cfg.agentsFile.enabled) filesToTrack.push(cfg.agentsFile.path);
    modifiedSystem +=
      `\n\nWhen making git commits, always check if ${filesToTrack.join(" and ")} ` +
      `have unstaged changes and include them in the commit. These files contain ` +
      `shared project knowledge managed by lore and must be version-controlled.`;
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
    system: modifiedSystem,
    messages: transformedMessages,
  };

  // --- 8b. Inject recall tool ---
  // Only inject if the client doesn't already have a recall tool (e.g. from
  // a host plugin like OpenCode) and the request has other tools (so it's a
  // coding agent, not a bare chat).
  if (modifiedReq.tools.length > 0 && !clientHasRecallTool(modifiedReq.tools)) {
    modifiedReq.tools = [...modifiedReq.tools, RECALL_GATEWAY_TOOL];
  }

  // --- 9. Forward to upstream ---
  // Enable prompt caching for conversation turns:
  //  - System prompt: explicit breakpoint with 5m TTL (frequent turns)
  //  - Conversation: breakpoint on last block so Anthropic caches the prefix
  // Title/summary passthrough (handlePassthrough) never reaches here — it
  // forwards the raw request without buildAnthropicRequest, so no caching.
  const cacheOptions: AnthropicCacheOptions = {
    systemTTL: "5m",
    cacheConversation: true,
  };
  const upstreamResponse = await forwardToUpstream(
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
      (resp) => postResponse(req, resp, sessionState, config),
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

    if (hasOtherToolUse(resp)) {
      // Case 2: recall + other tools — store pending, strip recall from response
      const position = resp.content.indexOf(recallBlock);
      sessionState.pendingRecall = {
        toolUseId: recallBlock.id,
        input,
        position,
        result,
        timestamp: Date.now(),
      };
      log.info(
        `recall (non-stream, mixed): stored pending result for session ${sessionState.sessionID.slice(0, 16)}`,
      );
      const cleanResp = stripRecallFromResponse(resp);
      postResponse(req, cleanResp, sessionState, config);
      return nonStreamHttpResponse(cleanResp);
    }

    // Case 1: recall-only — send follow-up request
    log.info(
      `recall (non-stream, only): executing follow-up for session ${sessionState.sessionID.slice(0, 16)}`,
    );
    const followUp = buildRecallFollowUp(modifiedReq, resp, result, recallBlock);
    // Strip recall from the follow-up tools (already done by buildRecallFollowUp)
    const followUpResponse = await forwardToUpstream(
      followUp,
      config,
      undefined,
      cacheOptions,
    );

    if (!followUpResponse.ok) {
      const errorBody = await followUpResponse.text();
      log.error(
        `recall follow-up upstream error: ${followUpResponse.status} ${errorBody.slice(0, 500)}`,
      );
      // Fall back to the original response without recall
      const cleanResp = stripRecallFromResponse(resp);
      postResponse(req, cleanResp, sessionState, config);
      return nonStreamHttpResponse(cleanResp);
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

    postResponse(req, continuationResp, sessionState, config);
    return nonStreamHttpResponse(continuationResp);
  }

  postResponse(req, resp, sessionState, config);
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

    // --- Case 1: Compaction request → intercept ---
    if (isCompactionRequest(req)) {
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
