import { describe, test, expect } from "bun:test";
import { join } from "path";

import "../../src/import/providers/pi";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Pi provider", () => {
  const provider = getProvider("pi")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("pi");
    expect(provider.displayName).toBe("Pi");
  });

  describe("detect", () => {
    test("returns empty for nonexistent project", () => {
      const sessions = provider.detect("/nonexistent/path/that/does/not/exist");
      expect(sessions).toEqual([]);
    });
  });

  describe("readChunks", () => {
    test("parses tree-structured JSONL into linear conversation", () => {
      const filePath = join(FIXTURES, "pi-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks.length).toBeGreaterThan(0);

      const fullText = chunks.map((c) => c.text).join("\n");

      // Should have both roles
      expect(fullText).toContain("[user]");
      expect(fullText).toContain("[assistant]");

      // Content from the conversation
      expect(fullText).toContain("database queries");
      expect(fullText).toContain("N+1 query pattern");
      expect(fullText).toContain("cache-aside pattern");
    });

    test("maintains chronological message order", () => {
      const filePath = join(FIXTURES, "pi-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);
      const fullText = chunks.map((c) => c.text).join("\n");

      // Messages should appear in order: optimize queries → caching → cache-aside example
      const queryIdx = fullText.indexOf("optimize the database queries");
      const cacheIdx = fullText.indexOf("What about caching");
      const patternIdx = fullText.indexOf("cache-aside pattern");

      expect(queryIdx).toBeLessThan(cacheIdx);
      expect(cacheIdx).toBeLessThan(patternIdx);
    });

    test("respects maxTokens chunking", () => {
      const filePath = join(FIXTURES, "pi-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath], 50);

      expect(chunks.length).toBeGreaterThan(1);
    });

    test("handles empty session list", () => {
      const chunks = provider.readChunks("/dummy", []);
      expect(chunks).toEqual([]);
    });

    test("chunk label contains Pi and date", () => {
      const filePath = join(FIXTURES, "pi-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      expect(chunks[0].label).toContain("Pi");
      expect(chunks[0].label).toContain("2025-05-10");
    });

    test("handles session with branching (follows last branch)", () => {
      // Pi uses tree structure — we should follow the main (last) branch
      const filePath = join(FIXTURES, "pi-session.jsonl");
      const chunks = provider.readChunks("/dummy", [filePath]);

      // All 6 messages should be present since there's no branching in our fixture
      const fullText = chunks.map((c) => c.text).join("\n");
      const userMessages = fullText.split("[user]").length - 1;
      const assistantMessages = fullText.split("[assistant]").length - 1;

      expect(userMessages).toBe(3);
      expect(assistantMessages).toBe(3);
    });
  });
});
