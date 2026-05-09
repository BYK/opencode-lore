import { describe, test, expect } from "bun:test";
import { backoffMs, maxRetriesFor } from "../src/llm-adapter";

// ---------------------------------------------------------------------------
// maxRetriesFor
// ---------------------------------------------------------------------------

describe("maxRetriesFor", () => {
  test("returns 5 for 429 (rate limit)", () => {
    expect(maxRetriesFor(429)).toBe(5);
  });

  test("returns 3 for 500 (server error)", () => {
    expect(maxRetriesFor(500)).toBe(3);
  });

  test("returns 3 for 502", () => {
    expect(maxRetriesFor(502)).toBe(3);
  });

  test("returns 3 for 503", () => {
    expect(maxRetriesFor(503)).toBe(3);
  });

  test("returns 3 for 529 (overloaded)", () => {
    expect(maxRetriesFor(529)).toBe(3);
  });

  test("returns 3 for null (network error)", () => {
    expect(maxRetriesFor(null)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

describe("backoffMs", () => {
  describe("with Retry-After", () => {
    test("honors Retry-After on any attempt", () => {
      expect(backoffMs(0, 5000, 429)).toBe(5000);
      expect(backoffMs(1, 5000, 429)).toBe(5000);
      expect(backoffMs(3, 5000, 429)).toBe(5000);
    });

    test("caps Retry-After at 120s", () => {
      expect(backoffMs(0, 300_000, 429)).toBe(120_000);
      expect(backoffMs(2, 200_000, 500)).toBe(120_000);
    });

    test("honors small Retry-After values exactly", () => {
      expect(backoffMs(0, 1000, 429)).toBe(1000);
      expect(backoffMs(0, 100, 500)).toBe(100);
    });

    test("honors Retry-After regardless of status code", () => {
      expect(backoffMs(0, 10_000, 500)).toBe(10_000);
      expect(backoffMs(0, 10_000, 503)).toBe(10_000);
      expect(backoffMs(0, 10_000, null)).toBe(10_000);
    });
  });

  describe("429 without Retry-After", () => {
    test("uses conservative delays: 30s, 45s, 60s, 60s, 60s", () => {
      expect(backoffMs(0, null, 429)).toBe(30_000);
      expect(backoffMs(1, null, 429)).toBe(45_000);
      expect(backoffMs(2, null, 429)).toBe(60_000);
      expect(backoffMs(3, null, 429)).toBe(60_000);
      expect(backoffMs(4, null, 429)).toBe(60_000);
    });
  });

  describe("5xx without Retry-After", () => {
    test("uses aggressive exponential backoff: 1s, 2s, 4s, 8s", () => {
      expect(backoffMs(0, null, 500)).toBe(1000);
      expect(backoffMs(1, null, 500)).toBe(2000);
      expect(backoffMs(2, null, 500)).toBe(4000);
      expect(backoffMs(3, null, 500)).toBe(8000);
    });

    test("caps at 8s", () => {
      expect(backoffMs(4, null, 500)).toBe(8000);
      expect(backoffMs(10, null, 502)).toBe(8000);
    });
  });

  describe("network errors (null status)", () => {
    test("uses aggressive exponential backoff", () => {
      expect(backoffMs(0, null, null)).toBe(1000);
      expect(backoffMs(1, null, null)).toBe(2000);
      expect(backoffMs(2, null, null)).toBe(4000);
    });
  });
});
