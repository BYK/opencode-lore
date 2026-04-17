import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { db, ensureProject } from "../src/db";
import * as latReader from "../src/lat-reader";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const PROJECT = FIXTURES_DIR; // fixtures dir acts as project root (has lat.md/ subdir)

describe("lat-reader", () => {
  beforeEach(() => {
    // Clean lat_sections for this project between tests
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM lat_sections WHERE project_id = ?").run(pid);
  });

  describe("hasLatDir", () => {
    test("returns true when lat.md/ directory exists", () => {
      expect(latReader.hasLatDir(PROJECT)).toBe(true);
    });

    test("returns false for project without lat.md/", () => {
      expect(latReader.hasLatDir("/nonexistent/project")).toBe(false);
    });
  });

  describe("parseSections", () => {
    test("extracts hierarchical sections from markdown", () => {
      const content = `# Top Level

Overview paragraph.

## Sub Section

Details about the sub section.

### Nested

Deep nested content.
`;
      const sections = latReader.parseSections(
        join(FIXTURES_DIR, "lat.md", "test.md"),
        content,
        FIXTURES_DIR,
      );

      expect(sections.length).toBe(3);
      expect(sections[0].id).toBe("lat.md/test#Top Level");
      expect(sections[0].heading).toBe("Top Level");
      expect(sections[0].depth).toBe(1);

      expect(sections[1].id).toBe("lat.md/test#Top Level#Sub Section");
      expect(sections[1].heading).toBe("Sub Section");
      expect(sections[1].depth).toBe(2);

      expect(sections[2].id).toBe(
        "lat.md/test#Top Level#Sub Section#Nested",
      );
      expect(sections[2].depth).toBe(3);
    });

    test("extracts first paragraph", () => {
      const content = `# Heading

First paragraph is the overview.

More detail follows.
`;
      const sections = latReader.parseSections(
        join(FIXTURES_DIR, "lat.md", "test.md"),
        content,
        FIXTURES_DIR,
      );

      expect(sections[0].first_paragraph).toBe(
        "First paragraph is the overview.",
      );
    });

    test("returns empty for files without headings", () => {
      const content = "Just some text without any headings.\n";
      const sections = latReader.parseSections(
        join(FIXTURES_DIR, "lat.md", "test.md"),
        content,
        FIXTURES_DIR,
      );
      expect(sections).toEqual([]);
    });
  });

  describe("refresh", () => {
    test("indexes sections from lat.md/ directory", () => {
      const upserted = latReader.refresh(PROJECT);
      expect(upserted).toBeGreaterThan(0);

      const count = latReader.count(PROJECT);
      expect(count).toBeGreaterThan(0);
    });

    test("skips unchanged files on re-scan", () => {
      // First scan
      const first = latReader.refresh(PROJECT);
      expect(first).toBeGreaterThan(0);

      // Second scan — files haven't changed
      const second = latReader.refresh(PROJECT);
      expect(second).toBe(0);
    });

    test("returns 0 for project without lat.md/", () => {
      expect(latReader.refresh("/nonexistent/project")).toBe(0);
    });
  });

  describe("searchScored", () => {
    test("finds sections by keyword", () => {
      latReader.refresh(PROJECT);

      const results = latReader.searchScored({
        query: "authentication OAuth",
        projectPath: PROJECT,
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      // Should find auth-related sections
      const hasAuth = results.some(
        (r) =>
          r.heading.toLowerCase().includes("auth") ||
          r.content.toLowerCase().includes("oauth"),
      );
      expect(hasAuth).toBe(true);
    });

    test("returns empty for non-matching query", () => {
      latReader.refresh(PROJECT);

      const results = latReader.searchScored({
        query: "xyzzyplugh nonexistent",
        projectPath: PROJECT,
        limit: 5,
      });

      expect(results).toEqual([]);
    });
  });

  describe("scoreForSession", () => {
    test("scores sections against session context", () => {
      latReader.refresh(PROJECT);

      const sections = latReader.scoreForSession(
        PROJECT,
        "authentication middleware pipeline request handling",
        5000, // generous budget
      );

      expect(sections.length).toBeGreaterThan(0);
    });

    test("respects token budget", () => {
      latReader.refresh(PROJECT);

      // Very tight budget — should only fit a few sections
      const sections = latReader.scoreForSession(
        PROJECT,
        "authentication middleware pipeline",
        50, // very tight
      );

      // Should have 0-1 sections with such a tight budget
      expect(sections.length).toBeLessThanOrEqual(2);
    });
  });
});
