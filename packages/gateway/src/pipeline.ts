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
 *  2. Meta requests (title gen, summaries, etc.) → forwarded transparently, no Lore processing.
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
  getPreferenceLtmBudget,
  setMaxLayer0Tokens,
  computeLayer0Cap,
  setCachePricing,
  recordCacheUsage,
  calibrate,
  getLastTransformedCount,
  getLastLayer,
  onIdleResume,
  consumeCameOutOfIdle,
  needsUrgentDistillation,
  getConsecutiveBusts,
  effectiveMetaThreshold as computeMetaThreshold,
  formatKnowledge,
  buildCompactPrompt,
  shouldImportLoreFile,
  importLoreFile,
  loreFileExists,
  shouldImport,
  importFromFile,
  LORE_FILE,
  latReader,
  embedding,
  saveSessionTracking,
  loadSessionTracking,
  loadHeaderSessionIndex,
  isHostedMode,
  enableHostedMode,
} from "@loreai/core";

import type {
  GatewayRequest,
  GatewayResponse,
  GatewayMessage,
  GatewayContentBlock,
  GatewayToolUseBlock,
  GatewayToolResultBlock,
  SessionState,
} from "./translate/types";
import type { GatewayConfig } from "./config";
import { getProjectPath, extractGitRemoteHeader, resolveUpstreamRoute, extractUpstreamUrlHeader, type ProjectPathResult } from "./config";
import {
  generateSessionID,
  fingerprintMessages,
  MESSAGE_COUNT_PROXIMITY_THRESHOLD,
  extractKnownSessionHeader,
  learnHeaders,
} from "./session";
import {
  isCompactionRequest,
  detectCompactionRequest,
  isStructuralCompaction,
  isMetaRequest,
  LORE_AGENT_HEADER,
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
  buildOpenAIResponsesUpstreamRequest,
} from "./translate/openai-responses";
import {
  accumulateResponsesSSEStream,
} from "./stream/openai-responses";
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
import { runBackground, resetBackgroundLimiter } from "./background-limiter";
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
import { captureBillingPrefix, hasBillingHeader, resignBody } from "./cch";
import { detectClientType } from "./session";
import { analyzeCacheTurn, categorizeBust } from "./cache-analytics";
import {
  recordGap,
  getSessionHistogram,
  recordGlobalGap,
  resolveProfile as resolveWarmingProfile,
} from "./cache-warmer";
import {
   setSentryRequestContext,
   setSentryCacheContext,
   setSentryLightContext,
   setGenAiUsageAttributes,
   setCacheAnalyticsAttributes,
     emitCostMetric,
     emitCacheBustMetric,
     emitWarmupHitMetric,
     emitCurationMetrics,
     type AnthropicUsage,
} from "./sentry";
import {
  recordConversationCost,
  updateShadowContext,
  recordWarmupHit,
  recordTTLSavings,
} from "./cost-tracker";
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
  isRecallMarker,
} from "./recall";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** One-time initialization flag. */
let initialized = false;

// --- Context warning marker for unsustainable conversations ---
// Injected into the response (assistant message) so the user can see it.
// Stripped from incoming requests on subsequent turns to preserve cache prefix.
const CONTEXT_WARNING_MARKER = "[lore:context-warning]";
const CONTEXT_WARNING_TEXT =
  `${CONTEXT_WARNING_MARKER} This conversation is growing unsustainably \u2014 ` +
  `it has exceeded the context limit 5+ times in a row and compression cannot keep up. ` +
  `Consider running /compact or starting a new conversation.\n\n---\n\n`;

/** Insert the context warning text block into a response, after any leading thinking blocks. */
function injectContextWarning(resp: GatewayResponse): GatewayResponse {
  // Insert after thinking blocks to preserve the expected block ordering
  // (thinking first, then text). Clients may inspect the first block's type
  // to determine if extended thinking is active.
  let insertIdx = 0;
  while (insertIdx < resp.content.length && resp.content[insertIdx].type === "thinking") {
    insertIdx++;
  }
  const content = [...resp.content];
  content.splice(insertIdx, 0, { type: "text" as const, text: CONTEXT_WARNING_TEXT });
  return { ...resp, content };
}

/**
 * Strip context warning markers from assistant messages in an incoming request.
 * Restores the message content to what the API originally generated, preserving
 * the prompt cache prefix.
 *
 * Only checks the first non-thinking content block of each assistant message —
 * that's where injectContextWarning() inserts it. This avoids false positives
 * if the model happens to echo the marker in its own output.
 */
function stripContextWarnings(messages: GatewayMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    // Find the first non-thinking block (mirrors injectContextWarning insertion point)
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block.type === "thinking") continue;
      if (block.type === "text" && block.text.startsWith(CONTEXT_WARNING_MARKER)) {
        msg.content.splice(i, 1);
      }
      break; // only check the first non-thinking block
    }
  }
}

/**
 * Detect whether a request contains a completed `git commit` tool invocation.
 * Checks tool_use inputs (command string) on assistant messages and tool_result
 * output on user messages for commit indicators. Used to trigger curation at
 * commit boundaries — natural checkpoints where decisions crystallize.
 */
const GIT_COMMIT_RE = /\bgit\s+commit\b/i;
function containsGitCommit(req: GatewayRequest): boolean {
  for (const msg of req.messages) {
    for (const block of msg.content) {
      // Check assistant tool_use inputs for the command string
      if (block.type === "tool_use") {
        const input = block.input;
        if (typeof input === "object" && input !== null) {
          const cmd = (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).content ?? "";
          if (typeof cmd === "string" && GIT_COMMIT_RE.test(cmd)) return true;
        }
      }
      // Check user tool_result content for git commit output patterns
      if (block.type === "tool_result") {
        const text = block.content;
        // Match common git commit output (e.g., "[main abc1234] commit message")
        if (text && /^\[[\w/.-]+ [0-9a-f]+\]/.test(text.trim())) return true;
      }
    }
  }
  return false;
}

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
 * session state or initialization flags across test suites.
 */
export async function resetPipelineState(): Promise<void> {
  initialized = false;
  sessions.clear();
  headerSessionIndex.clear();
  ltmSessionCache.clear();
  ltmPinnedText.clear();
  stableLtmCache.clear();
  // Shut down batch queue gracefully before clearing the client
  if (llmClient && "shutdown" in llmClient) {
    await (llmClient as LLMClient & { shutdown: () => Promise<void> }).shutdown();
  }
  llmClient = null;
  activeInterceptor = undefined;
  if (stopFileWatcher) {
    stopFileWatcher();
    stopFileWatcher = null;
  }
  if (stopIdleScheduler) {
    stopIdleScheduler();
    stopIdleScheduler = null;
  }
  lastSeenSessionModel = null;
  resetWorkerModelState();
  resetBackgroundLimiter();
}

/** Per-session state tracked across requests. */
const sessions = new Map<string, SessionState>();

/** Read-only access to live session states (for dashboard rendering). */
export function getActiveSessions(): ReadonlyMap<string, SessionState> {
  return sessions;
}

/**
 * Reverse lookup: maps header-based session ID values to internal session IDs.
 * Key: `headerName:headerValue` (e.g. `x-claude-code-session-id:uuid-1234`).
 * Value: internal session ID (the key in `sessions`).
 *
 * Populated for both Tier 1 (known headers) and Tier 2 (learned headers).
 */
const headerSessionIndex = new Map<string, string>();

/**
 * Per-session LTM cache for byte-stability of **context-bound** entries
 * (gotchas, patterns, architecture — everything except preferences).
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
 * Pinned context-bound LTM text per session — the text currently being
 * injected as system[2]. When ltmSessionCache is invalidated and
 * recomputed, we compare the new text against the pin. Only update if
 * >5% character difference to avoid cache busts from minor re-ranking.
 */
const ltmPinnedText = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/**
 * Stable LTM (preference entries) per session — injected as system[1]
 * with a 1h cache breakpoint. Computed once per session and pinned for ≥1h
 * even through curation changes, so the Anthropic prompt cache prefix
 * (system[0] host prompt + system[1] stable LTM) stays warm across turns
 * and sessions.
 *
 * Only rebuilt on new session start (cache miss). NOT invalidated by
 * curation, idle resume, or Layer 4 emergency — the stale preferences
 * are kept to preserve the 1h cache investment. On process restart the
 * cache is recomputed (cheap, preferences are small).
 */
const stableLtmCache = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/**
 * Measure character-level difference between two strings as a ratio (0..1).
 * Samples characters at regular intervals across the full string length to
 * detect interior changes, not just prefix/suffix differences.
 *
 * For short strings (≤1000 chars) compares every character. For longer
 * strings samples up to 1000 evenly-spaced positions for O(1) cost.
 */
function textDiffRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;

  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);

  // Length difference accounts for part of the diff
  const lengthDiff = maxLen - minLen;

  // Sample up to 1000 positions across the overlapping region
  const sampleCount = Math.min(minLen, 1000);
  const step = sampleCount < minLen ? minLen / sampleCount : 1;
  let mismatches = 0;
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.floor(i * step);
    if (a[idx] !== b[idx]) mismatches++;
  }

  // Extrapolate mismatch rate to the full overlapping region + length diff
  const mismatchRate = sampleCount > 0 ? mismatches / sampleCount : 0;
  const estimatedMismatches = mismatchRate * minLen + lengthDiff;
  return Math.min(1, estimatedMismatches / maxLen);
}

/**
 * Cost-aware diff threshold for LTM diff-pinning. More expensive models
 * tolerate larger diffs before busting the cache prefix, since each bust
 * costs more. Used by both step-6 (normal turn) and step-7b (Layer 4
 * refresh) to keep the threshold in sync.
 */
function ltmDiffThreshold(inputCostPerMillion?: number): number {
  const base = 0.05;
  const cost = inputCostPerMillion ?? 3;
  if (cost >= 5) return Math.min(base * 3, 0.20);   // opus: 15%
  if (cost >= 1) return Math.min(base * 2, 0.15);   // sonnet: 10%
  return base;                                        // haiku: 5%
}

/** Cached LLM client for background workers. */
let llmClient: LLMClient | null = null;
/** Whether the batch queue wrapper is active (set once in getLLMClient). */
let batchQueueEnabled = false;

/** Cleanup function for the idle scheduler timer. */
let stopIdleScheduler: (() => void) | null = null;

/** Cleanup function for the .lore.md / agents-file watcher. */
let stopFileWatcher: (() => void) | null = null;

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
// Dynamic max_tokens sizing for non-Claude-Code clients
// ---------------------------------------------------------------------------

const MAX_TOKENS_FLOOR = 8192;
const MAX_TOKENS_BUFFER = 1000;
const MAX_TOKENS_EMA_MULTIPLIER = 3;

