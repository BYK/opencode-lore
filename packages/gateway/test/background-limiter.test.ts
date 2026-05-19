import { describe, test, expect, beforeEach } from "bun:test";
import {
  runBackground,
  isBackgroundPaused,
  tripCircuitBreaker,
  resetBackgroundLimiter,
  backgroundLimiterStats,
  getConsecutiveTrips,
  BACKOFF_SCHEDULE,
  _tripRaw,
} from "../src/background-limiter";

describe("background-limiter", () => {
  beforeEach(() => resetBackgroundLimiter());

  test("limits concurrency to 2", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      runBackground(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 50));
        current--;
        return i;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("returns task result when not paused", async () => {
    const result = await runBackground(async () => 42);
    expect(result).toBe(42);
  });

  test("circuit breaker skips work when tripped", async () => {
    tripCircuitBreaker(10); // 10 seconds
    expect(isBackgroundPaused()).toBe(true);

    let called = false;
    const result = await runBackground(async () => {
      called = true;
      return "done";
    });

    expect(called).toBe(false);
    expect(result).toBeUndefined();
  });

  test("circuit breaker auto-resets after duration", async () => {
    _tripRaw(0.1); // 100ms — bypasses escalation schedule for test speed
    expect(isBackgroundPaused()).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(isBackgroundPaused()).toBe(false);
  });

  test("circuit breaker only extends, never shortens", () => {
    // First trip: max(600, schedule[0]=60) = 600s
    tripCircuitBreaker(600);
    const stats1 = backgroundLimiterStats();

    // Second trip: max(2, schedule[1]=120) = 120s — shorter than 600s, should be ignored
    tripCircuitBreaker(2);
    const stats2 = backgroundLimiterStats();

    // Pause should still be ~600s, not shortened
    expect(stats2.pauseRemainingSeconds).toBeGreaterThanOrEqual(
      stats1.pauseRemainingSeconds - 1,
    );
  });

  test("stats reflect active/pending counts", async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    const task1 = runBackground(() => blocker);
    const task2 = runBackground(() => blocker);
    const task3 = runBackground(async () => {});

    // Allow event loop to process
    await new Promise((r) => setTimeout(r, 10));

    const stats = backgroundLimiterStats();
    expect(stats.activeCount).toBe(2);
    expect(stats.pendingCount).toBe(1);
    expect(stats.paused).toBe(false);

    resolve();
    await Promise.all([task1, task2, task3]);
  });

  test("not paused by default", () => {
    expect(isBackgroundPaused()).toBe(false);
    expect(backgroundLimiterStats().paused).toBe(false);
  });

  test("propagates task errors", async () => {
    const err = new Error("boom");
    await expect(
      runBackground(async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");
  });

  test("skips queued tasks when circuit breaker trips while waiting", async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    // Fill both concurrency slots
    const task1 = runBackground(() => blocker);
    const task2 = runBackground(() => blocker);

    // Queue a third task — it will wait
    let thirdCalled = false;
    const task3 = runBackground(async () => {
      thirdCalled = true;
      return "done";
    });

    // Trip the circuit breaker while task3 is queued
    await new Promise((r) => setTimeout(r, 10));
    tripCircuitBreaker(10);

    // Release the blockers — task3 should now execute but be skipped
    resolve();
    const results = await Promise.all([task1, task2, task3]);

    expect(thirdCalled).toBe(false);
    expect(results[2]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Escalating backoff
  // ---------------------------------------------------------------------------

  test("consecutive trips produce escalating durations", () => {
    // Each trip should use the next entry in BACKOFF_SCHEDULE
    for (let i = 0; i < BACKOFF_SCHEDULE.length; i++) {
      tripCircuitBreaker();
      expect(getConsecutiveTrips()).toBe(i + 1);
      // The pause should be at least the scheduled duration
      const remaining = backgroundLimiterStats().pauseRemainingSeconds;
      expect(remaining).toBeGreaterThanOrEqual(BACKOFF_SCHEDULE[i] - 1);
    }

    // Beyond the schedule, stays at the last (max) value
    tripCircuitBreaker();
    expect(getConsecutiveTrips()).toBe(BACKOFF_SCHEDULE.length + 1);
    const remaining = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining).toBeGreaterThanOrEqual(
      BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] - 1,
    );
  });

  test("consecutiveTrips resets after breaker naturally expires", async () => {
    // Use tripCircuitBreaker to increment consecutiveTrips, then override
    // the actual pause duration with _tripRaw for test speed.
    tripCircuitBreaker(); // sets consecutiveTrips = 1
    expect(getConsecutiveTrips()).toBe(1);
    _tripRaw(0.1); // override to 100ms pause

    await new Promise((r) => setTimeout(r, 150));

    // Checking isBackgroundPaused triggers the reset
    expect(isBackgroundPaused()).toBe(false);
    expect(getConsecutiveTrips()).toBe(0);
  });

  test("retryAfterSeconds respects escalation via max()", () => {
    // First trip: schedule says 60s, but server says 10s → use 60s
    tripCircuitBreaker(10);
    const remaining1 = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining1).toBeGreaterThanOrEqual(59);

    // Reset and trip again with server saying 300s (higher than schedule)
    resetBackgroundLimiter();
    tripCircuitBreaker(300);
    const remaining2 = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining2).toBeGreaterThanOrEqual(299);
  });

  test("resetBackgroundLimiter clears consecutiveTrips", () => {
    tripCircuitBreaker();
    tripCircuitBreaker();
    expect(getConsecutiveTrips()).toBe(2);

    resetBackgroundLimiter();
    expect(getConsecutiveTrips()).toBe(0);
    expect(isBackgroundPaused()).toBe(false);
  });
});
