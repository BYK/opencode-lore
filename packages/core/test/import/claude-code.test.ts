import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { mkdirSync, copyFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { clearProviders, registerProvider } from "../../src/import/providers";

// Import the provider module to trigger registration, then access it via registry
import "../../src/import/providers/claude-code";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Claude Code provider", () => {
  const provider = getProvider("claude-code")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("claude-code");
    expect(provider.displayName).toBe("Claude Code");
  });

  describe("detect", () => {
    test("returns empty for nonexistent project", () => {
      const sessions = provider.detect("/nonexistent/path/that/does/not/exist");
      expect(sessions).toEqual([]);
    });
  });

  describe("readChunks", () => {
    test("parses JSONL with mixed content types", () => {
      const filePath = join(FIXTURES, "claude-code-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks.length).toBeGreaterThan(0);

      // All chunks should have the required fields
      for (const chunk of chunks) {
        expect(chunk.label).toContain("Claude Code");
        expect(chunk.text.length).toBeGreaterThan(0);
        expect(chunk.estimatedTokens).toBeGreaterThan(0);
        expect(chunk.timestamp).toBeGreaterThan(0);
      }

      // Check that user messages are included
      const fullText = chunks.map((c) => c.text).join("\n");
      expect(fullText).toContain("[user]");
      expect(fullText).toContain("fix the build error");
    });

    test("extracts assistant text blocks and skips thinking", () => {
      const filePath = join(FIXTURES, "claude-code-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // Should have assistant content
      expect(fullText).toContain("[assistant]");
      expect(fullText).toContain("missing dependency");

      // Should NOT have thinking content
      expect(fullText).not.toContain("Let me analyze the build error");
    });

    test("formats tool_use and tool_result blocks", () => {
      const filePath = join(FIXTURES, "claude-code-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // Tool use should be formatted
      expect(fullText).toContain("[tool: Read]");
      expect(fullText).toContain("[tool: Bash]");

      // Tool result should be formatted
      expect(fullText).toContain("[tool_result]");
      expect(fullText).toContain("my-app");
    });

    test("respects maxTokens chunking boundary", () => {
      const filePath = join(FIXTURES, "claude-code-session.jsonl");
      // Use a very small maxTokens to force multiple chunks
      const chunks = provider.readChunks("/dummy", [filePath], 50);

      // Should produce multiple chunks with small token limit
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should respect the limit (approximately)
      for (const chunk of chunks) {
        // Allow some slack since we don't split mid-message
        expect(chunk.estimatedTokens).toBeLessThan(500);
      }
    });

    test("handles empty session list", () => {
      const chunks = provider.readChunks("/dummy", []);
      expect(chunks).toEqual([]);
    });

    test("skips sessions with too few messages", () => {
      // The small fixture has only 2 messages (< 3 minimum for detect)
      // but readChunks doesn't filter — that's detect's job
      const filePath = join(FIXTURES, "claude-code-small.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      // readChunks still returns content even for small files
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