/**
 * Compute a right-sized `max_tokens` value for a conversation turn using
 * a hybrid headroom + history approach.
 *
 * - Turn 1 (no history): returns `ceiling` (32K) — matches Claude Code.
 * - Turns 2+: 3× output EMA, clamped by context headroom and ceiling.
 * - After truncation (`stop_reason: "length"`): jumps back to ceiling.
 *
 * Exported for testing.
 */
export function computeMaxTokens(
  modelOutput: number,
  modelContext: number,
  outputEMA: number | undefined,
  lastStopReason: string | undefined,
  lastInputTokens: number | undefined,
): number {
  const ceiling = Math.min(modelOutput, 32_000);

  // Turn 1: no history — use ceiling (matches Claude Code default)
  if (outputEMA == null) return ceiling;

  // Headroom: how much output the context can afford given last known input
  const estimatedInput = lastInputTokens ?? 0;
  const headroom = Math.max(
    MAX_TOKENS_FLOOR,
    modelContext - estimatedInput - MAX_TOKENS_BUFFER,
  );

  // History: 3× recent output EMA — generous multiplier to absorb spikes
  let adaptive = Math.max(MAX_TOKENS_FLOOR, MAX_TOKENS_EMA_MULTIPLIER * outputEMA);

  // Safety: if last turn was truncated, jump to ceiling
  if (lastStopReason === "length") {
    adaptive = ceiling;
  }

  // Clamp: history within headroom, within ceiling
  return Math.min(headroom, Math.max(adaptive, MAX_TOKENS_FLOOR), ceiling);
}

// ---------------------------------------------------------------------------
// Knowledge file import — shared by startup + file watcher + new-session check
// ---------------------------------------------------------------------------

/**
 * Attempt to import knowledge from `.lore.md` (preferred) or the agents file
 * (AGENTS.md/CLAUDE.md, backward compat).  Safe to call frequently — the
 * underlying `shouldImportLoreFile()` / `shouldImport()` do mtime + content-hash
 * checks and short-circuit when nothing changed.
 *
 * Returns true if entries were actually imported.
 */
function tryImportKnowledge(projectPath: string): boolean {
  if (isHostedMode()) return false;
  const cfg = loreConfig();
  if (!cfg.knowledge.enabled) return false;

  try {
    if (loreFileExists(projectPath)) {
      if (shouldImportLoreFile(projectPath)) {
        importLoreFile(projectPath);
        log.info("imported knowledge from .lore.md");
        return true;
      }
    } else if (cfg.agentsFile.enabled) {
      const { join } = require("node:path") as typeof import("node:path");
      const filePath = join(projectPath, cfg.agentsFile.path);
      if (shouldImport({ projectPath, filePath })) {
        importFromFile({ projectPath, filePath });
        log.info("imported knowledge from", cfg.agentsFile.path);
        return true;
      }
    }
  } catch (e) {
    log.error("knowledge import error:", e);
  }

  return false;
}

// ---------------------------------------------------------------------------
// File watcher for .lore.md / agents file — picks up external edits live
// ---------------------------------------------------------------------------

/**
 * Start watching `.lore.md` (and the agents file as fallback) for changes.
 * Uses `fs.watch()` with a debounce to avoid rapid-fire triggers from
 * editors that do atomic write-rename sequences.
 *
 * Safe against import-after-export loops: `shouldImportLoreFile()` compares
 * the file content hash against what the DB would produce, so our own
 * exports are recognized as no-ops.
 */
