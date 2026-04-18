import { describe, test, expect } from "bun:test";
import { workerSessionIDs, isWorkerSession } from "../src/worker";
import { parseSourceIds } from "../src/distillation";

// ---------------------------------------------------------------------------
// workerSessionIDs / isWorkerSession tests
// ---------------------------------------------------------------------------

describe("workerSessionIDs", () => {
  test("isWorkerSession returns false for unknown sessions", () => {
    expect(isWorkerSession("unknown-session")).toBe(false);
  });

  test("isWorkerSession returns true after adding to workerSessionIDs", () => {
    const id = "test-worker-" + crypto.randomUUID();
    workerSessionIDs.add(id);
    expect(isWorkerSession(id)).toBe(true);
    // Cleanup
    workerSessionIDs.delete(id);
  });
});

// ---------------------------------------------------------------------------
// parseSourceIds tests
// ---------------------------------------------------------------------------

describe("parseSourceIds", () => {
  test("valid JSON array", () => {
    expect(parseSourceIds('["a","b","c"]')).toEqual(["a", "b", "c"]);
  });

  test("empty array", () => {
    expect(parseSourceIds("[]")).toEqual([]);
  });

  test("empty string — returns []", () => {
    expect(parseSourceIds("")).toEqual([]);
  });

  test("malformed JSON — returns []", () => {
    expect(parseSourceIds("{not valid")).toEqual([]);
  });

  test("non-array JSON (object) — returns []", () => {
    expect(parseSourceIds('{"key": "value"}')).toEqual([]);
  });

  test("non-array JSON (string) — returns []", () => {
    expect(parseSourceIds('"just a string"')).toEqual([]);
  });

  test("non-array JSON (number) — returns []", () => {
    expect(parseSourceIds("42")).toEqual([]);
  });
});
