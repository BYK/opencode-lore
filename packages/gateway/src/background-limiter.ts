/**
 * Global concurrency limiter for background LLM work.
 *
 * Wraps fire-and-forget background LLM calls (idle distillation,
 * curation, pipeline-triggered incremental distillation) through a
 * single p-limit(2) so at most 2 background LLM operations run
 * concurrently across all sessions.
 *
 * Note: auto-import extraction (`import-auto.ts`) is NOT wrapped here —
 * it creates its own LLM client and runs sequentially per-process.
 * The circuit breaker still provides protection for import because
 * `tripCircuitBreaker` is called from `llm-adapter.ts` on any
 * non-urgent 429, and import uses the same adapter.
 *
 * Also provides a circuit breaker that trips on upstream 429 responses,
 * pausing all background work for the Retry-After period. This prevents
 * cascading retries from consuming the rate limit budget that
 * conversation turns need.
 */

import pLimit from "p-limit";
import { log } from "@loreai/core";

/** Global concurrency cap for background (non-urgent) LLM work. */
const BACKGROUND_CONCURRENCY = 2;

const limiter = pLimit(BACKGROUND_CONCURRENCY);

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/** Timestamp (ms) when the circuit breaker expires. 0 = not tripped. */
let circuitOpenUntil = 0;

/** Default pause duration when Retry-After header is absent (seconds). */
const DEFAULT_PAUSE_SECONDS = 60;

/**
 * Check if the circuit breaker is currently tripped.
 * Background work should check this before submitting to the limiter.
 */
export function isBackgroundPaused(): boolean {
  if (circuitOpenUntil === 0) return false;
  if (Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0; // auto-reset
    return false;
  }
  return true;
}

/**
 * Trip the circuit breaker. Called when any background LLM call
 * receives a 429. Pauses all background work for `pauseSeconds`.
 *
 * @param pauseSeconds Duration to pause. If 0 or omitted, uses default (60s).
 */
export function tripCircuitBreaker(pauseSeconds?: number): void {
  const duration =
    pauseSeconds && pauseSeconds > 0 ? pauseSeconds : DEFAULT_PAUSE_SECONDS;
  const until = Date.now() + duration * 1000;
  // Only extend, never shorten an active pause
  if (until > circuitOpenUntil) {
    circuitOpenUntil = until;
    log.warn(
      `background circuit breaker tripped: pausing all background work for ${duration}s`,
    );
  }
}

/**
 * Get remaining pause time in seconds (for diagnostics/logging).
 * Returns 0 if not paused.
 */
export function remainingPauseSeconds(): number {
  if (!isBackgroundPaused()) return 0;
  return Math.ceil((circuitOpenUntil - Date.now()) / 1000);
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

/**
 * Run a background task through the global concurrency limiter.
 *
 * If the circuit breaker is tripped, the task is skipped (returns undefined).
 * Otherwise, the task is queued behind the p-limit(2) gate.
 *
 * The circuit breaker is checked both at submission time (fast rejection)
 * and again when the task reaches the front of the queue (in case the
 * breaker tripped while the task was waiting).
 *
 * @param fn Async function to execute
 * @param label Human-readable label for logging (e.g., "idle session=abc")
 * @returns The function's return value, or undefined if skipped
 */
export async function runBackground<T>(
  fn: () => Promise<T>,
  label?: string,
): Promise<T | undefined> {
  if (isBackgroundPaused()) {
    if (label) {
      log.info(
        `background work skipped (circuit breaker, ${remainingPauseSeconds()}s remaining): ${label}`,
      );
    }
    return undefined;
  }
  return limiter(async () => {
    // Re-check after waiting in the queue — the breaker may have tripped
    // while this task was pending behind other in-flight work.
    if (isBackgroundPaused()) {
      if (label) {
        log.info(
          `background work skipped at execution (circuit breaker, ${remainingPauseSeconds()}s remaining): ${label}`,
        );
      }
      return undefined as T | undefined;
    }
    return fn();
  });
}

/**
 * Current limiter stats (for diagnostics).
 */
export function backgroundLimiterStats(): {
  activeCount: number;
  pendingCount: number;
  paused: boolean;
  pauseRemainingSeconds: number;
} {
  return {
    activeCount: limiter.activeCount,
    pendingCount: limiter.pendingCount,
    paused: isBackgroundPaused(),
    pauseRemainingSeconds: remainingPauseSeconds(),
  };
}

/**
 * Reset all state (for tests).
 *
 * Note: `clearQueue()` only removes pending (queued) tasks — up to 2
 * in-flight tasks will continue to completion. Pending tasks resolve
 * as `undefined`, consistent with the circuit breaker skip behavior.
 */
export function resetBackgroundLimiter(): void {
  limiter.clearQueue();
  circuitOpenUntil = 0;
}
