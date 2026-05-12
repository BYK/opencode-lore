/**
 * Subprocess test runner for idle handler project isolation.
 *
 * Uses mock.module to replace @loreai/core — runs in a separate process
 * to avoid polluting other test files' module caches.
 *
 * Scenario is passed via IDLE_TEST_SCENARIO env var.
 * Exits 0 on success, 1 on failure (error on stderr).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { SessionState } from "../../src/translate/types";
import type { LLMClient } from "@loreai/core";

// ---------------------------------------------------------------------------
// Mocks — capture the projectPath passed to core modules
// ---------------------------------------------------------------------------

let capturedProjectPaths: string[] = [];

mock.module("@loreai/core", () => ({
  temporal: {
    undistilledCount: (projectPath: string) => {
      capturedProjectPaths.push(projectPath);
      return 0;
    },
    prune: (opts: { projectPath: string }) => {
      capturedProjectPaths.push(opts.projectPath);
      return { ttlDeleted: 0, capDeleted: 0 };
    },
  },
  distillation: {
    gen0Count: () => 0,
    run: async () => {},
    metaDistill: async () => {},
  },
  curator: {
    run: async () => ({ created: 0, updated: 0, deleted: 0 }),
    consolidate: async () => ({ updated: 0, deleted: 0 }),
  },
  ltm: {
    forProject: (projectPath: string) => {
      capturedProjectPaths.push(projectPath);
      return [];
    },
    cleanDeadRefs: () => 0,
  },
  latReader: {
    refresh: (projectPath: string) => {
      capturedProjectPaths.push(projectPath);
    },
  },
  log: {
    info: () => {},
    error: () => {},
    warn: () => {},
  },
  config: () => ({
    distillation: { metaThreshold: 20 },
    knowledge: { enabled: true },
    curator: { onIdle: false, afterTurns: 5, maxEntries: 25 },
    pruning: { retention: 30, maxStorage: 100 },
    agentsFile: { enabled: false, path: "AGENTS.md" },
  }),
  getLastTurnAt: () => null,
  exportToFile: () => {},
  exportLoreFile: () => {},
  saveSessionCosts: () => {},
  // Needed by transitive imports (cache-warmer.ts, cost-tracker.ts)
  db: () => ({}),
  projectId: () => undefined,
}));

// Mock cache-warmer (imported by idle.ts for warmup scheduling)
mock.module("../../src/cache-warmer", () => ({
  isCircuitBreakerTripped: () => false,
  resolveProfile: () => null,
  blendedHistogramForSession: () => null,
  shouldWarm: () => false,
  executeWarmup: async () => ({}),
  loadGlobalHistograms: () => {},
  flushGlobalHistograms: () => {},
}));

mock.module("../../src/worker-model", () => ({
  getWorkerModel: () => "claude-sonnet-4-20250514",
}));

mock.module("@sentry/bun", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
}));

mock.module("../../src/sentry", () => ({
  emitWarmupMetric: () => {},
  emitSessionCostMetrics: () => {},
  emitCurationMetrics: () => {},
}));

mock.module("../../src/cost-tracker", () => ({
  getSessionCosts: () => null,
  totalWorkerCost: () => 0,
}));

// Import AFTER mocks are set up
const { buildIdleWorkHandler } = await import("../../src/idle");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLLM(): LLMClient {
  return (async () => ({ type: "text", text: "" })) as unknown as LLMClient;
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionID: overrides.sessionID ?? "test-session",
    projectPath: overrides.projectPath ?? "/test/default/project",
    fingerprint: "",
    lastRequestTime: Date.now(),
    lastUserTurnTime: Date.now(),
    messageCount: 5,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    cacheAnalytics: {
      lastRequestBody: null,
      lastRequestBodyLength: 0,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 0,
      bustCount: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildIdleWorkHandler (isolated)", () => {
  beforeEach(() => {
    capturedProjectPaths = [];
  });

  test("uses state.projectPath for all core operations", async () => {
    const handler = buildIdleWorkHandler(makeLLM());
    const state = makeSessionState({ projectPath: "/correct/project/path" });

    await handler("session-1", state);

    expect(capturedProjectPaths.length).toBeGreaterThan(0);
    for (const captured of capturedProjectPaths) {
      expect(captured).toBe("/correct/project/path");
    }
  });

  test("different sessions use their own project paths", async () => {
    const handler = buildIdleWorkHandler(makeLLM());

    const stateA = makeSessionState({
      sessionID: "session-a",
      projectPath: "/project/alpha",
    });
    const stateB = makeSessionState({
      sessionID: "session-b",
      projectPath: "/project/beta",
    });

    capturedProjectPaths = [];
    await handler("session-a", stateA);
    const pathsA = [...capturedProjectPaths];

    capturedProjectPaths = [];
    await handler("session-b", stateB);
    const pathsB = [...capturedProjectPaths];

    expect(pathsA.length).toBeGreaterThan(0);
    for (const p of pathsA) {
      expect(p).toBe("/project/alpha");
    }

    expect(pathsB.length).toBeGreaterThan(0);
    for (const p of pathsB) {
      expect(p).toBe("/project/beta");
    }
  });
});
