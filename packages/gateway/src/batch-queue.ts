/**
 * Batch queue for Anthropic Message Batches API.
 *
 * Wraps a synchronous LLMClient and intercepts non-urgent `prompt()` calls,
 * accumulating them in a queue. A flush timer periodically sends the queue
 * to Anthropic's `/v1/messages/batches` endpoint for 50% cost savings.
 * A poll timer checks for results and resolves the pending promises.
 *
 * Urgent calls (compaction, overflow recovery, query expansion) bypass
 * the queue entirely and delegate to the inner synchronous client.
 *
 * Auth credentials are snapshotted per-item at enqueue time and grouped
 * by credential at flush time — this ensures multi-session isolation when
 * multiple clients with different API keys are connected simultaneously.
 *
 * This is a gateway-only enhancement — the OpenCode and Pi adapters
 * always process immediately regardless of the `urgent` flag.
 */

import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";
import * as Sentry from "@sentry/bun";
import type { AuthCredential } from "./auth";
import { authHeaders } from "./auth";
import {
  setGenAiUsageAttributes,
  emitCostMetric,
  type AnthropicUsage,
} from "./sentry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single pending request waiting to be batched. */
interface PendingRequest {
  /** Unique ID for correlating batch results (alphanumeric + hyphens). */
  customId: string;
  /** Standard Messages API params. */
  params: {
    model: string;
    max_tokens: number;
    system:
      | string
      | Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
    messages: Array<{ role: string; content: string }>;
  };
  /** Resolve the caller's promise with the text response. */
  resolve: (value: string | null) => void;
  /** Reject the caller's promise on error. */
  reject: (error: Error) => void;
  /** Timestamp when the request was enqueued. */
  enqueuedAt: number;
  /** Auth credential snapshotted at enqueue time for per-session isolation. */
  auth: AuthCredential;
}

