/**
 * Per-key concurrency limiter using p-limit.
 *
 * Each key (typically a session ID) gets its own p-limit(1) instance,
 * serializing async operations on the same key while allowing different
 * keys to run fully in parallel.
 *
 * Two independent limiter pools are provided — one for distillation and
 * one for curation — so they don't block each other.
 */

import pLimit from "p-limit";

type LimitFunction = ReturnType<typeof pLimit>;

function createLimiterPool() {
  const limiters = new Map<string, LimitFunction>();

  /** Get or create a p-limit(1) limiter for the given key. */
  function get(key: string): LimitFunction {
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = pLimit(1);
      limiters.set(key, limiter);
    }
    return limiter;
  }

  /** Check if a limiter for `key` is currently busy (active or pending work). */
  function isBusy(key: string): boolean {
    const limiter = limiters.get(key);
    return limiter ? limiter.activeCount + limiter.pendingCount > 0 : false;
  }

  /** Clear all limiters (for test cleanup). */
  function clear(): void {
    limiters.clear();
  }

  return { get, isBusy, clear };
}

/** Serializes distillation.run() and metaDistill() per session. */
export const distillLimiter = createLimiterPool();

/** Serializes curator.run() per session with skip-if-busy semantics. */
export const curatorLimiter = createLimiterPool();