function startKnowledgeFileWatcher(projectPath: string): () => void {
  // In hosted mode, never watch client-controlled paths.
  if (isHostedMode()) return () => {};

  const { join } = require("node:path") as typeof import("node:path");
  const { watch, existsSync } = require("node:fs") as typeof import("node:fs");

  const watchers: import("node:fs").FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 500;

  const onFileChange = () => {
    // Debounce: editors often write-rename-delete in rapid succession.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      tryImportKnowledge(projectPath);
    }, DEBOUNCE_MS);
  };

  // Watch .lore.md
  const loreFilePath = join(projectPath, LORE_FILE);
  if (existsSync(loreFilePath)) {
    try {
      const w = watch(loreFilePath, onFileChange);
      w.on("error", () => {}); // suppress — file may be deleted
      watchers.push(w);
    } catch {
      // watch not supported (rare) — fall back to session-start checks only
    }
  }

  // Watch agents file (AGENTS.md etc.) as fallback
  const cfg = loreConfig();
  if (cfg.agentsFile.enabled) {
    const agentsFilePath = join(projectPath, cfg.agentsFile.path);
    if (existsSync(agentsFilePath)) {
      try {
        const w = watch(agentsFilePath, onFileChange);
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        // watch not supported
      }
    }
  }

  if (watchers.length > 0) {
    log.info(`watching ${watchers.length} knowledge file(s) for changes`);
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * One-time init: load Lore config, ensure project exists in DB, start idle scheduler.
 * Safe to call multiple times — only the first call does work.
 */
async function initIfNeeded(projectPath: string, config: GatewayConfig, gitRemote?: string): Promise<void> {
  if (initialized) return;

  // Enable hosted mode before any FS operations — once set, all core
  // functions that touch client-controlled paths become safe no-ops.
  if (config.hostedMode) {
    enableHostedMode();
  }

  await load(projectPath);
  ensureProject(projectPath, undefined, gitRemote);
  initialized = true;

  // Import knowledge from .lore.md at startup (picks up user/git edits
  // since last session). Falls back to agents file for backward compat.
  const cfg = loreConfig();
  if (cfg.knowledge.enabled) {
    tryImportKnowledge(projectPath);

    // Prune corrupted/oversized knowledge entries (safety net for past bugs).
    const pruned = ltm.pruneOversized(1200);
    if (pruned > 0) {
      log.info(`pruned ${pruned} oversized knowledge entries (confidence set to 0)`);
    }

    // Watch knowledge files for live changes (git pull, manual edits, etc.)
    if (!stopFileWatcher) {
      stopFileWatcher = startKnowledgeFileWatcher(projectPath);
    }
  }

  // Startup backfills — idempotent, run once per process.
  try {
    distillation.backfillMetrics();
  } catch (e) {
    log.info("metric backfill failed:", e);
  }
  embedding.runStartupBackfill().catch((e) => {
    log.error("embedding backfill failed:", e);
  });

  // Index lat.md/ directory sections (content-hash-based, skips unchanged files).
  try {
    latReader.refresh(projectPath);
  } catch (e) {
    log.error("lat-reader startup refresh error:", e);
  }

  // Pre-populate headerSessionIndex from DB so Tier 1 session identification
  // works immediately after process restart. Without this, the first request
  // with a known session header generates a new session ID and orphans the
  // old session's persisted state.
  try {
    const headerEntries = loadHeaderSessionIndex();
    for (const entry of headerEntries) {
      const indexKey = `${entry.headerName}:${entry.headerSessionId}`;
      headerSessionIndex.set(indexKey, entry.sessionId);
    }
    if (headerEntries.length > 0) {
      log.info(`restored ${headerEntries.length} header→session mappings from DB`);
    }
  } catch (e) {
    log.warn("header session index restore failed:", e);
  }

  // Pre-warm models.dev pricing/limits cache so synchronous lookups in the
  // request hot path (getModelSpec, emitCostMetric) resolve from memory.
  fetchModelData().catch((e) => log.warn("models.dev pre-warm failed:", e));

  // Start the idle scheduler for background work (distillation, curation,
  // pruning, AGENTS.md export). Uses a 30s poll interval and fires for any
  // session whose lastRequestTime exceeds the idle timeout.
  if (config && !stopIdleScheduler) {
    const llm = getLLMClient(config);
    const idleHandler = buildIdleWorkHandler(llm);
    stopIdleScheduler = startIdleScheduler(config, sessions, idleHandler);
  }

  log.info(`gateway pipeline initialized: ${projectPath}`);
}

function getLLMClient(config: GatewayConfig): LLMClient {
  if (!llmClient) {
    const cfg = loreConfig();
    const defaultModel = cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    };
    const inner = createGatewayLLMClient(
      { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
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
      batchQueueEnabled = false;
    } else {
      llmClient = createBatchLLMClient(
        inner,
        { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
        resolveAuth,
        defaultModel,
      );
      batchQueueEnabled = true;
    }
  }
  return llmClient;
}

// ---------------------------------------------------------------------------
// Project path resolution with session cache
// ---------------------------------------------------------------------------

/**
 * Upgrade a project path result using the session's cached path.
 *
 * Some requests (e.g. Claude Code's non-streaming prompt-caching probes)
 * have stripped-down system prompts that lack path references, causing
 * `getProjectPath()` to fall back to `process.cwd()`. When the session
 * already has a known-good path from a prior turn, we use that instead.
 *
 * Also updates the session cache when a fresh inference or header provides
 * a new path, so future path-less turns benefit.
 *
 * Returns the final resolved project path.
 */
export function resolveSessionProjectPath(
  result: ProjectPathResult,
  sessionState: SessionState,
): string {
  let { path: projectPath, source } = result;

  // Cache git remote on the session so subsequent turns benefit even if
  // the header is absent (e.g. prompt-cache probes or follow-up requests).
  // Also backfill ensureProject() — initIfNeeded is one-shot, so if the
  // first request lacked the header, the project row has no git_remote.
  // Calling ensureProject() again is safe: it's idempotent and will
  // backfill git_remote on the existing row if missing.
  if (result.gitRemote && !sessionState.gitRemote) {
    sessionState.gitRemote = result.gitRemote;
    ensureProject(projectPath, undefined, result.gitRemote);
  }

  // Upgrade from cwd fallback using session's cached path
  if (source === "cwd" && sessionState.projectPath !== projectPath) {
    projectPath = sessionState.projectPath;
    source = "cached" as typeof source;
  }

  // Update session cache when a fresh path was resolved so future
  // path-less turns benefit from the cached value.
  if (source === "inferred" || source === "header") {
    sessionState.projectPath = projectPath;
  }

  // Log warning only when the cwd fallback truly sticks (no session cache
  // was available to upgrade from).
  if (source === "cwd") {
    console.error(
      `[lore] warning: project path falling back to process.cwd() (${projectPath}). ` +
      `Data may be misattributed. Set X-Lore-Project header or include a working ` +
      `directory in the system prompt to fix this.`,
    );
  }

  return projectPath;
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
    // Restore persisted tracking state from DB (survives process restarts)
    const persisted = loadSessionTracking(sessionID);
    state = {
      sessionID,
      projectPath,
      fingerprint: persisted?.fingerprint || "",
      lastRequestTime: Date.now(),
      lastUserTurnTime: 0,
      messageCount: persisted?.messageCount ?? 0,
      turnsSinceCuration: persisted?.turnsSinceCuration ?? 0,
      consecutiveTextOnlyTurns: persisted?.consecutiveTextOnlyTurns ?? 0,
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

    // Restore session identity (v24) — prevents Tier 3 fallback on restart
    if (persisted?.headerSessionId && persisted.headerName) {
      state.headerSessionId = persisted.headerSessionId;
      state.headerName = persisted.headerName;
      // Rebuild headerSessionIndex for this session
      const indexKey = `${persisted.headerName}:${persisted.headerSessionId}`;
      headerSessionIndex.set(indexKey, sessionID);
    }

    // Restore cache warming state (v24) — preserves earned TTL tier
    if (persisted?.resolvedConversationTTL) {
      const ttl = persisted.resolvedConversationTTL;
      state.resolvedConversationTTL = (ttl === "5m" || ttl === "1h") ? ttl : "5m";
    }
    if (persisted?.warmupState) {
      try {
        state.warmup = JSON.parse(persisted.warmupState);
      } catch {
        log.warn(`corrupt warmup state for session ${sessionID.slice(0, 16)}, starting fresh`);
      }
    }

    // Restore sub-agent parent–child relationship (v26)
    if (persisted?.isSubagent) {
      state.isSubagent = true;
      if (persisted.parentSessionId) {
        state.parentSessionId = persisted.parentSessionId;
      }
    }

    // Restore LTM cache/pin from DB
    if (persisted?.ltmCacheText != null && persisted.ltmCacheTokens != null) {
      ltmSessionCache.set(sessionID, {
        formatted: persisted.ltmCacheText,
        tokenCount: persisted.ltmCacheTokens,
      });
    }
    if (persisted?.ltmPinText != null && persisted.ltmPinTokens != null) {
      ltmPinnedText.set(sessionID, {
        formatted: persisted.ltmPinText,
        tokenCount: persisted.ltmPinTokens,
      });
    }
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
 *     `x-lore-session-id`. Immediate match, survives compaction & model changes.
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
  // Sub-agent requests (carrying x-parent-session-id) are NOT merged into the
  // parent session. They carry their own x-session-affinity nanoid and get
  // independent sessions, benefiting from the full Lore pipeline (LTM,
  // gradient, distillation) on their own state without corrupting the parent.

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
        // Persist immediately — rare event, critical for post-restart correlation
        saveSessionTracking(bestMatch.sid, {
          headerSessionId: result.promoted.value,
          headerName: result.promoted.name,
        });
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
  /** The wire protocol used for the upstream request (may differ from ingress). */
  effectiveProtocol: "anthropic" | "openai" | "openai-responses";
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
  // Preserve "openai-responses" from ingress — model prefix routing returns
  // "openai" for OpenAI models, but we must not downgrade the wire protocol.
  const route = resolveUpstreamRoute(req.model);
  const effectiveProtocol =
    req.protocol === "openai-responses"
      ? "openai-responses"
      : (route?.protocol ?? req.protocol);
  // Priority chain: model prefix route (known cloud) > header-provided URL
  // (local/custom providers like vllm, ollama) > env-var default (fallback).
  const headerUpstream = extractUpstreamUrlHeader(req.rawHeaders);
  const effectiveUpstreamBase =
    route?.url ??
    headerUpstream ??
    (effectiveProtocol === "anthropic"
      ? config.upstreamAnthropic
      : config.upstreamOpenAI);

  if (effectiveProtocol === "openai-responses") {
    // Inject LTM into system prompt for non-Anthropic paths.
    // Anthropic handles LTM via separate system blocks in buildAnthropicRequest;
    // OpenAI paths receive a single system string, so we concatenate here.
    const ltmParts = [cache?.stableLtmSystem, cache?.ltmSystem].filter(Boolean);
    const reqWithLtm = ltmParts.length
      ? { ...req, system: [req.system, ...ltmParts].filter(Boolean).join("\n\n") }
      : req;
    const result = buildOpenAIResponsesUpstreamRequest(reqWithLtm, effectiveUpstreamBase);
    url = result.url;
    headers = result.headers;
    body = result.body;
  } else if (effectiveProtocol === "openai") {
    // Inject LTM into system prompt (see comment above for openai-responses).
    const ltmParts = [cache?.stableLtmSystem, cache?.ltmSystem].filter(Boolean);
    const reqWithLtm = ltmParts.length
      ? { ...req, system: [req.system, ...ltmParts].filter(Boolean).join("\n\n") }
      : req;
    const result = buildOpenAIUpstreamRequest(reqWithLtm, effectiveUpstreamBase);
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
    return { response, serializedBody, effectiveProtocol };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: serializedBody,
  });
  return { response, serializedBody, effectiveProtocol };
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
  /** When set, prepend a synthetic warning content block to the stream. */
  warningText?: string,
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

        // When a warning needs to be prepended to the response, we emit a
        // synthetic text content block after any leading thinking blocks,
        // then offset all subsequent real content block indices by 1.
        // The accumulator sees the original (un-offset) data so postResponse()
        // gets the clean response — only the client stream has the warning.
        // Thinking blocks are forwarded at their original indices to preserve
        // the expected ordering (clients may inspect the first block's type).
        let warningEmitted = false;
        let inThinking = false;
        let warningBlockIndex = 0; // incremented past thinking blocks
        const warningOffset = warningText ? 1 : 0;

        for await (const { event, data } of parseSSEStream(reader)) {
          const forwarded = accumulator.processEvent(event, data);
          if (forwarded) {
            // --- Warning injection: skip thinking blocks, inject before first text/tool block ---
            if (warningText && !warningEmitted) {
              if (event === "message_start" || event === "ping") {
                // Forward as-is, no action needed
                if (!safeEnqueue(encoder.encode(forwarded))) break;
                continue;
              }

              // Track thinking blocks — forward at original indices, no offset
              if (event === "content_block_start") {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content_block?.type === "thinking") {
                    inThinking = true;
                    warningBlockIndex++;
                    if (!safeEnqueue(encoder.encode(forwarded))) break;
                    continue;
                  }
                } catch { /* fall through to inject */ }
              }
              if (inThinking) {
                if (event === "content_block_stop") inThinking = false;
                if (!safeEnqueue(encoder.encode(forwarded))) break;
                continue;
              }

              // First non-thinking content block — inject warning before it
              const blockStart = JSON.stringify({ type: "content_block_start", index: warningBlockIndex, content_block: { type: "text", text: "" } });
              const blockDelta = JSON.stringify({ type: "content_block_delta", index: warningBlockIndex, delta: { type: "text_delta", text: warningText } });
              const blockStop = JSON.stringify({ type: "content_block_stop", index: warningBlockIndex });
              const warningSSE =
                `event: content_block_start\ndata: ${blockStart}\n\n` +
                `event: content_block_delta\ndata: ${blockDelta}\n\n` +
                `event: content_block_stop\ndata: ${blockStop}\n\n`;
              if (!safeEnqueue(encoder.encode(warningSSE))) break;
              warningEmitted = true;
              // Fall through to offset and forward this event
            }

            // Offset content block indices to account for the injected warning block
            let toSend = forwarded;
            if (warningOffset > 0 && warningEmitted) {
              toSend = forwarded.replace(/^(data: )(.+)$/m, (_, prefix, jsonStr) => {
                try {
                  const obj = JSON.parse(jsonStr);
                  if (typeof obj.index === "number") {
                    obj.index += warningOffset;
                    return prefix + JSON.stringify(obj);
                  }
                } catch { /* not JSON — leave as-is */ }
                return prefix + jsonStr;
              });
            }
            if (!safeEnqueue(encoder.encode(toSend))) break;
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
              getLLMClient(recallContext.config),
            );

            const scope = input.scope ?? "all";

            // Store recall result for marker round-trip expansion
            const storeKey = recallStoreKey(input.query, scope, input.id);
            const position = resp.content.indexOf(recallBlock);
            recallContext.sessionState.recallStore.set(storeKey, {
              toolUseId: recallBlock.id,
              input,
              position,
              result,
            });

            // Emit marker text block in place of the suppressed recall block
            const markerText = buildRecallMarker(input.query, scope, input.id);
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
                // Disable conversation caching on follow-up: the appended
                // tool_result makes the prefix diverge from the next real turn,
                // so the cache write would be wasted money.
                { ...recallContext.cacheOptions, cacheConversation: false },
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
                new Error(`recall follow-up upstream ${followUpResponse.status}`),
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
            const blockOffset = recallAccum.clientBlockCount() + 1 + warningOffset;
            const contReader = followUpResponse.body!.getReader();
            activeReader = contReader;
            let contEventCount = 0;
            // Defense-in-depth: suppress any recall tool_use blocks that
            // leak through in the follow-up (shouldn't happen since recall
            // is stripped from the tools list, but guards against edge cases).
            const contSuppressedIndices = new Set<number>();
            let contSuppressedCount = 0;

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
                  const idx = parsed.index as number;
                  if (typeof idx !== "number") break;

                  // Suppress recall tool_use blocks in continuation
                  if (contEvent === "content_block_start") {
                    const block = parsed.content_block as Record<string, unknown> | undefined;
                    if (block?.type === "tool_use" && block.name === RECALL_TOOL_NAME) {
                      log.warn("recall follow-up stream contained recall tool_use — suppressing");
                      contSuppressedIndices.add(idx);
                      contSuppressedCount++;
                      continue;
                    }
                  }
                  if (contSuppressedIndices.has(idx)) {
                    continue; // Skip delta/stop for suppressed blocks
                  }

                  parsed.index = idx - contSuppressedCount + blockOffset;
                  const adjusted = formatSSEEvent(
                    contEvent,
                    JSON.stringify(parsed),
                  );
                  if (!safeEnqueue(encoder.encode(adjusted))) break;
                  continue;
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
 *
 * Dispatches to the correct parser based on the upstream wire protocol:
 *  - "anthropic": Anthropic Messages API format
 *  - "openai": OpenAI Chat Completions API format
 *  - "openai-responses": OpenAI Responses API format
 */
async function accumulateNonStreamResponse(
  upstreamResponse: Response,
  protocol: "anthropic" | "openai" | "openai-responses" = "anthropic",
): Promise<GatewayResponse> {
  const json = (await upstreamResponse.json()) as Record<string, unknown>;

  switch (protocol) {
    case "openai":
      return accumulateOpenAINonStreamJSON(json);
    case "openai-responses":
      return accumulateResponsesNonStreamJSON(json);
    default:
      return accumulateAnthropicNonStreamJSON(json);
  }
}

function accumulateAnthropicNonStreamJSON(json: Record<string, unknown>): GatewayResponse {
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

function accumulateOpenAINonStreamJSON(json: Record<string, unknown>): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;

  if (message) {
    const textContent = message.content as string | undefined;
    if (textContent) {
      content.push({ type: "text", text: textContent });
    }
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        let input: unknown = {};
        if (typeof fn?.arguments === "string") {
          try { input = JSON.parse(fn.arguments as string); } catch { input = fn.arguments; }
        }
        content.push({
          type: "tool_use",
          id: String(tc.id ?? ""),
          name: String(fn?.name ?? ""),
          input,
        });
      }
    }
  }

  // Map OpenAI finish_reason to gateway stop reason
  const finishReason = firstChoice?.finish_reason as string | undefined;
  let stopReason = "end_turn";
  if (finishReason === "stop") stopReason = "end_turn";
  else if (finishReason === "length") stopReason = "max_tokens";
  else if (finishReason === "tool_calls") stopReason = "tool_use";

  const usage = json.usage as Record<string, unknown> | undefined;
  const promptTokensDetails = usage?.prompt_tokens_details as Record<string, number> | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason,
    usage: {
      inputTokens: (usage?.prompt_tokens as number) ?? 0,
      outputTokens: (usage?.completion_tokens as number) ?? 0,
      cacheReadInputTokens: promptTokensDetails?.cached_tokens,
    },
  };
}

