import { describe, test, expect } from "bun:test";
import { isContextOverflow, buildRecoveryMessage } from "../src/index";

describe("isContextOverflow", () => {
  test("detects Anthropic 'prompt is too long' error", () => {
    expect(isContextOverflow({
      message: "prompt is too long: 214636 tokens > 200000 maximum",
    })).toBe(true);
  });

  test("detects wrapped APIError shape (error.data.message)", () => {
    expect(isContextOverflow({
      name: "APIError",
      data: { message: "prompt is too long: 214636 tokens > 200000 maximum" },
    })).toBe(true);
  });

  test("detects OpenAI 'context length exceeded'", () => {
    expect(isContextOverflow({
      message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens. context length exceeded",
    })).toBe(true);
  });

  test("detects 'maximum context length'", () => {
    expect(isContextOverflow({
      message: "maximum context length exceeded",
    })).toBe(true);
  });

  test("detects 'too many tokens'", () => {
    expect(isContextOverflow({ message: "too many tokens" })).toBe(true);
  });

  test("detects 'ContextWindowExceededError'", () => {
    expect(isContextOverflow({
      message: "ContextWindowExceededError: request too large",
    })).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isContextOverflow({ message: "rate limit exceeded" })).toBe(false);
    expect(isContextOverflow({ message: "internal server error" })).toBe(false);
    expect(isContextOverflow({ name: "TimeoutError" })).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });
});

describe("buildRecoveryMessage", () => {
  test("includes distilled history when summaries exist", () => {
    const msg = buildRecoveryMessage([
      { observations: "Fixed the bug in auth.ts", generation: 0 },
    ]);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("</system-reminder>");
    expect(msg).toContain("context overflow error");
    expect(msg).toContain("Fixed the bug in auth.ts");
  });

  test("includes meta and recent sections from formatDistillations", () => {
    const msg = buildRecoveryMessage([
      { observations: "Earlier consolidated work", generation: 1 },
      { observations: "Recent detailed work", generation: 0 },
    ]);
    expect(msg).toContain("Earlier Work (summarized)");
    expect(msg).toContain("Recent Work (distilled)");
    expect(msg).toContain("Earlier consolidated work");
    expect(msg).toContain("Recent detailed work");
  });

  test("shows fallback message when no summaries available", () => {
    const msg = buildRecoveryMessage([]);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("No distilled history available");
  });
});
