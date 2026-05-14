import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { clearProviders, registerProvider, getProviders } from "../../src/import/providers";
import { detectAll } from "../../src/import/detect";
import type { AgentHistoryProvider, DetectedSession } from "../../src/import/types";

function makeSession(overrides: Partial<DetectedSession> = {}): DetectedSession {
  return {
    id: "sess-1",
    label: "Test session",
    startedAt: Date.now() - 3600_000,
    lastActivityAt: Date.now(),
    estimatedTokens: 5000,
    messageCount: 20,
    ...overrides,
  };
}

function makeProvider(
  name: string,
  sessions: DetectedSession[] = [],
): AgentHistoryProvider {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    detect: () => sessions,
    readChunks: () => [],
  };
}

describe("detectAll", () => {
  // Save and restore the global provider registry around each test
  // to avoid polluting other test files that depend on auto-registered providers.
  let savedProviders: readonly AgentHistoryProvider[] = [];
  beforeEach(() => {
    savedProviders = [...getProviders()];
    clearProviders();
  });
  afterEach(() => {
    clearProviders();
    for (const p of savedProviders) registerProvider(p);
  });

  test("returns empty when no providers are registered", () => {
    const results = detectAll("/some/path");
    expect(results).toEqual([]);
  });

  test("returns empty when no providers have sessions", () => {
    registerProvider(makeProvider("agent-a", []));
    registerProvider(makeProvider("agent-b", []));
    const results = detectAll("/some/path");
    expect(results).toEqual([]);
  });

  test("aggregates results from multiple providers", () => {
    registerProvider(makeProvider("agent-a", [makeSession({ id: "a1", messageCount: 10 })]));
    registerProvider(makeProvider("agent-b", [
      makeSession({ id: "b1", messageCount: 30 }),
      makeSession({ id: "b2", messageCount: 20 }),
    ]));

    const results = detectAll("/some/path");
    expect(results.length).toBe(2);
    // Sorted by totalMessages descending
    expect(results[0].agentName).toBe("agent-b");
    expect(results[0].totalMessages).toBe(50);
    expect(results[1].agentName).toBe("agent-a");
    expect(results[1].totalMessages).toBe(10);
  });

  test("skips providers that throw during detection", () => {
    const failing: AgentHistoryProvider = {
      name: "failing",
      displayName: "Failing",
      detect: () => {
        throw new Error("Provider broke");
      },
      readChunks: () => [],
    };
    registerProvider(failing);
    registerProvider(makeProvider("working", [makeSession({ messageCount: 5 })]));

    const results = detectAll("/some/path");
    expect(results.length).toBe(1);
    expect(results[0].agentName).toBe("working");
  });

  test("computes totalTokens from sessions", () => {
    registerProvider(makeProvider("agent", [
      makeSession({ estimatedTokens: 1000 }),
      makeSession({ estimatedTokens: 2000, id: "s2" }),
    ]));

    const results = detectAll("/some/path");
    expect(results[0].totalTokens).toBe(3000);
  });
});