function accumulateResponsesNonStreamJSON(json: Record<string, unknown>): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const output = json.output as Array<Record<string, unknown>> | undefined;

  if (output) {
    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined;
        if (msgContent) {
          for (const part of msgContent) {
            if (part.type === "output_text") {
              content.push({ type: "text", text: String(part.text ?? "") });
            }
          }
        }
      } else if (item.type === "function_call") {
        let input: unknown = {};
        if (typeof item.arguments === "string") {
          try { input = JSON.parse(item.arguments as string); } catch { input = item.arguments; }
        }
        content.push({
          type: "tool_use",
          id: String(item.call_id ?? item.id ?? ""),
          name: String(item.name ?? ""),
          input,
        });
      }
    }
  }

  // Map Responses API status to gateway stop reason
  const status = json.status as string | undefined;
  let stopReason = "end_turn";
  if (status === "incomplete") stopReason = "max_tokens";
  if (content.some(b => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  const usage = json.usage as Record<string, unknown> | undefined;
  const promptTokensDetails = usage?.prompt_tokens_details as Record<string, number> | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason,
    usage: {
      inputTokens: (usage?.input_tokens as number) ?? 0,
      outputTokens: (usage?.output_tokens as number) ?? 0,
      cacheReadInputTokens: promptTokensDetails?.cached_tokens,
    },
  };
}

/**
 * Accumulate a streaming upstream Anthropic SSE response into a GatewayResponse.
 *
 * Used for Anthropic requests where we need to convert the accumulated
 * response to another format before returning to the client.
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
 * Accumulate a streaming upstream OpenAI Chat Completions SSE response
 * into a GatewayResponse.
 *
 * OpenAI SSE chunks have a different format from Anthropic:
 *   data: {"id":"...","choices":[{"delta":{"content":"..."},"finish_reason":null}]}
 */
