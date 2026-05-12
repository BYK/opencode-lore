import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdirSync, copyFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

import "../../src/import/providers/continue";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("Continue provider", () => {
  const provider = getProvider("continue")!;

  test("provider is registered with correct metadata", () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe("continue");
    expect(provider.displayName).toBe("Continue");
  });

  describe("detect", () => {
    test("returns empty for nonexistent project", () => {
      const sessions = provider.detect("/nonexistent/path/that/does/not/exist");
      expect(sessions).toEqual([]);
    });

    test("detects session matching workspace directory", () => {
      // Set up a mock ~/.continue directory
      const tmp = join(tmpdir(), `lore-continue-detect-${Date.now()}`);
      const sessionsDir = join(tmp, "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      // Write sessions index
      writeFileSync(
        join(sessionsDir, "sessions.json"),
        JSON.stringify([
          {
            sessionId: "sess-continue-1",
            title: "Database migration setup",
            dateCreated: "2025-05-10T16:00:00Z",
            workspaceDirectory: "/test/continue-project",
          },
          {
            sessionId: "sess-other",
            title: "Other project",
            dateCreated: "2025-05-10T15:00:00Z",
            workspaceDirectory: "/test/other-project",
          },
        ]),
      );

      // Write the session file
      copyFileSync(
        join(FIXTURES, "continue-session.json"),
        join(sessionsDir, "sess-continue-1.json"),
      );

      // Override CONTINUE_GLOBAL_DIR to point to our temp dir
      const original = process.env.CONTINUE_GLOBAL_DIR;
      process.env.CONTINUE_GLOBAL_DIR = tmp;
      try {
        const sessions = provider.detect("/test/continue-project");
        expect(sessions.length).toBe(1);
        expect(sessions[0].id).toBe("sess-continue-1");
        expect(sessions[0].messageCount).toBe(4);

        // Should not find sessions for other project
        const otherSessions = provider.detect("/test/other-project");
        expect(otherSessions).toEqual([]);
      } finally {
        if (original !== undefined) {
          process.env.CONTINUE_GLOBAL_DIR = original;
        } else {
          delete process.env.CONTINUE_GLOBAL_DIR;
        }
      }
    });
  });

  describe("readChunks", () => {
    test("parses Continue session format", () => {
      // Set up mock dir
      const tmp = join(tmpdir(), `lore-continue-read-${Date.now()}`);
      const sessionsDir = join(tmp, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      copyFileSync(
        join(FIXTURES, "continue-session.json"),
        join(sessionsDir, "sess-continue-1.json"),
      );

      const original = process.env.CONTINUE_GLOBAL_DIR;
      process.env.CONTINUE_GLOBAL_DIR = tmp;
      try {
        const chunks = provider.readChunks("/test/continue-project", ["sess-continue-1"]);

        expect(chunks.length).toBeGreaterThan(0);

        const fullText = chunks.map((c) => c.text).join("\n");

        // Should have both roles
        expect(fullText).toContain("[user]");
        expect(fullText).toContain("[assistant]");

        // Content
        expect(fullText).toContain("database migrations");
        expect(fullText).toContain("drizzle-kit");
      } finally {
        if (original !== undefined) {
          process.env.CONTINUE_GLOBAL_DIR = original;
        } else {
          delete process.env.CONTINUE_GLOBAL_DIR;
        }
      }
    });

    test("includes tool calls and results", () => {
      const tmp = join(tmpdir(), `lore-continue-tools-${Date.now()}`);
      const sessionsDir = join(tmp, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      copyFileSync(
        join(FIXTURES, "continue-session.json"),
        join(sessionsDir, "sess-continue-1.json"),
      );

      const original = process.env.CONTINUE_GLOBAL_DIR;
      process.env.CONTINUE_GLOBAL_DIR = tmp;
      try {
        const chunks = provider.readChunks("/test/continue-project", ["sess-continue-1"]);
        const fullText = chunks.map((c) => c.text).join("\n");

        expect(fullText).toContain("[tool: readFile]");
        expect(fullText).toContain("[tool_result]");
        expect(fullText).toContain("drizzle-orm");
      } finally {
        if (original !== undefined) {
          process.env.CONTINUE_GLOBAL_DIR = original;
        } else {
          delete process.env.CONTINUE_GLOBAL_DIR;
        }
      }
    });

    test("returns empty for unknown session", () => {
      const tmp = join(tmpdir(), `lore-continue-empty-${Date.now()}`);
      mkdirSync(join(tmp, "sessions"), { recursive: true });

      const original = process.env.CONTINUE_GLOBAL_DIR;
      process.env.CONTINUE_GLOBAL_DIR = tmp;
      try {
        const chunks = provider.readChunks("/dummy", ["nonexistent-session"]);
        expect(chunks).toEqual([]);
      } finally {
        if (original !== undefined) {
          process.env.CONTINUE_GLOBAL_DIR = original;
        } else {
          delete process.env.CONTINUE_GLOBAL_DIR;
        }
      }
    });
  });
});
