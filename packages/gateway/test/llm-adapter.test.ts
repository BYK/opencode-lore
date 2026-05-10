import { describe, test, expect } from "bun:test";
import { backoffMs, maxRetriesFor } from "../src/llm-adapter";

// ---------------------------------------------------------------------------
// maxRetriesFor — background (default)
// ---------------------------------------------------------------------------

describe("maxRetriesFor (background)", () => {
  test("returns 5 for 429 (rate limit)", () => {
    expect(maxRetriesFor(429)).toBe(5);
  });

  test("returns 3 for 5xx", () => {
    expect(maxRetriesFor(500)).toBe(3);
    expect(maxRetriesFor(502)).toBe(3);
    expect(maxRetriesFor(503)).toBe(3);
    expect(maxRetriesFor(529)).toBe(3);
  });

  test("returns 3 for null (network error)", () => {
    expect(maxRetriesFor(null)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// maxRetriesFor — urgent (synchronous, blocking the SSE response)
// ---------------------------------------------------------------------------

describe("maxRetriesFor (urgent)", () => {
  test("returns 2 regardless of status — short budget for blocking calls", () => {
    expect(maxRetriesFor(429, true)).toBe(2);
    expect(maxRetriesFor(500, true)).toBe(2);
    expect(maxRetriesFor(503, true)).toBe(2);
    expect(maxRetriesFor(null, true)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — Retry-After
// ---------------------------------------------------------------------------

describe("backoffMs — with Retry-After", () => {
  test("background: caps Retry-After at 120s", () => {
    expect(backoffMs(0, 300_000, 429)).toBe(120_000);
    expect(backoffMs(2, 200_000, 500)).toBe(120_000);
  });

  test("urgent: caps Retry-After at 8s", () => {
    expect(backoffMs(0, 60_000, 429, true)).toBe(8_000);
    expect(backoffMs(0, 120_000, 429, true)).toBe(8_000);
  });

  test("urgent: honors small Retry-After exactly (under cap)", () => {
    expect(backoffMs(0, 1000, 429, true)).toBe(1000);
    expect(backoffMs(0, 5000, 429, true)).toBe(5000);
  });

  test("background: honors small Retry-After values exactly", () => {
    expect(backoffMs(0, 1000, 429)).toBe(1000);
    expect(backoffMs(0, 100, 500)).toBe(100);
  });

  test("Retry-After honored regardless of status code", () => {
    expect(backoffMs(0, 10_000, 500)).toBe(10_000);
    expect(backoffMs(0, 10_000, null)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — 429 without Retry-After
// ---------------------------------------------------------------------------

describe("backoffMs — 429 without Retry-After", () => {
  test("background uses conservative delays: 30s, 45s, 60s, 60s, 60s", () => {
    expect(backoffMs(0, null, 429)).toBe(30_000);
    expect(backoffMs(1, null, 429)).toBe(45_000);
    expect(backoffMs(2, null, 429)).toBe(60_000);
    expect(backoffMs(3, null, 429)).toBe(60_000);
    expect(backoffMs(4, null, 429)).toBe(60_000);
  });

  test("urgent uses aggressive exponential: 1s, 2s, 4s (capped 4s)", () => {
    expect(backoffMs(0, null, 429, true)).toBe(1000);
    expect(backoffMs(1, null, 429, true)).toBe(2000);
    expect(backoffMs(2, null, 429, true)).toBe(4000);
    expect(backoffMs(3, null, 429, true)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — 5xx without Retry-After
// ---------------------------------------------------------------------------

describe("backoffMs — 5xx without Retry-After", () => {
  test("background: 1s, 2s, 4s, 8s (capped 8s)", () => {
    expect(backoffMs(0, null, 500)).toBe(1000);
    expect(backoffMs(1, null, 500)).toBe(2000);
    expect(backoffMs(2, null, 500)).toBe(4000);
    expect(backoffMs(3, null, 500)).toBe(8000);
    expect(backoffMs(10, null, 502)).toBe(8000);
  });

  test("urgent: 1s, 2s, 4s (capped 4s) — tighter than background", () => {
    expect(backoffMs(0, null, 500, true)).toBe(1000);
    expect(backoffMs(1, null, 500, true)).toBe(2000);
    expect(backoffMs(2, null, 500, true)).toBe(4000);
    expect(backoffMs(10, null, 502, true)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — network errors (null status)
// ---------------------------------------------------------------------------

describe("backoffMs — network errors", () => {
  test("background uses 1s, 2s, 4s exponential", () => {
    expect(backoffMs(0, null, null)).toBe(1000);
    expect(backoffMs(1, null, null)).toBe(2000);
    expect(backoffMs(2, null, null)).toBe(4000);
  });

  test("urgent uses the same exponential capped 4s", () => {
    expect(backoffMs(0, null, null, true)).toBe(1000);
    expect(backoffMs(1, null, null, true)).toBe(2000);
    expect(backoffMs(2, null, null, true)).toBe(4000);
    expect(backoffMs(5, null, null, true)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Total worst-case budget (regression guard for the OpenCode-hang report)
// ---------------------------------------------------------------------------

describe("worst-case urgent budget", () => {
  test("urgent 429 with Retry-After: 60 stays under ~25s end-to-end", () => {
    // 2 retries × max 8s honored from Retry-After = 16s of waits total.
    // Per-attempt fetch latency is bounded by Anthropic's own server timeout
    // (~10s on rate-limit reject), so total ≤ ~25s. This is the ceiling that
    // prevents OpenCode's SSE stream from looking hung.
    let total = 0;
    for (let attempt = 0; attempt < maxRetriesFor(429, true); attempt++) {
      total += backoffMs(attempt, 60_000, 429, true);
    }
    expect(total).toBeLessThanOrEqual(16_000);
  });

  test("background 429 with Retry-After: 60 budgets up to ~5min", () => {
    // Confirms the *background* budget is intentionally generous so that
    // distillation/curation can ride out a real rate-limit window.
    let total = 0;
    for (let attempt = 0; attempt < maxRetriesFor(429); attempt++) {
      total += backoffMs(attempt, 60_000, 429);
    }
    expect(total).toBe(300_000); // 5 retries × 60s
  });
});