async function accumulateNonStreamOpenAIStream(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  let id = "";
  let model = "";
  let stopReason = "end_turn";
  let textContent = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;

  const reader = upstreamResponse.body!.getReader();

  for await (const { data } of parseSSEStream(reader)) {
    if (data === "[DONE]") break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const firstChoice = choices?.[0];
    if (firstChoice) {
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string") {
          textContent += delta.content;
        }
        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (tcs) {
          for (const tc of tcs) {
            const idx = tc.index as number;
            const fn = tc.function as Record<string, unknown> | undefined;
            const existing = toolCalls.get(idx);
            if (!existing) {
              toolCalls.set(idx, {
                id: String(tc.id ?? ""),
                name: String(fn?.name ?? ""),
                args: String(fn?.arguments ?? ""),
              });
            } else {
              if (fn?.arguments) existing.args += fn.arguments;
            }
          }
        }
      }
      if (typeof firstChoice.finish_reason === "string") {
        const fr = firstChoice.finish_reason;
        if (fr === "stop") stopReason = "end_turn";
        else if (fr === "length") stopReason = "max_tokens";
        else if (fr === "tool_calls") stopReason = "tool_use";
      }
    }

    // Usage is typically in the final chunk
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens as number;
      if (typeof usage.completion_tokens === "number") outputTokens = usage.completion_tokens as number;
      const details = usage.prompt_tokens_details as Record<string, number> | undefined;
      if (details?.cached_tokens !== undefined) cachedTokens = details.cached_tokens;
    }
  }

  const content: GatewayContentBlock[] = [];
  if (textContent) {
    content.push({ type: "text", text: textContent });
  }
  for (const [, tc] of Array.from(toolCalls.entries()).sort(([a], [b]) => a - b)) {
    let input: unknown = {};
    if (tc.args) {
      try { input = JSON.parse(tc.args); } catch { input = tc.args; }
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    id,
    model,
    content,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cachedTokens,
    },
  };
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
    recordConversationCost(sessionID, resp.model, usageForSentry);
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

    // --- Consecutive bust tracking for tier-based decisions ---
    recordCacheUsage(
      resp.usage.cacheCreationInputTokens ?? 0,
      resp.usage.cacheReadInputTokens ?? 0,
      resp.usage.inputTokens ?? 0,
      sessionState.sessionID,
    );

    // Capture previous stop reason before it's overwritten below (line ~1667).
    // Used to detect tool-use continuation turns for gap recording filtering.
    const prevStopReason = sessionState.lastStopReason;

    // --- Temporal storage & session-state updates ---
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

    // Build and store the assistant response message.
    // Strip recall marker text blocks — they contain the raw query string
    // and pollute FTS results with self-referential noise.
    const assistantContent = resp.content.filter(
      (b) => !(b.type === "text" && isRecallMarker(b.text)),
    );
    if (assistantContent.length > 0) {
      const assistantMsg = gatewayMessagesToLore(
        [{ role: "assistant", content: assistantContent }],
        sessionID,
      )[0];
      updateAssistantMessageTokens(assistantMsg, resp.usage, resp.model);
      temporal.store({
        projectPath,
        info: assistantMsg.info,
        parts: assistantMsg.parts,
      });
    }

    // Update session state (persisted in the batched save after messageCount update)
    sessionState.turnsSinceCuration =
      (sessionState.turnsSinceCuration ?? 0) + 1;

    // --- Track consecutive text-only end_turn responses (session-end heuristic) ---
    const hasToolUse = resp.content.some((b) => b.type === "tool_use");
    if (resp.stopReason === "end_turn" && !hasToolUse) {
      sessionState.consecutiveTextOnlyTurns =
        (sessionState.consecutiveTextOnlyTurns ?? 0) + 1;
    } else {
      sessionState.consecutiveTextOnlyTurns = 0;
    }

    // --- Output tracking for dynamic max_tokens sizing ---
    sessionState.lastStopReason = resp.stopReason;
    sessionState.lastInputTokens =
      (resp.usage.inputTokens ?? 0) +
      (resp.usage.cacheReadInputTokens ?? 0) +
      (resp.usage.cacheCreationInputTokens ?? 0);
    const outputTokens = resp.usage.outputTokens;
    if (outputTokens > 0) {
      const EMA_ALPHA = 0.3;
      sessionState.outputTokensEMA =
        sessionState.outputTokensEMA == null
          ? outputTokens
          : Math.round(
              sessionState.outputTokensEMA * (1 - EMA_ALPHA) +
                outputTokens * EMA_ALPHA,
            );
    }

    // --- Cache warming: record inter-turn gap + track warmup hits ---
    const now = Date.now();

    // (A) Record inter-turn gap — only for genuine user-initiated turns.
    // Tool-use auto-continuations (prior stop_reason was "tool_use") produce
    // sub-second gaps that represent automated round-trips, not human think
    // time. Recording these would skew the survival model toward very short
    // return times.
    const isToolUseContinuation = prevStopReason === "tool_use";
    if (!isToolUseContinuation) {
      if (sessionState.lastUserTurnTime > 0) {
        const gap = now - sessionState.lastUserTurnTime;
        recordGap(getSessionHistogram(sessionState), gap);
        recordGlobalGap(sessionState.projectPath, gap);
      }
      // Update baseline for next gap measurement — only after recording.
      sessionState.lastUserTurnTime = now;
    }

    // (B) Track warmup hits and TTL savings — valid for ALL turn types.
    // A user returning after a warmup is a hit regardless of whether it's
    // a tool-use continuation.
    // NOTE: warmup hits and TTL savings are mutually exclusive — if a turn
    // is attributed to a warmup hit, skip TTL savings to avoid double-counting
    // the same cacheReadTokens in both buckets.
    if (sessionState.lastRequestTime > 0) {
      let warmupHitThisTurn = false;

      // Track warmup hit: user returned after we warmed the cache.
      // A warmup can only benefit the FIRST turn after it fires — clear
      // lastWarmupAt unconditionally so subsequent turns are not attributed.
      if (sessionState.warmup?.lastWarmupAt) {
        const ttlMs = sessionState.resolvedConversationTTL === "1h" ? 3_600_000 : 300_000;
        const sinceWarmup = now - sessionState.warmup.lastWarmupAt;
        sessionState.warmup.lastWarmupAt = 0;
        if (sinceWarmup < ttlMs) {
          warmupHitThisTurn = true;
          sessionState.warmup.warmupHits++;
          emitWarmupHitMetric(
            sessionState.lastModel ?? req.model,
            sessionState.resolvedConversationTTL ?? "5m",
          );
          // Record counterfactual savings: without warming, these cache
          // reads would have been full cache writes.
          const cacheRead = resp.usage.cacheReadInputTokens ?? 0;
          if (cacheRead > 0) {
            recordWarmupHit(
              sessionID,
              req.model,
              cacheRead,
              sessionState.resolvedConversationTTL ?? "5m",
            );
          }
          log.info(
            `cache-warmer: HIT session=${sessionID.slice(0, 16)} ` +
              `user returned ${(sinceWarmup / 1000).toFixed(0)}s after warmup`,
          );
        }
      }

      // Track 1h TTL savings: if gap > 5m but we still got cache reads,
      // the 1h TTL saved a full cache write. Skip if already counted as
      // a warmup hit to avoid double-counting the same tokens.
      if (!warmupHitThisTurn) {
        const requestGap = now - sessionState.lastRequestTime;
        if (requestGap > 300_000) {
          const cacheRead = resp.usage.cacheReadInputTokens ?? 0;
          if (cacheRead > 0) {
            recordTTLSavings(sessionID, req.model, cacheRead);
          }
        }
      }
    }
    // Track model/protocol/beta for warmup profile resolution
    sessionState.lastModel = req.model;
    sessionState.lastProtocol =
      req.protocol === "openai-responses"
        ? "openai-responses"
        : (resolveUpstreamRoute(req.model)?.protocol ?? "anthropic");
    // Capture anthropic-beta so cache-warmer can forward it — beta-gated
    // body fields (e.g. context_management) need the header to be accepted.
    // Always update (including clearing) so a stale header isn't forwarded
    // after the client stops sending it.
    sessionState.lastAnthropicBeta =
      req.rawHeaders["anthropic-beta"] || undefined;

    // Reset warming state if session was marked dead or had active warming.
    // Dead flag is cleared so the next break gets a fresh ROI analysis.
    // warmupCount is reset so the break-even cap starts from 0 on the next break.
    if (sessionState.warmup) {
      if (sessionState.warmup.disabled) {
        sessionState.warmup.disabled = false;
        log.info(
          `cache-warmer: re-enabled session=${sessionID.slice(0, 16)} (user resumed)`,
        );
      }
      if (sessionState.warmup.warmupCount > 0 && !sessionState.warmup.forceKeepWarm) {
        sessionState.warmup.warmupCount = 0;
      }
    }

    // --- Shadow context tracking for counterfactual compaction estimation ---
    // Track how large the context *would* be without Lore's distillation
    // compressing it. When the shadow counter crosses the auto-compact
    // threshold, record a counterfactual compaction event.
    updateShadowContext(sessionID, actualInput, resp.usage.outputTokens ?? 0, getWorkerModel()?.modelID ?? "unknown", req.model);

    // Mark session dirty for periodic flush (gradient + warming + costs).
    // The 30s idle tick will persist state only for dirty sessions.
    sessionState._dirty = true;

    // --- Commit-triggered curation ---
    // Git commits are natural task boundaries where decisions crystallize.
    // When a commit is detected in tool outputs, force curation to trigger
    // on this turn by bumping turnsSinceCuration to the threshold.
    if (loreConfig().knowledge.enabled && loreConfig().curator.onIdle && containsGitCommit(req)) {
      const modelInputCost = getModelEntrySync(
        getWorkerModel()?.modelID ?? "unknown",
      ).cost?.input ?? 3;
      const curationMultiplier = modelInputCost >= 5 ? 3 : modelInputCost >= 1 ? 2 : 1;
      const effectiveAfterTurns = loreConfig().curator.afterTurns * curationMultiplier;
      if (sessionState.turnsSinceCuration < effectiveAfterTurns) {
        log.info(`commit detected in session ${sessionID.slice(0, 16)} — triggering curation`);
        sessionState.turnsSinceCuration = effectiveAfterTurns;
      }
    }

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
  // Under bust pressure (3+ consecutive busts), lower the meta-distillation
  // threshold to consolidate gen-0 segments earlier — shrinks the distilled
  // prefix before the session becomes unsustainable.
  if (needsUrgentDistillation(sessionState.sessionID)) {
    const busts = getConsecutiveBusts(sessionState.sessionID);
    const lowered = computeMetaThreshold(busts, cfg.distillation.metaThreshold);
    const metaThresholdOverride = lowered < cfg.distillation.metaThreshold ? lowered : undefined;
    distillation
      .run({
        llm,
        projectPath,
        sessionID,
        model,
        force: true,
        urgent: true,
        callType: "direct",
        metaThresholdOverride,
      })
      .catch((e) => log.error("background distillation failed:", e));
  } else {
    // Incremental distillation: only when urgent didn't fire (urgent with
    // force:true already processes everything, making incremental redundant).
    // With the core p-limit(1) guard they'd serialize anyway, but this avoids
    // a wasted run() call.
    const pendingTokens = temporal.undistilledTokens(projectPath, sessionID);
    if (pendingTokens >= cfg.distillation.maxSegmentTokens) {
      log.info(
        `incremental distillation: ${pendingTokens} undistilled tokens in ${sessionID.slice(0, 16)}`,
      );
      runBackground(
        () => distillation.run({ llm, projectPath, sessionID, model, skipMeta: true, callType: batchQueueEnabled ? "batch" : "direct" }),
        `incremental-distill session=${sessionID.slice(0, 16)}`,
      ).catch((e) => log.error("background distillation failed:", e));
    }
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
    runBackground(
      () => Sentry.startSpan(
        { name: "lore.curator", op: "lore.curation", attributes: { trigger: "in-flight" } },
        () => curator.run({ llm, projectPath, sessionID, model }),
      ),
      `in-flight-curation session=${sessionID.slice(0, 16)}`,
    )
      .then((result) => {
        if (!result) return; // skipped by circuit breaker
        sessionState.turnsSinceCuration = 0;
        saveSessionTracking(sessionID, { turnsSinceCuration: 0 });
        if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
          // Invalidate LTM cache only when curation actually changed entries
          ltmSessionCache.delete(sessionID);
          saveSessionTracking(sessionID, { ltmCacheText: null, ltmCacheTokens: null });
          log.info(
            `curation: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
          );
          emitCurationMetrics({ ...result, trigger: "in-flight" });
        }
      })
      .catch((e) => log.error("background curation failed:", e));
  }
}

// ---------------------------------------------------------------------------
// Compaction summary generation — shared by HTTP interception and /v1/compact
// ---------------------------------------------------------------------------

/**
 * Generate a compaction summary for a session. Force-distills any pending
 * messages, loads existing distillation summaries, builds a knowledge block,
 * and calls the LLM to produce a compaction summary.
 *
 * This is the core logic shared by both:
 *  - `handleCompaction` (HTTP-intercepted compaction from Claude Code / OpenCode)
 *  - `handleCompactEndpoint` (explicit POST /v1/compact from Pi plugin)
 */
export async function generateCompactionSummary(opts: {
  projectPath: string;
  sessionID: string;
  config: GatewayConfig;
  previousSummary?: string;
}): Promise<string | null> {
  const { projectPath, sessionID, config, previousSummary } = opts;
  const llm = getLLMClient(config);

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
    callType: "direct",
  });

  // 2. Load distillation summaries
  const distillations = distillation.loadForSession(projectPath, sessionID);

  // 3. Build knowledge block
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

  // 4. Build the compact prompt
  const compactPrompt = buildCompactPrompt({
    hasDistillations: distillations.length > 0,
    knowledge,
    previousSummary,
  });

  // 5. Build context with distillation summaries
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

  // 6. Generate the compaction summary via LLM
  const userContent = context
    ? `${context}\n\n---\n\n${compactPrompt}`
    : compactPrompt;

  const compactInputTokens = Math.ceil(userContent.length / 3);
  const compactMaxTokens = Math.max(2048, Math.min(Math.ceil(compactInputTokens * 0.5), 20_000));
  const summaryText = await llm.prompt(compactPrompt, userContent, {
    model: getWorkerModel(),
    workerID: "lore-compact",
    urgent: true,
    maxTokens: compactMaxTokens,
    temperature: 0,
  });

  return summaryText ?? null;
}

// ---------------------------------------------------------------------------
// Case 1: Compaction interception
// ---------------------------------------------------------------------------

async function handleCompaction(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  const pathResult = getProjectPath(req.system, req.rawHeaders);
  await initIfNeeded(pathResult.path, config, pathResult.gitRemote);

  const { sessionID } = await identifySession(req, pathResult.path);
  const sessionState = getOrCreateSession(sessionID, pathResult.path);
  const projectPath = resolveSessionProjectPath(pathResult, sessionState);

  setSentryLightContext({ model: req.model, projectPath });
  log.info(`compaction intercepted for session ${sessionID.slice(0, 16)}`);

  const summary = await generateCompactionSummary({
    projectPath,
    sessionID,
    config,
    previousSummary: extractPreviousSummary(req),
  });

  // If Lore's own summary generation failed (rate limits, auth issues, etc.),
  // fall back to forwarding the original compaction request to the upstream API
  // so the client still gets a proper compaction response.
  if (summary == null) {
    log.warn(
      `compaction summary generation failed for session ${sessionID.slice(0, 16)} — falling back to upstream`,
    );
    // Compaction still happens (upstream), so post-compaction messages will
    // differ — clear the stale warmup body to avoid false cache bust signals.
    sessionState.cacheAnalytics.lastRequestBody = null;
    return await handlePassthrough(req, config);
  }

  const resp = buildCompactionResponse(sessionID, summary, req.model);

  // Clear the cached warmup body — post-compaction the client will send
  // entirely different messages, so the pre-compaction body is stale.
  sessionState.cacheAnalytics.lastRequestBody = null;

  if (req.stream) {
    return streamHttpResponse(resp);
  }
  return nonStreamHttpResponse(resp);
}

// ---------------------------------------------------------------------------
// Case 1b: Explicit compaction endpoint (POST /v1/compact)
// ---------------------------------------------------------------------------

/**
 * Handle an explicit compaction summary request from a plugin (e.g. Pi).
 * Unlike `handleCompaction` which detects compaction from request patterns,
 * this endpoint accepts a direct JSON body with project path and optional
 * previous summary.
 *
 * The caller must include a session-identifying header (e.g. x-lore-session-id)
 * so the gateway can resolve the correct internal session.
 */
export async function handleCompactEndpoint(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: { project_path?: string; previous_summary?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid_request", message: "Invalid JSON body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const projectPath = body.project_path;
  if (!projectPath || typeof projectPath !== "string") {
    return new Response(
      JSON.stringify({ error: "invalid_request", message: "project_path is required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Extract git remote from header if available (Pi plugin injects this).
  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  const gitRemote = extractGitRemoteHeader(rawHeaders);

  await initIfNeeded(projectPath, config, gitRemote);

  // Build a minimal GatewayRequest for session identification.
  // Only rawHeaders and messages are used by identifySession().

  const minimalReq: GatewayRequest = {
    protocol: "anthropic",
    system: "",
    messages: [],
    tools: [],
    model: "",
    maxTokens: 0,
    stream: false,
    metadata: {},
    rawHeaders,
  };

  const { sessionID, isNew } = await identifySession(minimalReq, projectPath);

  if (isNew) {
    // No prior session found — the caller's session header didn't match any
    // existing session. This typically means no conversation turns have gone
    // through the gateway yet, so there's nothing to compact.
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No active session found for the given headers. " +
          "Ensure at least one conversation turn has been routed through the gateway.",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  log.info(`compact endpoint: generating summary for session ${sessionID.slice(0, 16)}`);

  try {
    const summary = await generateCompactionSummary({
      projectPath,
      sessionID,
      config,
      previousSummary: typeof body.previous_summary === "string"
        ? body.previous_summary
        : undefined,
    });

    if (summary == null) {
      log.warn(
        `compact endpoint: summary generation failed for session ${sessionID.slice(0, 16)} — returning 502`,
      );
      return new Response(
        JSON.stringify({ error: "compaction_failed", message: "Summary generation failed (worker model unavailable)" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    // Clear the cached warmup body — post-compaction the client will send
    // entirely different messages, so the pre-compaction body is stale.
    const sessionState = sessions.get(sessionID);
    if (sessionState) {
      sessionState.cacheAnalytics.lastRequestBody = null;
    }

    return new Response(
      JSON.stringify({ summary }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Compaction failed";
    log.error("compact endpoint error:", err);
    return new Response(
      JSON.stringify({ error: "compaction_failed", message: msg }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Case 2: Meta request passthrough (title gen, summaries, categorization, etc.)
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

/**
 * Check whether the upstream prompt cache is likely still warm for this
 * session. Returns true when a warmup ping was successfully sent within
 * the current cache TTL window.
 *
 * When true, post-idle compaction should be skipped: the warmer replayed
 * the full (uncompacted) request body, so compacting now would produce
 * different bytes and bust the cache the warmer just paid to preserve.
 */
function isCacheWarm(state: SessionState): boolean {
  const warmup = state.warmup;
  // Require at least one successful warmup before claiming warm.
  // This also gates the forceKeepWarm early-return below.
  if (!warmup?.lastWarmupAt) return false;

  const profile = resolveWarmingProfile(
    state.lastModel,
    state.lastProtocol,
    state.resolvedConversationTTL,
  );
  if (!profile) return false;

  // /lore:warm:keep sessions: consider warm if the last warmup was within
  // 2 TTL windows. The warmer fires once per TTL window, so 2× provides a
  // safety margin while still expiring if the warmer has stopped
  // (e.g. circuit breaker tripped, process-level failure).
  if (warmup.forceKeepWarm) {
    return (Date.now() - warmup.lastWarmupAt) < profile.ttlMs * 2;
  }

  return (Date.now() - warmup.lastWarmupAt) < profile.ttlMs;
}

// ---------------------------------------------------------------------------
// Case 3: Normal conversation turn — full pipeline
// ---------------------------------------------------------------------------

async function handleConversationTurn(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  // --- 1. Project path & init ---
  const pathResult = getProjectPath(req.system, req.rawHeaders);
  await initIfNeeded(pathResult.path, config, pathResult.gitRemote);

  // --- 2. Capture auth credentials for background workers ---
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    setLastSeenAuth(cred);
  }

  // --- 3. Session identification ---
  const { sessionID, isNew, tier } = await identifySession(req, pathResult.path);
   const sessionState = getOrCreateSession(sessionID, pathResult.path);
  const projectPath = resolveSessionProjectPath(pathResult, sessionState);

  // Mark sub-agent sessions (x-parent-session-id present).
  // These get their own session but are flagged for cache warming exemption.
  // Resolve the client-side parent ID to a Lore internal session ID via the
  // headerSessionIndex (searches all indexed headers, including Tier 2 learned).
  // Tier 3 (fingerprint-only) parents have no index entry — resolution will fail
  // and a warning is logged.
  {
    const parentClientId = req.rawHeaders["x-parent-session-id"];
    if (parentClientId && (!sessionState.isSubagent || !sessionState.parentSessionId)) {
      if (!sessionState.isSubagent) {
        sessionState.isSubagent = true;
      }
      // Search the full headerSessionIndex — covers Tier 1 (known) and Tier 2 (learned) headers.
      let resolvedParent: string | undefined;
      for (const [key, loreId] of headerSessionIndex) {
        const colonIdx = key.indexOf(":");
        if (colonIdx >= 0 && key.slice(colonIdx + 1) === parentClientId) {
          resolvedParent = loreId;
          break;
        }
      }
      if (resolvedParent) {
        sessionState.parentSessionId = resolvedParent;
        saveSessionTracking(sessionID, {
          isSubagent: true,
          parentSessionId: resolvedParent,
        });
      } else if (!sessionState.parentSessionId) {
        // Parent may use Tier 3 (fingerprint) identification, or hasn't made
        // its first request yet. Persist isSubagent but leave parentSessionId
        // null — subsequent requests will re-attempt resolution.
        log.info(
          `session ${sessionID.slice(0, 16)}: subagent parent resolution pending for client ID ${parentClientId.slice(0, 16)}`,
        );
        saveSessionTracking(sessionID, { isSubagent: true });
      }
    }
  }

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
    // Persist fingerprint immediately — rare event (new session only)
    saveSessionTracking(sessionID, { fingerprint });

    // Seed header learning for new sessions (Tier 2 bootstrap).
    // Even Tier 1 sessions don't need this, but it's harmless and
    // avoids branching. For Tier 3 (fingerprinted) new sessions,
    // this seeds the first round of candidate collection.
    if (!sessionState.headerSessionId) {
      const result = learnHeaders(sessionState.candidateHeaders, req.rawHeaders);
      sessionState.candidateHeaders = result.updatedCandidates;
    }

    // Re-check knowledge files on new session start.  The file watcher
    // covers live edits, but this catches cases where:
    //  - The watcher wasn't set up (file didn't exist at startup)
    //  - The watcher missed an event (e.g. network-mounted fs)
    //  - The file was created after gateway startup (first export from another machine)
    tryImportKnowledge(projectPath);
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

  // Update message count for proximity matching & structural compaction detection.
  sessionState.messageCount = currMsgCount;
  // Batched save: messageCount + turnsSinceCuration + consecutiveTextOnlyTurns
  // together to avoid multiple DB writes per turn.
  saveSessionTracking(sessionID, {
    messageCount: currMsgCount,
    turnsSinceCuration: sessionState.turnsSinceCuration,
    consecutiveTextOnlyTurns: sessionState.consecutiveTextOnlyTurns,
  });

  // Track session model for worker model discovery
  lastSeenSessionModel = req.model;

  // --- Sentry scope enrichment ---
  setSentryRequestContext({
    authFingerprint: cred ? authFingerprint(cred) : null,
    sessionID,
    model: req.model,
    upstreamUrl: resolveUpstreamRoute(req.model)?.url ?? (req.protocol === "anthropic" ? config.upstreamAnthropic : config.upstreamOpenAI),
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

  // --- Strip context warning markers from previous turns ---
  // The warning is injected into the response (assistant message) so the user
  // can see it. On the next turn, the client sends it back as part of the
  // assistant message. Strip it here so the API sees the original content,
  // preserving the prompt cache prefix.
  stripContextWarnings(req.messages);

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

  // Set cache pricing for tier-based bust-vs-continue decisions in gradient.ts.
  if (modelSpec.cacheWriteCost && modelSpec.cacheReadCost) {
    setCachePricing(modelSpec.cacheWriteCost, modelSpec.cacheReadCost);
  }

  // --- 4c. Dynamic max_tokens sizing for non-Claude-Code clients ---
  // Claude Code manages its own max_tokens (32K for modern models). Non-CC
  // clients (OpenCode, generic) often send low/missing values (defaults to
  // 4096 in ingress parsing). Apply a hybrid headroom + history algorithm
  // that tightens from the 32K ceiling based on actual output patterns.
  const clientType = detectClientType(req.rawHeaders);
  const isCC = clientType === "claude-code" || hasBillingHeader(req.system);
  if (!isCC) {
    const computed = computeMaxTokens(
      modelSpec.output,
      modelSpec.context,
      sessionState.outputTokensEMA,
      sessionState.lastStopReason,
      sessionState.lastInputTokens,
    );
    if (req.maxTokens !== computed) {
      log.info(
        `max_tokens: ${req.maxTokens} → ${computed} ` +
          `(client=${clientType}, ema=${sessionState.outputTokensEMA ?? "none"}, ` +
          `lastStop=${sessionState.lastStopReason ?? "none"})`,
      );
      req.maxTokens = computed;
    }
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
  // If the cache warmer recently refreshed this session's prompt cache,
  // skip post-idle compaction — compacting would produce a different prompt
  // body that doesn't match the warmed prefix, causing a cache bust.
  const cacheWarm = isCacheWarm(sessionState);
  const idleResult = onIdleResume(sessionID, thresholdMs, Date.now(), cacheWarm);
  sessionState.lastTurnWasIdle = idleResult.triggered;
  if (idleResult.triggered) {
    ltmSessionCache.delete(sessionID);
    saveSessionTracking(sessionID, { ltmCacheText: null, ltmCacheTokens: null });
    log.info(
      `session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches` +
        (cacheWarm ? " (cache warm — skipping compact)" : ""),
    );
  }

  // --- 6. LTM injection (3-block system prompt for cache efficiency) ---
  // system[0]: Host prompt              [no cache_control]
  // system[1]: Stable LTM (preferences) [cache_control: 1h] — pinned ≥1h
  // system[2]: Context-bound LTM        [no cache_control]  — diff-pinned
  //
  // system[0]+[1] form a stable prefix cached at 1h TTL (written at 2×
  // cost, read at 0.1×). system[2] rides the conversation cache (5m TTL,
  // 1.25×). When context-bound LTM changes (turn 1→2, curation), only
  // system[2] and messages are re-processed; system[0]+[1] are cache reads.
  let stableLtmText: string | undefined; // block 2: preferences
  let ltmText: string | undefined;       // block 3: context-bound entries
  if (cfg.knowledge.enabled) {
    // Track whether LTM state changed for batched DB persistence
    let ltmDirty = false;
    let pinDirty = false;

    try {
      const ltmFraction = cfg.budget.ltm;
      const ltmBudget = getLtmBudget(ltmFraction);
      const prefBudget = getPreferenceLtmBudget(cfg.budget.preferenceLtm);
      const isFirstTurn = sessionID != null && !temporal.hasMessages(projectPath, sessionID);
      const contextHint = lastUserTextTrimmed(req);

      // --- system[1]: Stable LTM (preferences) ---
      // Computed once per session and pinned for ≥1h. NOT invalidated by
      // curation — even if a preference changes, we keep the cached version
      // so the Anthropic 1h prompt cache prefix stays warm.
      // Uses a dedicated budget independent of context-bound LTM.
      let stable = stableLtmCache.get(sessionID);
      if (!stable) {
        const prefEntries = await ltm.forSession(projectPath, sessionID, prefBudget, {
          categories: ["preference"],
          ...(contextHint ? { contextHint } : {}),
        });
        if (prefEntries.length) {
          const formatted = formatKnowledge(
            prefEntries.map((e) => ({
              category: e.category,
              title: e.title,
              content: e.content,
            })),
            prefBudget,
          );
          if (formatted) {
            const tokenCount = Math.ceil(formatted.length / 3);
            stable = { formatted, tokenCount };
            stableLtmCache.set(sessionID, stable);
          }
        }
      }
      stableLtmText = stable?.formatted;

      // --- system[2]: Context-bound LTM (non-preference entries) ---
      // Deferred to turn 2+ when real session context exists for relevance
      // scoring. On turn 1, only stable LTM (preferences) is injected.
      if (!isFirstTurn) {
        let cached = ltmSessionCache.get(sessionID);

        if (!cached) {
          // Full context-bound budget — preferences have their own dedicated budget.
          const contextBudget = ltmBudget;
          // Exclude preferences — they're already in system[1]
          const contextEntries = await ltm.forSession(projectPath, sessionID, contextBudget, {
            excludeCategories: ["preference"],
            ...(contextHint ? { contextHint } : {}),
          });
          if (contextEntries.length) {
            const formatted = formatKnowledge(
              contextEntries.map((e) => ({
                category: e.category,
                title: e.title,
                content: e.content,
              })),
              contextBudget,
            );
            if (formatted) {
              const tokenCount = Math.ceil(formatted.length / 3);
              cached = { formatted, tokenCount };
              ltmSessionCache.set(sessionID, cached);
              ltmDirty = true;
            }
          }
        }

        if (cached) {
          // Content-diff pinning: only update the injected LTM text if the
          // new content differs by more than a threshold from what's currently
          // pinned. This prevents cache busts from minor re-ranking after
          // background curation/consolidation invalidates the LTM cache.
          const pinned = ltmPinnedText.get(sessionID);
          if (pinned && textDiffRatio(pinned.formatted, cached.formatted) < ltmDiffThreshold(modelSpec.inputCostPerMillion)) {
            // Near-identical — keep the pinned text to preserve cache prefix
            ltmText = pinned.formatted;
          } else {
            // Substantially different or first injection — pin the new text
            ltmPinnedText.set(sessionID, cached);
            pinDirty = true;
            ltmText = cached.formatted;
          }
        }
      }

      // Use stored tokenCount from cache/pin rather than re-estimating
      // from string length — avoids inconsistent estimates.
      const contextTokens = ltmText
        ? (ltmPinnedText.get(sessionID)?.tokenCount
          ?? ltmSessionCache.get(sessionID)?.tokenCount
          ?? 0)
        : 0;
      setLtmTokens((stable?.tokenCount ?? 0) + contextTokens, sessionID);
    } catch (e) {
      log.error("LTM injection failed:", e);
      setLtmTokens(0, sessionID);
    } finally {
      consumeCameOutOfIdle(sessionID);
    }

    // Batched LTM state persistence — single DB write for cache + pin changes
    if (ltmDirty || pinDirty) {
      const cached = ltmSessionCache.get(sessionID);
      const pinned = ltmPinnedText.get(sessionID);
      saveSessionTracking(sessionID, {
        ...(ltmDirty && cached ? { ltmCacheText: cached.formatted, ltmCacheTokens: cached.tokenCount } : {}),
        ...(pinDirty && pinned ? { ltmPinText: pinned.formatted, ltmPinTokens: pinned.tokenCount } : {}),
      });
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

  // --- 7b. LTM refresh on emergency layer ---
  // Layer 4 (emergency/transient reset) signals that the context was fully
  // reset. Re-run forSession() to re-rank context-bound entries by relevance
  // to the current conversation state — entries that became relevant mid-
  // session (e.g. a gotcha discovered during debugging) are surfaced on the
  // reset turn rather than waiting for the next session. Stable LTM
  // (system[1]) is kept pinned — Layer 4 busts the prompt cache anyway, so
  // system[1] will be re-written, but keeping the same content means the
  // NEXT turn's prefix matches and gets a cache read.
  if (result.refreshLtm && cfg.knowledge.enabled) {
    try {
      const ltmFraction = cfg.budget.ltm;
      const ltmBudget = getLtmBudget(ltmFraction);
      // Full context-bound budget — preferences have their own dedicated budget.
      const contextBudget = ltmBudget;
      const stableTokens = stableLtmCache.get(sessionID)?.tokenCount ?? 0;
      const contextHint = lastUserTextTrimmed(req);
      const contextEntries = await ltm.forSession(projectPath, sessionID, contextBudget, {
        excludeCategories: ["preference"],
        ...(contextHint ? { contextHint } : {}),
      });
      let refreshed = false;

      if (contextEntries.length) {
        const formatted = formatKnowledge(
          contextEntries.map((e) => ({
            category: e.category,
            title: e.title,
            content: e.content,
          })),
          contextBudget,
        );

        if (formatted) {
          const tokenCount = Math.ceil(formatted.length / 3);
          // Always update the cache with freshly ranked entries.
          ltmSessionCache.delete(sessionID);
          ltmSessionCache.set(sessionID, { formatted, tokenCount });

          // Apply diff-pinning: on consecutive Layer 4 turns, system[2]
          // stability matters because system[0]+[1] ARE still cache reads
          // at 1h TTL. Only update the pin if the new text differs
          // substantially — same threshold as step 6.
          const pinned = ltmPinnedText.get(sessionID);

          if (pinned && textDiffRatio(pinned.formatted, formatted) < ltmDiffThreshold(modelSpec.inputCostPerMillion)) {
            // Near-identical — keep the pinned text to preserve cache prefix
            ltmText = pinned.formatted;
            setLtmTokens(stableTokens + pinned.tokenCount, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              // pin unchanged — don't write ltmPinText/ltmPinTokens
            });
          } else {
            // Substantially different or first Layer 4 turn — pin the new text
            ltmPinnedText.set(sessionID, { formatted, tokenCount });
            ltmText = formatted;
            setLtmTokens(stableTokens + tokenCount, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              ltmPinText: formatted,
              ltmPinTokens: tokenCount,
            });
          }
          refreshed = true;
          log.info("Context-bound LTM refreshed on emergency layer (Layer 4) for session", sessionID);
        }
      }

      if (!refreshed) {
        // forSession() returned no context-bound entries — clear context LTM
        // state. Stable LTM (system[1]) is preserved.
        ltmSessionCache.delete(sessionID);
        ltmPinnedText.delete(sessionID);
        ltmText = undefined;
        setLtmTokens(stableTokens, sessionID);
        saveSessionTracking(sessionID, {
          ltmCacheText: null, ltmCacheTokens: null,
          ltmPinText: null, ltmPinTokens: null,
        });
        log.info("Context-bound LTM cleared on emergency layer (Layer 4) — stable LTM preserved for session", sessionID);
      }
    } catch (e) {
      // On error, leave the step-6 LTM state intact (cache, pin, text)
      // so the turn proceeds with the pre-refresh knowledge rather than
      // an inconsistent state. The next turn will retry via step 6.
      log.error("LTM refresh on emergency layer failed:", e);
    }
  }

  // --- 7c. Context health note ---
  // When the gradient compresses context (layer 1+), append a brief note to
  // the context-bound LTM block (system[2]) so the AI knows its context is
  // managed and can use the recall tool for details no longer visible.
  // This rides system[2] which already changes per-turn — no cache impact on
  // the stable prefix (system[0]+[1]).
  if (result.layer >= 1 && ltmText) {
    const layerDesc = result.layer === 1 ? "compressed"
      : result.layer === 2 ? "aggressively compressed"
      : result.layer >= 3 ? "emergency compressed" : "compressed";
    ltmText += `\n\n[Context health: conversation history is ${layerDesc}. ` +
      `Earlier details (file paths, error messages, decisions) are preserved in distilled ` +
      `observations and searchable via the recall tool. Use recall proactively when referencing ` +
      `details from earlier in the session.]`;
  } else if (result.layer >= 1 && !ltmText) {
    ltmText = `[Context health: conversation history is compressed. ` +
      `Earlier details (file paths, error messages, decisions) are preserved in distilled ` +
      `observations and searchable via the recall tool. Use recall proactively when referencing ` +
      `details from earlier in the session.]`;
  }

  // --- 7d. Unsustainable conversation warning ---
  // When 5+ consecutive cache busts are detected, flag for response-side injection.
  // The warning is injected into the assistant response (not the user message) so:
  //  1. The user can actually see it (not hidden in <system-reminder> tags)
  //  2. No modification to user messages → no cache prefix divergence
  //  3. Stripped on the next turn to restore API-original content for cache
  const unsustainable = result.unsustainable;
  if (unsustainable) {
    log.warn(
      `session ${sessionID}: unsustainable conversation detected (5+ consecutive cache busts). ` +
      `Warning will be prepended to response.`,
    );
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
  // Meta request passthrough (handlePassthrough) never reaches here — it
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
        // Upgrade immediately — switching to 1h is always beneficial
        resolvedConversationTTL = "1h";
        sessionState.ttlDowngradeStreak = 0;
        log.info(
          `auto-upgrade conversation TTL to 1h: session=${sessionID.slice(0, 16)}` +
          ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
        );
      } else if (coldFraction < 0.2 && resolvedConversationTTL === "1h") {
        // Hysteresis: require 3 consecutive qualifying turns before downgrading.
        // A single fluctuation below 20% shouldn't trigger a downgrade because
        // the TTL change modifies the cached bytes AND drops the idle threshold
        // from 60min to 5min, causing a compounding cache bust.
        const streak = (sessionState.ttlDowngradeStreak ?? 0) + 1;
        sessionState.ttlDowngradeStreak = streak;
        if (streak >= 3) {
          resolvedConversationTTL = "5m";
          sessionState.ttlDowngradeStreak = 0;
          log.info(
            `auto-downgrade conversation TTL to 5m: session=${sessionID.slice(0, 16)}` +
            ` coldFraction=${(coldFraction * 100).toFixed(0)}% streak=${streak}`,
          );
        } else {
          log.info(
            `TTL downgrade deferred (streak ${streak}/3): session=${sessionID.slice(0, 16)}` +
            ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
          );
        }
      } else {
        // Cold fraction not qualifying for downgrade — reset streak
        if (resolvedConversationTTL === "1h") {
          sessionState.ttlDowngradeStreak = 0;
        }
      }
    }
  }
  sessionState.resolvedConversationTTL = resolvedConversationTTL;

  const cacheOptions: AnthropicCacheOptions = {
    systemTTL: "1h",
    stableLtmSystem: stableLtmText,
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
        req.protocol === "openai-responses"
          ? "openai-responses"
          : (resolveUpstreamRoute(req.model)?.protocol ?? "anthropic"),
      "gen_ai.response.streaming": req.stream,
      // NO gen_ai.input.messages — privacy (proxy for other people's projects)
    },
  });

  const { response: upstreamResponse, serializedBody: requestBody, effectiveProtocol } =
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
    // Non-Anthropic upstream streaming responses need their own accumulator
    // since the Anthropic SSE accumulator can't parse OpenAI SSE formats.
    if (effectiveProtocol === "openai-responses") {
      const resp = await accumulateResponsesSSEStream(upstreamResponse);
      // postResponse sees the clean response (for calibration, cost tracking).
      // Only the client-facing HTTP response gets the warning injected.
      postResponse(req, resp, sessionState, config, requestBody, genAiSpan);
      return nonStreamHttpResponse(unsustainable ? injectContextWarning(resp) : resp);
    }

    if (effectiveProtocol === "openai") {
      // OpenAI Chat Completions streaming — accumulate and return as
      // non-streaming Anthropic format (same pattern as non-stream path).
      const resp = await accumulateNonStreamOpenAIStream(upstreamResponse);
      postResponse(req, resp, sessionState, config, requestBody, genAiSpan);
      return nonStreamHttpResponse(unsustainable ? injectContextWarning(resp) : resp);
    }

    // Anthropic streaming: forward events and accumulate in parallel.
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
      unsustainable ? CONTEXT_WARNING_TEXT : undefined,
    );
  }

  // Non-streaming: dispatch to correct accumulator based on upstream protocol.
  const resp = await accumulateNonStreamResponse(upstreamResponse, effectiveProtocol);

  // --- Recall interception (non-streaming) ---
  if (hasRecallToolUse(resp)) {
    const recallBlock = findRecallToolUse(resp)!;
    const { result, input } = await executeRecall(
      recallBlock,
      sessionState.projectPath,
      sessionState.sessionID,
      getLLMClient(config),
    );

    // Store recall result for marker round-trip expansion
    const storeKey = recallStoreKey(input.query, input.scope ?? "all", input.id);
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
      return nonStreamHttpResponse(unsustainable ? injectContextWarning(markerResp) : markerResp);
    }

    // Recall-only — send follow-up request for seamless UX
    log.info(
      `recall (non-stream, only): executing follow-up for session ${sessionState.sessionID.slice(0, 16)}`,
    );
    const followUp = buildRecallFollowUp(modifiedReq, resp, result, recallBlock);
    let followUpResponse: Response;
    let followUpProtocol: "anthropic" | "openai" | "openai-responses";
    ({ response: followUpResponse, effectiveProtocol: followUpProtocol } = await forwardToUpstream(
      followUp,
      config,
      undefined,
      // Disable conversation caching on follow-up: the appended
      // tool_result makes the prefix diverge from the next real turn,
      // so the cache write would be wasted money.
      { ...cacheOptions, cacheConversation: false },
    ));

    if (!followUpResponse.ok) {
      const errorBody = await followUpResponse.text();
      log.error(
        `recall follow-up upstream error: ${followUpResponse.status} ${errorBody.slice(0, 500)}`,
        new Error(`recall follow-up upstream ${followUpResponse.status}`),
      );
      // Fall back to response with marker (no continuation)
      postResponse(req, markerResp, sessionState, config, requestBody, genAiSpan);
      return nonStreamHttpResponse(unsustainable ? injectContextWarning(markerResp) : markerResp);
    }

    let continuationResp = await accumulateNonStreamResponse(followUpResponse, followUpProtocol);

    // Defense-in-depth: if the model called recall again in the follow-up
    // (shouldn't happen since recall is stripped from tools), replace it
    // with marker text so the client never sees a raw recall tool_use.
    if (hasRecallToolUse(continuationResp)) {
      log.warn("recall follow-up contained another recall tool_use — stripping");
      continuationResp = replaceRecallWithMarker(continuationResp);
    }

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
    return nonStreamHttpResponse(unsustainable ? injectContextWarning(continuationResp) : continuationResp);
  }

  postResponse(req, resp, sessionState, config, requestBody, genAiSpan);
  return nonStreamHttpResponse(unsustainable ? injectContextWarning(resp) : resp);
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
// Slash command interception (/lore:warm:*)
// ---------------------------------------------------------------------------

/**
 * Extract the text of the last user message, trimmed.
 * Returns empty string if no user message found.
 */
function lastUserTextTrimmed(req: GatewayRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== "user") continue;
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
    return text;
  }
  return "";
}

/**
 * Check if the last user message is a warmup slash command.
 *
 * `/lore:warm:stop` — disables cache warming for this session.
 * `/lore:warm:keep` — forces cache warming regardless of survival analysis.
 * `/lore:warm:auto` — returns to normal survival-analysis-driven mode.
 *
 * Returns a synthetic Anthropic-format response if a command was matched,
 * or null to continue normal processing.
 */
function handleWarmupSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
): Response | null {
  const text = lastUserTextTrimmed(req);
  const lower = text.toLowerCase();

  const isStop = lower === "/lore:warm:stop";
  const isKeep = lower === "/lore:warm:keep";
  const isAuto = lower === "/lore:warm:auto";
  if (!isStop && !isKeep && !isAuto) return null;

  // Find the session for this request (use the same header-based lookup)
  const known = extractKnownSessionHeader(req.rawHeaders);
  let state: SessionState | undefined;
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const sid = headerSessionIndex.get(indexKey);
    if (sid) state = allSessions.get(sid);
  }

  // Update session warmup state
  if (state) {
    if (!state.warmup) {
      state.warmup = { lastWarmupAt: 0, warmupCount: 0, totalWarmups: 0, warmupHits: 0, disabled: false };
    }
    if (isStop) {
      state.warmup.disabled = true;
      state.warmup.forceKeepWarm = false;
    } else if (isKeep) {
      state.warmup.forceKeepWarm = true;
      state.warmup.disabled = false;
    } else {
      // isAuto — return to normal survival-analysis mode
      state.warmup.disabled = false;
      state.warmup.forceKeepWarm = false;
    }
    const modeLabel = isStop ? "stopped" : isKeep ? "forced" : "auto";
    log.info(
      `cache-warmer: ${lower} received for session=${state.sessionID.slice(0, 16)} — ` +
        `warming mode: ${modeLabel}`,
    );
  }

  const responseText = isStop
    ? "🧊 Cache warming stopped."
    : isKeep
      ? "🔥 Keeping cache warm."
      : "🔄 Cache warming set to auto.";

  const msgId = `msg_lore_${Date.now()}`;

  // Return SSE stream when the client expects streaming (OpenCode, Claude Code)
  if (req.stream) {
    const sseBody = buildSSETextResponse(msgId, req.model, responseText, {
      inputTokens: 0,
      outputTokens: 0,
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

  // Non-streaming: plain JSON
  const body = JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: responseText }],
    model: req.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Slash command: /lore:curate — synchronous distillation + curation
// ---------------------------------------------------------------------------

/**
 * `/lore:curate` — runs distillation + curation synchronously for the
 * current session and returns the results. Useful for:
 * - Eval harnesses that need curation to complete between session replays
 * - Users who want to force knowledge extraction after a conversation
 *
 * Returns a synthetic response with the curation results.
 */
async function handleCurateSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
  config: GatewayConfig,
): Promise<Response | null> {
  const text = lastUserTextTrimmed(req);
  if (text.toLowerCase() !== "/lore:curate") return null;

  // Find the session
  const known = extractKnownSessionHeader(req.rawHeaders);
  let state: SessionState | undefined;
  let sessionID: string | undefined;
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const sid = headerSessionIndex.get(indexKey);
    if (sid) {
      state = allSessions.get(sid);
      sessionID = sid;
    }
  }

  // Fall back to finding any recent session for this project
  if (!sessionID) {
    // Use the most recently active session
    let latest: SessionState | undefined;
    for (const s of allSessions.values()) {
      if (!latest || s.lastRequestTime > latest.lastRequestTime) {
        latest = s;
      }
    }
    if (latest) {
      state = latest;
      sessionID = latest.sessionID;
    }
  }

  if (!sessionID || !state) {
    return slashResponse(req, "No active session found for curation.", "msg_lore_curate_none");
  }

  const projectPath = state.projectPath;
  const { distillation, curator } = await import("@loreai/core");
  const llm = getLLMClient(config);
  const model = getWorkerModel();

  log.info(`/lore:curate: running for session=${sessionID.slice(0, 16)}`);

  // Force-distill all pending messages (urgent bypasses batch queue)
  let distilled = 0;
  try {
    const dResult = await distillation.run({
      llm,
      projectPath,
      sessionID,
      model,
      force: true,
      skipMeta: true,
      urgent: true,
      callType: "direct",
    });
    distilled = dResult.distilled;
  } catch (e) {
    log.error("/lore:curate distillation error:", e);
  }

  // Run curation (uses urgent/direct call via the LLM client)
  let created = 0;
  let updated = 0;
  let deleted = 0;
  try {
    const cResult = await curator.run({ llm, projectPath, sessionID, model });
    created = cResult.created;
    updated = cResult.updated;
    deleted = cResult.deleted;
  } catch (e) {
    log.error("/lore:curate curation error:", e);
  }

  const responseText =
    `Curation complete: ${distilled} segments distilled, ` +
    `${created} entries created, ${updated} updated, ${deleted} deleted.`;

  log.info(`/lore:curate: ${responseText}`);

  return slashResponse(req, responseText, `msg_lore_curate_${Date.now()}`);
}

/** Build a synthetic slash-command response (streaming or JSON). */
function slashResponse(req: GatewayRequest, text: string, msgId: string): Response {
  if (req.stream) {
    const sseBody = buildSSETextResponse(msgId, req.model, text, {
      inputTokens: 0,
      outputTokens: 0,
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

  return new Response(
    JSON.stringify({
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: req.model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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

    // --- Case 0: Slash command interception ---
    const slashResult = handleWarmupSlashCommand(req, sessions);
    if (slashResult) return slashResult;
    const curateResult = await handleCurateSlashCommand(req, sessions, config);
    if (curateResult) return curateResult;

    // --- Case 1: Compaction request → intercept ---
    // Structural detection (session-aware) first, pattern matching as fallback.
    // Sub-agents now get their own sessions (separate x-session-affinity), so
    // priorState is the sub-agent's own state — structural detection is safe.
    const structuralCompaction = isStructuralCompaction(req, priorState);
    const patternDetection = structuralCompaction ? undefined : detectCompactionRequest(req);
    if (structuralCompaction || patternDetection?.detected) {
      const reason = structuralCompaction
        ? `structural (prior=${priorState?.messageCount ?? "?"} curr=${req.messages.length})`
        : patternDetection?.detected
          ? patternDetection.reason === "system-prompt"
            ? `pattern: system-prompt match "${patternDetection.pattern}"`
            : patternDetection.reason === "user-keywords"
              ? `pattern: user-keyword match "${patternDetection.pattern}"`
              : `pattern: template-sections (${patternDetection.matchCount} matches)`
          : "unknown";
      log.info(`compaction detected: ${reason} messages=${req.messages.length} tools=${req.tools.length}`);
      return await handleCompaction(req, config);
    }

    // --- Case 2: Meta request (title gen, summary, categorization, etc.) → passthrough ---
    if (isMetaRequest(req)) {
      log.info(
        `meta request detected: messages=${req.messages.length} tools=${req.tools.length}`
        + ` maxTokens=${req.maxTokens} agent=${req.rawHeaders[LORE_AGENT_HEADER] ?? "none"}`,
      );
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
