/**
 * Batch queue for LLM Batch APIs (Anthropic + OpenAI).
 *
 * Wraps a synchronous LLMClient and intercepts non-urgent `prompt()` calls,
 * accumulating them in a queue. A flush timer periodically sends the queue
 * to the appropriate batch API endpoint for 50% cost savings.
 * A poll timer checks for results and resolves the pending promises.
 *
 * Supports two batch providers:
 *   - **Anthropic**: POST /v1/messages/batches with inline JSON
 *   - **OpenAI**: Upload JSONL to /v1/files, then POST /v1/batches
 *
 * Items are grouped at flush time by `(authKey, providerID)` — each
 * credential+provider combo gets its own batch submission.
 *
 * Urgent calls (compaction, overflow recovery, query expansion) bypass
 * the queue entirely and delegate to the inner synchronous client.
 *
 * Auth credentials are snapshotted per-item at enqueue time and grouped
 * by credential at flush time — this ensures multi-session isolation when
 * multiple clients with different API keys are connected simultaneously.
 *
 * The OpenCode and Pi plugin adapters always process LLM calls
 * immediately regardless of the `urgent` flag.
 */

import type { LLMClient } from "@loreai/core";
import { log, getKV, setKV } from "@loreai/core";
import * as Sentry from "@sentry/bun";
import { authFingerprint, type AuthCredential } from "./auth";
import { authHeaders } from "./auth";
import {
  setGenAiUsageAttributes,
  emitCostMetric,
  type AnthropicUsage,
} from "./sentry";
import { recordWorkerCost } from "./cost-tracker";
import { normalizeOpenAIUsage } from "./llm-adapter";

// ---------------------------------------------------------------------------
// BatchProvider strategy interface
// ---------------------------------------------------------------------------

/** A single result from a completed batch. */
export interface BatchResult {
  customId: string;
  outcome: "succeeded" | "errored" | "canceled" | "expired";
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
  error?: string;
}

/** Result of polling a batch for status. */
export type PollResult =
  | { status: "pending" }
  | { status: "done"; results: BatchResult[] }
  | { status: "failed"; error: string };

/**
 * Provider-specific batch API operations.
 *
 * The batch queue delegates wire-format-specific work (submit, poll, retrieve)
 * to a BatchProvider implementation. Queue management, flush timers, promise
 * lifecycle, fallback, and shutdown are shared.
 */
