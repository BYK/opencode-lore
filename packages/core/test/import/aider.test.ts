import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdirSync, copyFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

import "../../src/import/providers/aider";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Aider provider", () => {
  const provider = getProvider("aider")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("aider");
    expect(provider.displayName).toBe("Aider");
  });

  describe("detect", () => {
    test("returns empty for directory without .aider.chat.history.md", () => {
      const sessions = provider.detect("/nonexistent/path");
      expect(sessions).toEqual([]);
    });

    test("detects history file in project directory", () => {
      // Create a temp dir with the fixture
      const tmp = join(tmpdir(), `lore-aider-test-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      copyFileSync(
        join(FIXTURES, "aider-history.md"),
        join(tmp, ".aider.chat.history.md"),
      );

      const sessions = provider.detect(tmp);
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(join(tmp, ".aider.chat.history.md"));
      expect(sessions[0].messageCount).toBe(6); // 3 user + 3 assistant
    });

    test("skips empty history file", () => {
      const tmp = join(tmpdir(), `lore-aider-empty-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(tmp, ".aider.chat.history.md"), "");

      const sessions = provider.detect(tmp);
      expect(sessions).toEqual([]);
    });

    test("skips file with too few messages", () => {
      const tmp = join(tmpdir(), `lore-aider-tiny-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      writeFileSync(
        join(tmp, ".aider.chat.history.md"),
        "#### user\nHello\n\n#### assistant\nHi!\n",
      );

      const sessions = provider.detect(tmp);
      expect(sessions).toEqual([]); // Only 2 messages, need >= 3
    });
  });

  describe("readChunks", () => {
    test("parses markdown conversation into chunks", () => {
      const filePath = join(FIXTURES, "aider-history.md");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks.length).toBeGreaterThan(0);

      const fullText = chunks.map((c) => c.text).join("\n");

      // Should have both roles
      expect(fullText).toContain("[user]");
      expect(fullText).toContain("[assistant]");

      // Should have conversation content
      expect(fullText).toContain("error handling");
      expect(fullText).toContain("DatabaseError");
      expect(fullText).toContain("retry logic");
    });

    test("handles separator-delimited conversations", () => {
      const filePath = join(FIXTURES, "aider-history.md");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // All three conversation segments should be present
      expect(fullText).toContain("error handling");
      expect(fullText).toContain("mock database");
      expect(fullText).toContain("exponential backoff");
    });

    test("respects maxTokens chunking", () => {
      const filePath = join(FIXTURES, "aider-history.md");
      const chunks = provider.readChunks("/dummy", [filePath], 50);

      // With very small maxTokens, should split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
    });

    test("returns empty for nonexistent file", () => {
      const chunks = provider.readChunks("/dummy", ["/nonexistent/file.md"]);
      expect(chunks).toEqual([]);
    });
  });
});
