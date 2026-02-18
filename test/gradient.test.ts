import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db, close, ensureProject } from "../src/db";
import { transform, setModelLimits } from "../src/gradient";
import type { Message, Part } from "@opencode-ai/sdk";

const PROJECT = "/test/gradient/project";

function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID = "grad-sess",
): { info: Message; parts: Part[] } {
  const info: Message =
    role === "user"
      ? {
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }
      : {
          id,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `parent-${id}`,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };
  return {
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

beforeAll(() => {
  ensureProject(PROJECT);
  // Set a small context for testing
  setModelLimits({ context: 10_000, output: 2_000 });
});

afterAll(() => close());

describe("gradient", () => {
  test("passes through small message sets (Layer 1)", () => {
    const messages = [
      makeMsg("g-1", "user", "Hello, how are you?"),
      makeMsg("g-2", "assistant", "I'm ready to help."),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBe(1);
    // Messages should be passed through as-is (no distillations exist)
    expect(result.messages.length).toBe(2);
  });

  test("handles many messages without crashing (Layer 1-2)", () => {
    const messages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(
        `bulk-${i}`,
        role as "user" | "assistant",
        `Message content number ${i} with some padding text to take up token space.`,
      );
    });
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
    expect(result.layer).toBeLessThanOrEqual(4);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("Layer 4 nuclear always fits", () => {
    // Each message ~1100 tokens. With 1500 usable and rawBudget = 600,
    // even a single message exceeds the budget, forcing escalation to Layer 4.
    const messages = Array.from({ length: 10 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"detailed content about various topics and implementation details that span across multiple concerns ".repeat(40)}`;
      return makeMsg(`nuclear-${i}`, role as "user" | "assistant", text);
    });
    setModelLimits({ context: 2_000, output: 500 }); // 1500 usable, rawBudget ~600
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);
    expect(result.messages.length).toBeLessThanOrEqual(6); // layer 4: up to 3 prefix + 3 raw
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
  });

  test("returns valid token estimates", () => {
    const messages = [
      makeMsg("tok-1", "user", "Test message"),
      makeMsg("tok-2", "assistant", "Response message"),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.rawTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.distilledTokens + result.rawTokens);
  });
});
