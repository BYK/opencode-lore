import { describe, test, expect, mock, beforeEach } from "bun:test";
import { buildIdleWorkHandler } from "../src/idle";
import type { SessionState } from "../src/translate/types";
import type { LLMClient } from "@loreai/core";

// ---------------------------------------------------------------------------
// Mocks — capture the projectPath passed to core modules
// ---------------------------------------------------------------------------

// Track projectPath arguments passed to core functions
let capturedProjectPaths: string[] = [];

// Mock @loreai/core — we only need to capture projectPath arguments
mock.module("@loreai/core", () => ({
  temporal: {
    undistilledCount: (projectPath: string) => {
      capturedProjectPaths.push(projectPath);
      return 0; // no pending messages — skip distillation
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
      return []; // no entries
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
}));

// Mock worker-model
mock.module("../src/worker-model", () => ({
  getWorkerModel: () => "claude-sonnet-4-20250514",
}));

// Mock Sentry
mock.module("@sentry/bun", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
}));

// Mock sentry metrics
mock.module("../src/sentry", () => ({
  emitWarmupMetric: () => {},
  emitSessionCostMetrics: () => {},
  emitCurationMetrics: () => {},
}));

// Mock cost-tracker
mock.module("../src/cost-tracker", () => ({
  getSessionCosts: () => null,
  totalWorkerCost: () => 0,
}));

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

describe("buildIdleWorkHandler", () => {
  beforeEach(() => {
    capturedProjectPaths = [];
  });

  test("uses state.projectPath for all core operations", async () => {
    const handler = buildIdleWorkHandler(makeLLM());
    const state = makeSessionState({ projectPath: "/correct/project/path" });

    await handler("session-1", state);

    // Every captured projectPath should be the state's path
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

    // Run idle work for session A
    capturedProjectPaths = [];
    await handler("session-a", stateA);
    const pathsA = [...capturedProjectPaths];

    // Run idle work for session B
    capturedProjectPaths = [];
    await handler("session-b", stateB);
    const pathsB = [...capturedProjectPaths];

    // Session A should only use alpha
    expect(pathsA.length).toBeGreaterThan(0);
    for (const p of pathsA) {
      expect(p).toBe("/project/alpha");
    }

    // Session B should only use beta
    expect(pathsB.length).toBeGreaterThan(0);
    for (const p of pathsB) {
      expect(p).toBe("/project/beta");
    }
  });
});
