import { describe, test, expect, mock } from "bun:test";
import { ensureProject } from "../../src/db";
import * as ltm from "../../src/ltm";
import { extractKnowledge } from "../../src/import/extract";
import type { ConversationChunk } from "../../src/import/types";
import type { LLMClient } from "../../src/types";

const PROJECT_PATH = "/test/extract-project";

function makeChunk(overrides: Partial<ConversationChunk> = {}): ConversationChunk {
  return {
    label: "Test chunk (1)",
    text: "[user] How do I fix the SQLITE_BUSY error?\n\n[assistant] Use WAL mode and set a busy_timeout.",
    estimatedTokens: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockLLM(response: string | null): LLMClient {
  return {
    prompt: mock(() => Promise.resolve(response)),
  };
}

describe("extractKnowledge", () => {
  test("setup: create test project", () => {
    ensureProject(PROJECT_PATH);
  });

  test("creates knowledge entries from LLM response", async () => {
    const llm = makeMockLLM(
      JSON.stringify([
        {
          op: "create",
          category: "gotcha",
          title: "SQLite WAL mode",
          content: "Always use WAL mode for concurrent access.",
          scope: "project",
          crossProject: true,
        },
      ]),
    );

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);

    // Verify entry was actually created
    const entries = ltm.forProject(PROJECT_PATH, false);
    const found = entries.find((e) => e.title === "SQLite WAL mode");
    expect(found).toBeDefined();
    expect(found!.category).toBe("gotcha");
  });

  test("handles empty LLM response", async () => {
    const llm = makeMockLLM("[]");

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);
  });

  test("handles null LLM response", async () => {
    const llm = makeMockLLM(null);

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);
  });

  test("handles LLM errors gracefully", async () => {
    const llm: LLMClient = {
      prompt: mock(() => Promise.reject(new Error("API error"))),
    };

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(0);
    expect(result.chunksFailed).toBe(1);
  });

  test("processes multiple chunks sequentially", async () => {
    const callOrder: number[] = [];
    let callCount = 0;
    const llm: LLMClient = {
      prompt: mock(async () => {
        callOrder.push(++callCount);
        return "[]";
      }),
    };

    const chunks = [
      makeChunk({ label: "Chunk 1", timestamp: 1000 }),
      makeChunk({ label: "Chunk 2", timestamp: 2000 }),
      makeChunk({ label: "Chunk 3", timestamp: 3000 }),
    ];

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks,
    });

    expect(result.chunksProcessed).toBe(3);
    // Should be called sequentially (in order)
    expect(callOrder).toEqual([1, 2, 3]);
  });

  test("reports progress via callback", async () => {
    const llm = makeMockLLM("[]");
    const progressUpdates: Array<{ current: number; total: number }> = [];

    await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk({ timestamp: 1 }), makeChunk({ timestamp: 2 })],
      onProgress: (p) => progressUpdates.push({ current: p.current, total: p.total }),
    });

    expect(progressUpdates).toEqual([
      { current: 1, total: 2 },
      { current: 2, total: 2 },
    ]);
  });

  test("sorts chunks chronologically before processing", async () => {
    const processedLabels: string[] = [];
    const llm: LLMClient = {
      prompt: mock(async (_sys: string, user: string) => {
        // Extract a label marker from the user prompt
        if (user.includes("CHUNK-A")) processedLabels.push("A");
        if (user.includes("CHUNK-B")) processedLabels.push("B");
        if (user.includes("CHUNK-C")) processedLabels.push("C");
        return "[]";
      }),
    };

    await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [
        makeChunk({ text: "CHUNK-C", timestamp: 3000 }),
        makeChunk({ text: "CHUNK-A", timestamp: 1000 }),
        makeChunk({ text: "CHUNK-B", timestamp: 2000 }),
      ],
    });

    expect(processedLabels).toEqual(["A", "B", "C"]);
  });
});