export interface BatchProvider {
  /** Provider name for logging and metrics. */
  name: string;
  /** Max age before falling back to synchronous (ms). */
  maxBatchAgeMs: number;
  /**
   * Submit a batch. Returns a batch ID on success.
   * Returns `"auth-error"` for 401/403 (permanent — session should be disabled).
   * Returns `null` for transient failures (network, 5xx — retry via fallback).
   */
  submit(
    auth: AuthCredential,
    items: Array<{ customId: string; params: PendingRequest["params"] }>,
  ): Promise<string | "auth-error" | null>;
  /** Poll a batch for completion. */
  poll(auth: AuthCredential, batchId: string): Promise<PollResult>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single pending request waiting to be batched. */
interface PendingRequest {
  /** Unique ID for correlating batch results (alphanumeric + hyphens). */
  customId: string;
  /** Standard Messages API params (Anthropic format — converted at submit time for OpenAI). */
  params: {
    model: string;
    max_tokens: number;
    system:
      | string
      | Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
    messages: Array<{ role: string; content: string }>;
  };
  /** Resolve the caller's promise with the text response (null on error). */
  resolve: (value: string | null) => void;
  /** Timestamp when the request was enqueued. */
  enqueuedAt: number;
  /** Auth credential snapshotted at enqueue time for per-session isolation. */
  auth: AuthCredential;
  /** Provider ID for routing to the correct batch provider at flush time. */
  providerID: string;
  /** Session ID for billing header injection on fallback to individual requests. */
  sessionID?: string;
  /** Worker ID for cost attribution (e.g. "lore-distill", "lore-curator"). */
  workerID?: string;
}

/** A batch that has been submitted and is being polled for results. */
interface InflightBatch {
  /** Batch ID returned by the provider's create endpoint. */
  batchId: string;
  /** Map from custom_id → pending request (for resolving on completion). */
  requests: Map<string, PendingRequest>;
  /** Timestamp when the batch was submitted. */
  submittedAt: number;
  /** Poll timer handle. */
  pollTimer: ReturnType<typeof setInterval>;
  /** Auth credential for this batch (used for poll/retrieve calls). */
  auth: AuthCredential;
  /** The batch provider that submitted this batch (used for polling). */
  provider: BatchProvider;
}

export interface BatchQueueConfig {
  /** How often to flush the queue (ms). Default: 30000 (30s). */
  flushIntervalMs?: number;
  /** Max items before auto-flush. Default: 50. */
  maxQueueSize?: number;
  /** How often to poll for batch results (ms). Default: 60000 (60s). */
  pollIntervalMs?: number;
  /** Max age of a batch before giving up and falling back (ms). Default: 3600000 (1h). */
  maxBatchAgeMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BATCH_AGE_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Generate a batch-API-compatible custom_id (alphanumeric + hyphens, 1-64 chars). */
function generateCustomId(): string {
  const ts = Date.now().toString(36);
  const seq = (idCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `lore-${ts}-${seq}-${rand}`;
}

/**
 * Produce a grouping key for an auth credential + provider combo.
 *
 * Uses `authFingerprint()` (SHA-256 truncated) so the raw credential
 * never appears as a Map key — avoids accidental exposure via logs,
 * Sentry breadcrumbs, or error serialization. Each distinct token/key
 * still gets its own batch submission. Provider is included because
 * Anthropic and OpenAI items must go to separate batch endpoints.
 */
function groupKey(cred: AuthCredential, providerID: string): string {
  return `${authFingerprint(cred)}|${providerID}`;
}

// authDisableKey removed — batch disable tracking is now per-session, not per-credential.

// ---------------------------------------------------------------------------
// Anthropic Batch Provider
// ---------------------------------------------------------------------------

/**
 * Create a BatchProvider for Anthropic's Messages Batches API.
 *
 * Submit: POST /v1/messages/batches with { requests: [{ custom_id, params }] }
 * Poll:   GET /v1/messages/batches/{id} → check processing_status
 * Results: GET results_url → JSONL with { custom_id, result: { type, message?, error? } }
 */
export function createAnthropicBatchProvider(upstreamUrl: string): BatchProvider {
  const baseUrl = upstreamUrl.replace(/\/$/, "");

  return {
    name: "anthropic",
    maxBatchAgeMs: DEFAULT_MAX_BATCH_AGE_MS, // 1 hour

    async submit(auth, items) {
      const requests = items.map((item) => ({
        custom_id: item.customId,
        params: item.params,
      }));

      const url = `${baseUrl}/v1/messages/batches`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders(auth),
        },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        if (response.status === 401 || response.status === 403) {
          log.warn(`anthropic batch auth error (${response.status}): ${text}`);
          return "auth-error";
        }
        log.error(`anthropic batch create failed: ${response.status} ${response.statusText} — ${text}`);
        return null;
      }

      const data = (await response.json()) as { id: string };
      return data.id;
    },

    async poll(auth, batchId) {
      const url = `${baseUrl}/v1/messages/batches/${batchId}`;
      const response = await fetch(url, {
        headers: {
          "anthropic-version": "2023-06-01",
          ...authHeaders(auth),
        },
      });

      if (!response.ok) {
        log.error(`anthropic batch poll failed for ${batchId}: ${response.status}`);
        return { status: "pending" }; // Retry on next poll
      }

      const data = (await response.json()) as {
        processing_status: string;
        results_url: string | null;
      };

      if (data.processing_status !== "ended") return { status: "pending" };

      // Batch is done — retrieve results
      const resultsUrl = data.results_url ?? `${baseUrl}/v1/messages/batches/${batchId}/results`;
      const resultsResponse = await fetch(resultsUrl, {
        headers: {
          "anthropic-version": "2023-06-01",
          ...authHeaders(auth),
        },
      });

      if (!resultsResponse.ok) {
        log.error(`anthropic batch results fetch failed for ${batchId}: ${resultsResponse.status}`);
        return { status: "pending" }; // Retry on next poll
      }

      const text = await resultsResponse.text();
      const lines = text.split("\n").filter((l) => l.trim());
      const results: BatchResult[] = [];

      for (const line of lines) {
        try {
          const row = JSON.parse(line) as {
            custom_id: string;
            result: {
              type: "succeeded" | "errored" | "canceled" | "expired";
              message?: {
                content?: Array<{ type: string; text?: string }>;
                model?: string;
                usage?: AnthropicUsage;
              };
              error?: { type: string; message: string };
            };
          };

          if (row.result.type === "succeeded") {
            const msg = row.result.message;
            const textBlock = msg?.content?.find(
              (b) => b.type === "text" && typeof b.text === "string",
            );
            results.push({
              customId: row.custom_id,
              outcome: "succeeded",
              text: textBlock?.text ?? null,
              usage: msg?.usage ?? null,
              model: msg?.model ?? null,
            });
          } else {
            results.push({
              customId: row.custom_id,
              outcome: row.result.type,
              text: null,
              usage: null,
              model: null,
              error: row.result.error
                ? `${row.result.error.type}: ${row.result.error.message}`
                : row.result.type,
            });
          }
        } catch {
          log.error(`failed to parse anthropic batch result line: ${line.slice(0, 200)}`);
        }
      }

      return { status: "done", results };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI Batch Provider
// ---------------------------------------------------------------------------

/**
 * Upload a JSONL file for OpenAI batch processing.
 * POST /v1/files with purpose="batch" and multipart/form-data body.
 */
async function uploadOpenAIBatchFile(
  baseUrl: string,
  auth: AuthCredential,
  jsonlContent: string,
): Promise<string | null> {
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append(
    "file",
    new Blob([jsonlContent], { type: "application/jsonl" }),
    "batch.jsonl",
  );

  const response = await fetch(`${baseUrl}/v1/files`, {
    method: "POST",
    headers: authHeaders(auth), // No Content-Type — FormData sets it with boundary
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    if (response.status === 401 || response.status === 403) {
      log.warn(`openai file upload auth error (${response.status}): ${text}`);
      return "auth-error";
    }
    log.error(`openai file upload failed: ${response.status} — ${text}`);
    return null;
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * Download and parse OpenAI batch results from a file.
 * GET /v1/files/{id}/content → JSONL lines
 */
async function downloadOpenAIResults(
  baseUrl: string,
  auth: AuthCredential,
  fileId: string,
): Promise<BatchResult[]> {
  const response = await fetch(`${baseUrl}/v1/files/${fileId}/content`, {
    headers: authHeaders(auth),
  });
  if (!response.ok) {
    log.error(`openai results download failed: ${response.status}`);
    return [];
  }

  const text = await response.text();
  const results: BatchResult[] = [];

  for (const line of text.split("\n").filter((l) => l.trim())) {
    try {
      const row = JSON.parse(line) as {
        custom_id: string;
        response: {
          status_code: number;
          body: {
            choices?: Array<{ message?: { content?: string } }>;
            model?: string;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
          };
        };
      };

      if (row.response.status_code === 200) {
        const body = row.response.body;
        results.push({
          customId: row.custom_id,
          outcome: "succeeded",
          text: body.choices?.[0]?.message?.content ?? null,
          usage: body.usage ? normalizeOpenAIUsage(body.usage) : null,
          model: body.model ?? null,
        });
      } else {
        results.push({
          customId: row.custom_id,
          outcome: "errored",
          text: null,
          usage: null,
          model: null,
          error: `HTTP ${row.response.status_code}`,
        });
      }
    } catch {
      log.error(`failed to parse openai batch result line: ${line.slice(0, 200)}`);
    }
  }

  return results;
}

/**
 * Convert system prompt from Anthropic block format to plain text for OpenAI.
 * Anthropic stores system as `[{ type: "text", text: "..." }]` with cache hints;
 * OpenAI expects a plain string in a `{ role: "system" }` message.
 */
function systemToText(
  system: string | Array<{ type: string; text: string }>,
): string {
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

/** Max batch age for OpenAI (4 hours). OpenAI allows up to 24h but we don't
 *  want to wait that long for background work results. */
const OPENAI_MAX_BATCH_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Create a BatchProvider for OpenAI's Batch API.
 *
 * Submit: Build JSONL → upload to /v1/files → create batch via /v1/batches
 * Poll:   GET /v1/batches/{id} → on completed, download results via /v1/files/{output_file_id}/content
 * Only supports /v1/chat/completions endpoint.
 */
export function createOpenAIBatchProvider(upstreamUrl: string): BatchProvider {
  const baseUrl = upstreamUrl.replace(/\/$/, "");

  return {
    name: "openai",
    maxBatchAgeMs: OPENAI_MAX_BATCH_AGE_MS, // 4 hours

    async submit(auth, items) {
      // 1. Build JSONL content — one line per request
      const lines = items.map((item) => {
        const messages: Array<{ role: string; content: string }> = [];
        if (item.params.system) {
          messages.push({
            role: "system",
            content: systemToText(item.params.system),
          });
        }
        messages.push(...item.params.messages);

        return JSON.stringify({
          custom_id: item.customId,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model: item.params.model,
            max_completion_tokens: item.params.max_tokens,
            messages,
          },
        });
      });
      const jsonl = lines.join("\n");

      // 2. Upload JSONL file
      const fileId = await uploadOpenAIBatchFile(baseUrl, auth, jsonl);
      if (!fileId || fileId === "auth-error") return fileId;

      // 3. Create batch
      const response = await fetch(`${baseUrl}/v1/batches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(auth),
        },
        body: JSON.stringify({
          input_file_id: fileId,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        if (response.status === 401 || response.status === 403) {
          log.warn(`openai batch auth error (${response.status}): ${text}`);
          return "auth-error";
        }
        log.error(`openai batch create failed: ${response.status} ${response.statusText} — ${text}`);
        return null;
      }

      const data = (await response.json()) as { id: string };
      return data.id;
    },

    async poll(auth, batchId) {
      const response = await fetch(`${baseUrl}/v1/batches/${batchId}`, {
        headers: authHeaders(auth),
      });

      if (!response.ok) {
        log.error(`openai batch poll failed for ${batchId}: ${response.status}`);
        return { status: "pending" }; // Retry on next poll
      }

      const data = (await response.json()) as {
        status: string;
        output_file_id?: string;
        error_file_id?: string;
      };

      if (data.status === "completed" && data.output_file_id) {
        const results = await downloadOpenAIResults(baseUrl, auth, data.output_file_id);
        return { status: "done", results };
      }

      if (
        data.status === "failed" ||
        data.status === "expired" ||
        data.status === "cancelled"
      ) {
        return { status: "failed", error: data.status };
      }

      // "validating", "in_progress", "finalizing", "cancelling" — still pending
      return { status: "pending" };
    },
  };
}

// ---------------------------------------------------------------------------
// BatchLLMClient
// ---------------------------------------------------------------------------

/**
 * Create a batch-aware LLMClient that wraps a synchronous inner client.
 *
 * - `urgent: true` calls → immediate delegation to `inner.prompt()`
 * - `urgent: false/undefined` calls → queued for batch processing
 * - On flush timer or queue full → submit to provider-specific batch API
 * - On poll timer → check status and resolve promises
 * - On error → fallback to synchronous calls for the failed batch
 *
 * Items are grouped by `(authKey, providerID)` at flush time so each
 * credential+provider combo gets its own batch submission.
 *
 * @param inner       The synchronous LLMClient (gateway's direct adapter)
 * @param upstreams   Base URLs for each provider
 * @param getAuth     Callback to resolve auth credentials (per-session → global fallback)
 * @param defaultModel Default model for requests without explicit model
 * @param batchConfig Optional tuning parameters
 */
export function createBatchLLMClient(
  inner: LLMClient,
  upstreams: { anthropic: string; openai: string },
  getAuth: (sessionID?: string) => AuthCredential | null,
  defaultModel: { providerID: string; modelID: string },
  batchConfig?: BatchQueueConfig,
): LLMClient & { shutdown: () => Promise<void>; stats: () => BatchStats } {
  const flushIntervalMs = batchConfig?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxQueueSize = batchConfig?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const pollIntervalMs = batchConfig?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Create both batch providers
  const providers: Record<string, BatchProvider> = {
    anthropic: createAnthropicBatchProvider(upstreams.anthropic),
    openai: createOpenAIBatchProvider(upstreams.openai),
  };

  function resolveProvider(providerID: string): BatchProvider {
    return providers[providerID] ?? providers.anthropic;
  }

  // State
  const queue: PendingRequest[] = [];
  const inflight = new Map<string, InflightBatch>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  /**
   * Session IDs whose batch API access has been permanently disabled (401/403).
   *
   * Tracked per-session rather than per-credential-scheme because future OAuth
   * tokens may gain batch scope. A 403 from one session's token should only
   * block that session, not all bearer-token sessions. Session IDs are stable
   * for the lifetime of a connection, so token refresh doesn't bypass this.
   *
   * Persisted to kv_meta so disabled sessions survive process restarts.
   */
  const DISABLED_BATCH_KV_KEY = "disabled_batch_sessions";
  const disabledBatchSessions = new Set<string>();
  // Restore from DB
  try {
    const raw = getKV(DISABLED_BATCH_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      for (const sid of parsed) disabledBatchSessions.add(sid);
    }
  } catch {
    // Corrupted value — start fresh
  }

  // Stats
  let totalQueued = 0;
  let totalBatched = 0;
  let totalUrgent = 0;
  let totalFallback = 0;
  let totalResolved = 0;
  let totalFailed = 0;

  // -------------------------------------------------------------------------
  // Submit a single batch for one credential+provider group
  // -------------------------------------------------------------------------

  async function submitBatch(
    provider: BatchProvider,
    auth: AuthCredential,
    items: PendingRequest[],
  ): Promise<void> {
    log.info(`batch flush (${provider.name}): submitting ${items.length} requests`);

    try {
      const batchId = await provider.submit(
        auth,
        items.map((item) => ({ customId: item.customId, params: item.params })),
      );

      if (!batchId || batchId === "auth-error") {
        if (batchId === "auth-error") {
          // Permanent auth failure — disable batch for affected sessions
          const sessionIDs = new Set(items.map((i) => i.sessionID).filter(Boolean) as string[]);
          for (const sid of sessionIDs) {
            disabledBatchSessions.add(sid);
          }
          if (sessionIDs.size > 0) {
            setKV(DISABLED_BATCH_KV_KEY, JSON.stringify([...disabledBatchSessions]));
            log.warn(
              `batch API (${provider.name}) disabled for sessions [${[...sessionIDs].join(", ")}]. ` +
                `Future worker calls for these sessions will use individual requests.`,
            );
          }
        }
        // Transient (null) or auth error — fall back to synchronous
        await fallbackAll(items);
        return;
      }

      totalBatched += items.length;

      // Track inflight batch
      const requestMap = new Map<string, PendingRequest>();
      for (const item of items) {
        requestMap.set(item.customId, item);
      }

      const pollTimer = setInterval(
        () => pollBatch(batchId).catch((e) => log.error("batch poll error:", e)),
        pollIntervalMs,
      );

      inflight.set(batchId, {
        batchId,
        requests: requestMap,
        submittedAt: Date.now(),
        pollTimer,
        auth,
        provider,
      });

      log.info(`batch created (${provider.name}): ${batchId} with ${items.length} requests`);
    } catch (e) {
      log.error(`batch create error (${provider.name}):`, e);
      await fallbackAll(items);
    }
  }

  // -------------------------------------------------------------------------
  // Flush: group queued items by credential+provider, submit one batch per group
  // -------------------------------------------------------------------------

  async function flush(): Promise<void> {
    if (queue.length === 0) return;

    // Take all items from the queue
    const batch = queue.splice(0);

    // Group by (auth credential, provider) — each combo gets its own batch
    const byGroup = new Map<
      string,
      { auth: AuthCredential; providerID: string; items: PendingRequest[] }
    >();
    for (const item of batch) {
      const key = groupKey(item.auth, item.providerID);
      let group = byGroup.get(key);
      if (!group) {
        group = { auth: item.auth, providerID: item.providerID, items: [] };
        byGroup.set(key, group);
      }
      group.items.push(item);
    }

    for (const { auth, providerID, items } of byGroup.values()) {
      // Split items: disabled sessions fall back, others go to batch.
      // A session is disabled when a prior batch 403'd for that session's credential.
      const batchable: PendingRequest[] = [];
      const fallbacks: PendingRequest[] = [];
      for (const item of items) {
        if (item.sessionID && disabledBatchSessions.has(item.sessionID)) {
          fallbacks.push(item);
        } else {
          batchable.push(item);
        }
      }
      if (fallbacks.length > 0) {
        await fallbackAll(fallbacks);
      }
      if (batchable.length > 0) {
        const provider = resolveProvider(providerID);
        await submitBatch(provider, auth, batchable);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Poll: check batch status and resolve promises
  // -------------------------------------------------------------------------

  async function pollBatch(batchId: string): Promise<void> {
    const batch = inflight.get(batchId);
    if (!batch) return;

    // Check max age — give up and fallback if too old
    // Uses provider-specific max age (1h Anthropic, 4h OpenAI)
    if (Date.now() - batch.submittedAt > batch.provider.maxBatchAgeMs) {
      log.warn(`batch ${batchId} (${batch.provider.name}) exceeded max age — falling back to synchronous`);
      clearInterval(batch.pollTimer);
      inflight.delete(batchId);
      await fallbackAll([...batch.requests.values()]);
      return;
    }

    try {
      const pollResult = await batch.provider.poll(batch.auth, batchId);

      if (pollResult.status === "pending") return;

      if (pollResult.status === "failed") {
        log.error(`batch ${batchId} (${batch.provider.name}) failed: ${pollResult.error}`);
        clearInterval(batch.pollTimer);
        inflight.delete(batchId);
        await fallbackAll([...batch.requests.values()]);
        return;
      }

      // status === "done" — resolve all results
      log.info(`batch ${batchId} (${batch.provider.name}) completed — resolving ${pollResult.results.length} results`);

      for (const result of pollResult.results) {
        const pending = batch.requests.get(result.customId);
        if (!pending) continue;

        switch (result.outcome) {
          case "succeeded": {
            // Emit gen_ai.chat span for batch result with usage + queue time
            if (Sentry.isInitialized() && result.usage) {
              Sentry.startSpan(
                {
                  op: "gen_ai.chat",
                  name: `chat ${pending.params.model}`,
                  attributes: {
                    "gen_ai.operation.name": "chat",
                    "gen_ai.request.model": pending.params.model,
                    "gen_ai.provider.name": batch.provider.name,
                    "lore.call_type": "batch",
                    "lore.batch_queue_ms": Date.now() - pending.enqueuedAt,
                  },
                },
                (span) => {
                  setGenAiUsageAttributes(span, result.usage!, result.model ?? undefined);
                },
              );
              emitCostMetric(pending.params.model, result.usage, "batch");
              recordWorkerCost(pending.sessionID, pending.params.model, result.usage, "batch", pending.workerID);
            }

            pending.resolve(result.text);
            totalResolved++;
            break;
          }
          case "errored":
            pending.resolve(null); // Match inner client behavior (null on error)
            totalFailed++;
            log.error(`batch item ${result.customId} errored: ${result.error ?? "unknown"}`);
            break;
          case "canceled":
          case "expired":
            pending.resolve(null);
            totalFailed++;
            log.warn(`batch item ${result.customId} ${result.outcome}`);
            break;
        }

        batch.requests.delete(result.customId);
      }

      // Resolve any remaining items that weren't in the results (shouldn't happen)
      for (const [, pending] of batch.requests) {
        pending.resolve(null);
        totalFailed++;
      }

      // Clean up
      clearInterval(batch.pollTimer);
      inflight.delete(batchId);
      log.info(
        `batch ${batchId} fully resolved (${totalResolved} ok, ${totalFailed} failed total)`,
      );
    } catch (e) {
      log.error(`batch poll error for ${batchId} (${batch.provider.name}):`, e);
    }
  }

  // -------------------------------------------------------------------------
  // Fallback: process items synchronously via inner client
  // -------------------------------------------------------------------------

  async function fallbackAll(items: PendingRequest[]): Promise<void> {
    totalFallback += items.length;
    log.info(`batch fallback: processing ${items.length} items synchronously`);

    // Process in parallel with concurrency limit of 5
    const CONCURRENCY = 5;
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const chunk = items.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (item) => {
          try {
            const system =
              typeof item.params.system === "string"
                ? item.params.system
                : item.params.system
                    .map((b) => b.text)
                    .join("\n");
            const user = item.params.messages[0]?.content ?? "";
            // Pass sessionID so inner.prompt can resolve the correct auth
            // credential and inject the billing header for bearer-token
            // sessions. Without this, getAuth(undefined) would fall back
            // to arbitrary credential selection and buildBillingBlock would
            // return null for bearer tokens — causing Anthropic to reject
            // the request with 429.
            const result = await inner.prompt(system, user, {
              urgent: true,
              sessionID: item.sessionID,
            });
            item.resolve(result);
          } catch (e) {
            log.error(`batch fallback error for ${item.customId}:`, e);
            item.resolve(null);
          }
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Start flush timer
  // -------------------------------------------------------------------------

  flushTimer = setInterval(() => {
    flush().catch((e) => log.error("batch flush timer error:", e));
  }, flushIntervalMs);

  // -------------------------------------------------------------------------
  // LLMClient implementation
  // -------------------------------------------------------------------------

  return {
    async prompt(system, user, opts) {
      // Urgent calls bypass the queue entirely
      if (opts?.urgent || shuttingDown) {
        totalUrgent++;
        return inner.prompt(system, user, opts);
      }

      // Snapshot auth credential at enqueue time for session isolation.
      // If no credential is available, fall back to synchronous processing
      // (which will also attempt to resolve auth — matches prior behavior).
      const cred = getAuth(opts?.sessionID);
      if (!cred) {
        totalUrgent++;
        return inner.prompt(system, user, opts);
      }

      totalQueued++;

      const model = opts?.model ?? defaultModel;

      // Build system payload with 1h cache (same as direct adapter)
      const systemPayload = system
        ? [
            {
              type: "text" as const,
              text: system,
              cache_control: { type: "ephemeral" as const, ttl: "1h" },
            },
          ]
        : undefined;

      const customId = generateCustomId();

      const promise = new Promise<string | null>((resolve) => {
        queue.push({
          customId,
          params: {
            model: model.modelID,
            max_tokens: opts?.maxTokens ?? 8192,
            system: systemPayload ?? [],
            messages: [{ role: "user", content: user }],
          },
          resolve,
          enqueuedAt: Date.now(),
          auth: cred,
          providerID: model.providerID,
          sessionID: opts?.sessionID,
          workerID: opts?.workerID,
        });
      });

      // Auto-flush if queue is full
      if (queue.length >= maxQueueSize) {
        flush().catch((e) => log.error("batch auto-flush error:", e));
      }

      return promise;
    },

    /**
     * Gracefully shut down the batch queue:
     * 1. Stop the flush timer
     * 2. Flush any remaining queued items (as a batch if possible, fallback sync)
     * 3. Switch to synchronous mode for future calls
     * 4. DON'T wait for inflight batches — they resolve eventually or expire
     */
    async shutdown(): Promise<void> {
      shuttingDown = true;
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      // Flush remaining items synchronously (batch API might not finish before process exits)
      if (queue.length > 0) {
        log.info(`batch shutdown: processing ${queue.length} remaining items synchronously`);
        await fallbackAll(queue.splice(0));
      }

      // Clean up inflight poll timers (batches will expire naturally)
      for (const [batchId, batch] of inflight) {
        clearInterval(batch.pollTimer);
        // Resolve all pending promises with null (callers handle null gracefully)
        for (const [, pending] of batch.requests) {
          pending.resolve(null);
        }
        log.warn(`batch shutdown: abandoned inflight batch ${batchId}`);
      }
      inflight.clear();
    },

    /** Return current batch queue statistics. */
    stats(): BatchStats {
      return {
        queued: queue.length,
        inflightBatches: inflight.size,
        inflightRequests: [...inflight.values()].reduce(
          (sum, b) => sum + b.requests.size,
          0,
        ),
        totalQueued,
        totalBatched,
        totalUrgent,
        totalFallback,
        totalResolved,
        totalFailed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stats type
// ---------------------------------------------------------------------------

export interface BatchStats {
  /** Items currently in the queue waiting for next flush. */
  queued: number;
  /** Number of batches currently being polled. */
  inflightBatches: number;
  /** Total requests across all inflight batches. */
  inflightRequests: number;
  /** Total requests that entered the queue. */
  totalQueued: number;
  /** Total requests successfully submitted to batch APIs (Anthropic + OpenAI). */
  totalBatched: number;
  /** Total requests that bypassed the queue (urgent). */
  totalUrgent: number;
  /** Total requests that fell back to synchronous processing. */
  totalFallback: number;
  /** Total batch results successfully resolved. */
  totalResolved: number;
  /** Total batch results that failed/expired/canceled. */
  totalFailed: number;
}
