import { describe, test, expect } from "bun:test";
import { join } from "path";

import "../../src/import/providers/codex";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Codex provider", () => {
  const provider = getProvider("codex")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
  });

  describe("detect", () => {
    test("returns empty for nonexistent project", () => {
      const sessions = provider.detect("/nonexistent/path/that/does/not/exist");
      expect(sessions).toEqual([]);
    });
  });

  describe("readChunks", () => {
    test("parses JSONL with session_meta and response_items", () => {
      const filePath = join(FIXTURES, "codex-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks.length).toBeGreaterThan(0);

      const fullText = chunks.map((c) => c.text).join("\n");

      // Should have user and assistant content
      expect(fullText).toContain("[user]");
      expect(fullText).toContain("[assistant]");
      expect(fullText).toContain("TypeScript");
    });

    test("formats function calls and outputs", () => {
      const filePath = join(FIXTURES, "codex-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // Tool calls
      expect(fullText).toContain("[tool: shell]");

      // Tool outputs
      expect(fullText).toContain("[tool_result]");
      expect(fullText).toContain("package.json");
    });

    test("includes event_msg exec output", () => {
      const filePath = join(FIXTURES, "codex-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      expect(fullText).toContain("[exec]");
      expect(fullText).toContain("added 2 packages");
    });

    test("respects maxTokens chunking", () => {
      const filePath = join(FIXTURES, "codex-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath], 30);

      expect(chunks.length).toBeGreaterThan(1);
    });

    test("handles empty session list", () => {
      const chunks = provider.readChunks("/dummy", []);
      expect(chunks).toEqual([]);
    });

    test("chunk label contains Codex and date", () => {
      const filePath = join(FIXTURES, "codex-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks[0].label).toContain("Codex");
      expect(chunks[0].label).toContain("2025-05-10");
    });
  });
});