/** A batch that has been submitted and is being polled for results. */
interface InflightBatch {
  /** Anthropic batch ID returned by the create endpoint. */
  batchId: string;
  /** Map from custom_id → pending request (for resolving on completion). */
  requests: Map<string, PendingRequest>;
  /** Timestamp when the batch was submitted. */
  submittedAt: number;
  /** Poll timer handle. */
  pollTimer: ReturnType<typeof setInterval>;
  /** Auth credential for this batch (used for poll/retrieve calls). */
  auth: AuthCredential;
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

/** Produce a grouping key for an auth credential. */
function authKey(cred: AuthCredential): string {
  return `${cred.scheme}:${cred.value}`;
}

// ---------------------------------------------------------------------------
// BatchLLMClient
// ---------------------------------------------------------------------------

/**
 * Create a batch-aware LLMClient that wraps a synchronous inner client.
 *
 * - `urgent: true` calls → immediate delegation to `inner.prompt()`
 * - `urgent: false/undefined` calls → queued for batch processing
 * - On flush timer or queue full → POST /v1/messages/batches
 * - On poll timer → GET /v1/messages/batches/{id}, resolve promises
 * - On error → fallback to synchronous calls for the failed batch
 *
 * @param inner       The synchronous LLMClient (gateway's direct adapter)
 * @param upstreamUrl Base Anthropic API URL (e.g. "https://api.anthropic.com")
 * @param getAuth     Callback to resolve auth credentials (per-session → global fallback)
 * @param defaultModel Default model for requests without explicit model
 * @param batchConfig Optional tuning parameters
 */
export function createBatchLLMClient(
  inner: LLMClient,
  upstreamUrl: string,
  getAuth: (sessionID?: string) => AuthCredential | null,
  defaultModel: { providerID: string; modelID: string },
  batchConfig?: BatchQueueConfig,
): LLMClient & { shutdown: () => Promise<void>; stats: () => BatchStats } {
  const flushIntervalMs = batchConfig?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxQueueSize = batchConfig?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const pollIntervalMs = batchConfig?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxBatchAgeMs = batchConfig?.maxBatchAgeMs ?? DEFAULT_MAX_BATCH_AGE_MS;

  // State
  const queue: PendingRequest[] = [];
  const inflight = new Map<string, InflightBatch>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  /** Credentials whose batch API access has been permanently disabled (401/403). */
  const disabledBatchAuth = new Set<string>();

  // Stats
  let totalQueued = 0;
  let totalBatched = 0;
  let totalUrgent = 0;
  let totalFallback = 0;
  let totalResolved = 0;
  let totalFailed = 0;

  // -------------------------------------------------------------------------
  // Submit a single batch for one credential group
  // -------------------------------------------------------------------------

  async function submitBatch(auth: AuthCredential, items: PendingRequest[]): Promise<void> {
    const requests = items.map((item) => ({
      custom_id: item.customId,
      params: item.params,
    }));

    log.info(`batch flush: submitting ${items.length} requests`);

    try {
      const url = `${upstreamUrl.replace(/\/$/, "")}/v1/messages/batches`;
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
        // Permanent auth errors — disable batch API for this credential
        if (response.status === 401 || response.status === 403) {
          const key = authKey(auth);
          if (!disabledBatchAuth.has(key)) {
            disabledBatchAuth.add(key);
            log.warn(
              `batch API disabled for this credential (${response.status}): ${text}. ` +
                `Future worker calls will use individual requests.`,
            );
          }
        } else {
          log.error(`batch create failed: ${response.status} ${response.statusText} — ${text}`);
        }
        // Fall back to synchronous for all items
        await fallbackAll(items);
        return;
      }

      const data = (await response.json()) as {
        id: string;
        processing_status: string;
      };

      totalBatched += items.length;

      // Track inflight batch
      const requestMap = new Map<string, PendingRequest>();
      for (const item of items) {
        requestMap.set(item.customId, item);
      }

      const pollTimer = setInterval(
        () => pollBatch(data.id).catch((e) => log.error("batch poll error:", e)),
        pollIntervalMs,
      );

      inflight.set(data.id, {
        batchId: data.id,
        requests: requestMap,
        submittedAt: Date.now(),
        pollTimer,
        auth,
      });

      log.info(`batch created: ${data.id} with ${items.length} requests`);
    } catch (e) {
      log.error("batch create error:", e);
      await fallbackAll(items);
    }
  }

  // -------------------------------------------------------------------------
  // Flush: group queued items by credential, submit one batch per group
  // -------------------------------------------------------------------------

  async function flush(): Promise<void> {
    if (queue.length === 0) return;

    // Take all items from the queue
    const batch = queue.splice(0);

    // Group by auth credential — each credential gets its own batch
    const byAuth = new Map<string, { auth: AuthCredential; items: PendingRequest[] }>();
    for (const item of batch) {
      const key = authKey(item.auth);
      let group = byAuth.get(key);
      if (!group) {
        group = { auth: item.auth, items: [] };
        byAuth.set(key, group);
      }
      group.items.push(item);
    }

    for (const { auth, items } of byAuth.values()) {
      // Skip batch API for credentials with permanent auth failures
      if (disabledBatchAuth.has(authKey(auth))) {
        await fallbackAll(items);
        continue;
      }
      await submitBatch(auth, items);
    }
  }

  // -------------------------------------------------------------------------
  // Poll: check batch status and resolve promises
  // -------------------------------------------------------------------------

