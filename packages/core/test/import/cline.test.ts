import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdirSync, copyFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

import "../../src/import/providers/cline";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Cline provider", () => {
  const provider = getProvider("cline")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("cline");
    expect(provider.displayName).toBe("Cline");
  });

  describe("detect", () => {
    test("returns empty for nonexistent project", () => {
      // Cline detect looks in VS Code globalStorage, which won't have this path
      const sessions = provider.detect("/nonexistent/path/that/does/not/exist");
      expect(sessions).toEqual([]);
    });
  });

  describe("readChunks", () => {
    test("parses Anthropic MessageParam format", () => {
      // Create a mock task directory with the fixture
      const tmp = join(tmpdir(), `lore-cline-test-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      copyFileSync(
        join(FIXTURES, "cline-conversation.json"),
        join(tmp, "api_conversation_history.json"),
      );

      const chunks = provider.readChunks("/dummy", [tmp]);

      expect(chunks.length).toBeGreaterThan(0);

      const fullText = chunks.map((c) => c.text).join("\n");

      // Should have both roles
      expect(fullText).toContain("[user]");
      expect(fullText).toContain("[assistant]");

      // Content
      expect(fullText).toContain("input validation");
      expect(fullText).toContain("zod schema validation");
    });

    test("formats tool_use and tool_result blocks", () => {
      const tmp = join(tmpdir(), `lore-cline-tools-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      copyFileSync(
        join(FIXTURES, "cline-conversation.json"),
        join(tmp, "api_conversation_history.json"),
      );

      const chunks = provider.readChunks("/dummy", [tmp]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // Tool use
      expect(fullText).toContain("[tool: read_file]");

      // Tool result
      expect(fullText).toContain("[tool_result]");
      expect(fullText).toContain("SignupForm");
    });

    test("handles empty task directory", () => {
      const tmp = join(tmpdir(), `lore-cline-empty-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });

      const chunks = provider.readChunks("/dummy", [tmp]);
      expect(chunks).toEqual([]);
    });

    test("respects maxTokens chunking", () => {
      const tmp = join(tmpdir(), `lore-cline-chunk-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      copyFileSync(
        join(FIXTURES, "cline-conversation.json"),
        join(tmp, "api_conversation_history.json"),
      );

      const chunks = provider.readChunks("/dummy", [tmp], 30);
      expect(chunks.length).toBeGreaterThan(1);
    });

    test("chunk label contains Cline", () => {
      const tmp = join(tmpdir(), `lore-cline-label-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      copyFileSync(
        join(FIXTURES, "cline-conversation.json"),
        join(tmp, "api_conversation_history.json"),
      );

      const chunks = provider.readChunks("/dummy", [tmp]);
      expect(chunks[0].label).toContain("Cline");
    });
  });
});
