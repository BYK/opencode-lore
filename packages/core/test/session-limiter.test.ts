import { describe, test, expect, beforeEach } from "bun:test";
import { distillLimiter, curatorLimiter } from "../src/session-limiter";

describe("session-limiter", () => {
  beforeEach(() => {
    distillLimiter.clear();
    curatorLimiter.clear();
  });

  test("serializes concurrent calls on the same key", async () => {
    const order: number[] = [];
    const limiter = distillLimiter.get("session-1");

    const p1 = limiter(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
    });
    const p2 = limiter(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2]);
    // p2 should only start after p1 finishes
    expect(order).toEqual([1, 2, 3]);
  });

  test("allows parallel calls on different keys", async () => {
    const order: string[] = [];
    const limiterA = distillLimiter.get("session-a");
    const limiterB = distillLimiter.get("session-b");

    const pA = limiterA(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });
    const pB = limiterB(async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-end");
    });

    await Promise.all([pA, pB]);
    // Both should start before either ends (parallel)
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  test("isBusy returns true when a task is active", async () => {
    expect(distillLimiter.isBusy("session-1")).toBe(false);

    let resolve: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });

    const p = distillLimiter.get("session-1")(async () => {
      await blocker;
    });

    // Give the microtask a tick to start
    await new Promise((r) => setTimeout(r, 0));
    expect(distillLimiter.isBusy("session-1")).toBe(true);

    resolve!();
    await p;
    expect(distillLimiter.isBusy("session-1")).toBe(false);
  });

  test("isBusy returns true when tasks are pending", async () => {
    let resolve1: () => void;
    const blocker1 = new Promise<void>((r) => { resolve1 = r; });
    const limiter = distillLimiter.get("session-1");

    const p1 = limiter(async () => { await blocker1; });
    const p2 = limiter(async () => { /* quick */ });

    await new Promise((r) => setTimeout(r, 0));
    expect(distillLimiter.isBusy("session-1")).toBe(true);

    resolve1!();
    await Promise.all([p1, p2]);
    expect(distillLimiter.isBusy("session-1")).toBe(false);
  });

  test("isBusy returns false for unknown key", () => {
    expect(distillLimiter.isBusy("unknown-session")).toBe(false);
  });

  test("propagates errors from the wrapped function", async () => {
    const limiter = distillLimiter.get("session-1");
    const p = limiter(async () => {
      throw new Error("test error");
    });
    await expect(p).rejects.toThrow("test error");
  });

  test("subsequent tasks run even if prior task threw", async () => {
    const limiter = distillLimiter.get("session-1");

    const p1 = limiter(async () => {
      throw new Error("first fails");
    }).catch(() => {});

    let secondRan = false;
    const p2 = limiter(async () => {
      secondRan = true;
    });

    await Promise.all([p1, p2]);
    expect(secondRan).toBe(true);
  });

  test("distill and curator limiters are independent", async () => {
    const order: string[] = [];
    let resolveDistill: () => void;
    const distillBlocker = new Promise<void>((r) => { resolveDistill = r; });

    const pd = distillLimiter.get("session-1")(async () => {
      order.push("distill-start");
      await distillBlocker;
      order.push("distill-end");
    });

    // Curator should not be blocked by distillation
    const pc = curatorLimiter.get("session-1")(async () => {
      order.push("curator-run");
    });

    await pc;
    expect(order).toContain("curator-run");
    // Distillation is still running
    expect(distillLimiter.isBusy("session-1")).toBe(true);

    resolveDistill!();
    await pd;
  });

  test("clear removes all limiters", () => {
    distillLimiter.get("a");
    distillLimiter.get("b");
    expect(distillLimiter.isBusy("a")).toBe(false); // exists but not busy
    distillLimiter.clear();
    // After clear, isBusy should return false (no limiter)
    expect(distillLimiter.isBusy("a")).toBe(false);
  });
});