  async function pollBatch(batchId: string): Promise<void> {
    const batch = inflight.get(batchId);
    if (!batch) return;

    // Check max age — give up and fallback if too old
    if (Date.now() - batch.submittedAt > maxBatchAgeMs) {
      log.warn(`batch ${batchId} exceeded max age — falling back to synchronous`);
      clearInterval(batch.pollTimer);
      inflight.delete(batchId);
      await fallbackAll([...batch.requests.values()]);
      return;
    }

    try {
      const url = `${upstreamUrl.replace(/\/$/, "")}/v1/messages/batches/${batchId}`;
      const response = await fetch(url, {
        headers: {
          "anthropic-version": "2023-06-01",
          ...authHeaders(batch.auth),
        },
      });

      if (!response.ok) {
        log.error(`batch poll failed for ${batchId}: ${response.status}`);
        return; // Retry on next poll
      }

      const data = (await response.json()) as {
        processing_status: string;
        results_url: string | null;
      };

      if (data.processing_status !== "ended") return;

      // Batch is done — stream results
      log.info(`batch ${batchId} ended — retrieving results`);

      if (data.results_url) {
        await retrieveResults(batchId, data.results_url);
      } else {
        // No results URL — try the standard endpoint
        await retrieveResults(
          batchId,
          `${upstreamUrl.replace(/\/$/, "")}/v1/messages/batches/${batchId}/results`,
        );
      }
    } catch (e) {
      log.error(`batch poll error for ${batchId}:`, e);
    }
  }

  async function retrieveResults(batchId: string, resultsUrl: string): Promise<void> {
    const batch = inflight.get(batchId);
    if (!batch) return;

    try {
      const response = await fetch(resultsUrl, {
        headers: {
          "anthropic-version": "2023-06-01",
          ...authHeaders(batch.auth),
        },
      });

      if (!response.ok) {
        log.error(`batch results fetch failed for ${batchId}: ${response.status}`);
        return;
      }

      const text = await response.text();
      // Results are JSONL — one JSON object per line
      const lines = text.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const result = JSON.parse(line) as {
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

          const pending = batch.requests.get(result.custom_id);
          if (!pending) continue;

          switch (result.result.type) {
            case "succeeded": {
              const msg = result.result.message;
              const textBlock = msg?.content?.find(
                (b) => b.type === "text" && typeof b.text === "string",
              );

              // Emit gen_ai.chat span for batch result with usage + queue time
              if (Sentry.isInitialized() && msg?.usage) {
                Sentry.startSpan(
                  {
                    op: "gen_ai.chat",
                    name: `chat ${pending.params.model}`,
                    attributes: {
                      "gen_ai.operation.name": "chat",
                      "gen_ai.request.model": pending.params.model,
                      "gen_ai.provider.name": "anthropic",
                      "lore.call_type": "batch",
                      "lore.batch_queue_ms": Date.now() - pending.enqueuedAt,
                    },
                  },
                  (span) => {
                    setGenAiUsageAttributes(span, msg.usage!, msg.model);
                  },
                );
                emitCostMetric(pending.params.model, msg.usage, "batch");
              }

              pending.resolve(textBlock?.text ?? null);
              totalResolved++;
              break;
            }
            case "errored":
              pending.resolve(null); // Match inner client behavior (null on error)
              totalFailed++;
              log.error(
                `batch item ${result.custom_id} errored: ${result.result.error?.type ?? "unknown"} — ${result.result.error?.message ?? JSON.stringify(result.result.error)}`,
              );
              break;
            case "canceled":
            case "expired":
              pending.resolve(null);
              totalFailed++;
              log.warn(`batch item ${result.custom_id} ${result.result.type}`);
              break;
          }

          batch.requests.delete(result.custom_id);
        } catch {
          log.error(`failed to parse batch result line: ${line.slice(0, 200)}`);
        }
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
      log.error(`batch results retrieval error for ${batchId}:`, e);
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
            const result = await inner.prompt(system, user, { urgent: true });
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
        : system;

      const customId = generateCustomId();

      const promise = new Promise<string | null>((resolve, reject) => {
        queue.push({
          customId,
          params: {
            model: model.modelID,
            max_tokens: 8192,
            system: systemPayload ?? system,
            messages: [{ role: "user", content: user }],
          },
          resolve,
          reject,
          enqueuedAt: Date.now(),
          auth: cred,
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
  /** Total requests successfully submitted to the Batch API. */
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
