import { describe, test, expect, beforeEach } from "bun:test";
import {
  runBackground,
  isBackgroundPaused,
  tripCircuitBreaker,
  resetBackgroundLimiter,
  backgroundLimiterStats,
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
    tripCircuitBreaker(0.1); // 100ms
    expect(isBackgroundPaused()).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(isBackgroundPaused()).toBe(false);
  });

  test("circuit breaker only extends, never shortens", () => {
    tripCircuitBreaker(10); // 10 seconds
    const stats1 = backgroundLimiterStats();

    tripCircuitBreaker(2); // 2 seconds — shorter, should be ignored
    const stats2 = backgroundLimiterStats();

    // Pause should still be ~10s, not shortened to ~2s
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
});
