import { describe, test, expect } from "bun:test";
import { extractPatterns, type ExtractedPattern } from "../src/pattern-extract";

describe("extractPatterns", () => {
  // -----------------------------------------------------------------------
  // Decision patterns
  // -----------------------------------------------------------------------

  describe("decided to use/switch to/go with/adopt", () => {
    test("decided to use X", () => {
      const results = extractPatterns(
        "Team decided to use PostgreSQL for the main database.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Decided to use PostgreSQL for the main database");
      expect(results[0].content).toContain("decided to use PostgreSQL");
    });

    test("decided to switch to X", () => {
      const results = extractPatterns(
        "We decided to switch to Vite for faster builds.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Decided to use Vite for faster builds");
    });

    test("decided to go with X", () => {
      const results = extractPatterns(
        "The team decided to go with Redis for caching.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Decided to use Redis for caching");
    });

    test("decided to adopt X", () => {
      const results = extractPatterns(
        "We decided to adopt TypeScript across the codebase.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Decided to use TypeScript across the codebase");
    });
  });

  describe("chose X over Y", () => {
    test("basic chose over pattern", () => {
      const results = extractPatterns(
        "Chose PostgreSQL over MySQL for JSONB support.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Chose PostgreSQL over MySQL for JSONB support");
    });

    test("chose with longer names", () => {
      const results = extractPatterns(
        "Team chose React Server Components over traditional SSR.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(
        "Chose React Server Components over traditional SSR",
      );
    });
  });

  describe("switched from X to Y", () => {
    test("basic switched from/to", () => {
      const results = extractPatterns(
        "Switched from Webpack to esbuild for bundling.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Switched from Webpack to esbuild for bundling");
    });
  });

  describe("going with X because/for/due to", () => {
    test("going with because", () => {
      const results = extractPatterns(
        "Going with Bun because it has built-in SQLite support.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Going with Bun");
    });

    test("going with for", () => {
      const results = extractPatterns(
        "Going with zod for schema validation.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Going with zod");
    });

    test("going with due to", () => {
      const results = extractPatterns(
        "Going with FTS5 due to its Porter stemming support.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Going with FTS5");
    });
  });

  describe("migrated/migrating to X", () => {
    test("migrated to", () => {
      const results = extractPatterns(
        "Migrated to ESM modules across the project.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Migrated to ESM modules across the project");
    });

    test("migrating from X to Y", () => {
      const results = extractPatterns(
        "Currently migrating from Jest to Bun's test runner.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Migrated to Bun's test runner");
    });
  });

  describe("adopted X for/as/instead", () => {
    test("adopted for", () => {
      const results = extractPatterns(
        "Adopted Prettier for code formatting.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("decision");
      expect(results[0].title).toBe("Adopted Prettier");
    });

    test("adopted as", () => {
      const results = extractPatterns(
        "Adopted UUIDv7 as the default ID format.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Adopted UUIDv7");
    });
  });

  // -----------------------------------------------------------------------
  // Preference patterns
  // -----------------------------------------------------------------------

  describe("prefers X over/to/instead of/rather than Y", () => {
    test("prefers X over Y", () => {
      const results = extractPatterns(
        "User prefers tabs over spaces for indentation.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Prefers tabs over spaces for indentation");
    });

    test("prefer X to Y — title normalizes connective to 'over'", () => {
      const results = extractPatterns(
        "We prefer explicit types to inference in public APIs.",
      );
      expect(results).toHaveLength(1);
      // titleFn always uses "over" for consistency/dedup regardless of original connective
      expect(results[0].title).toBe(
        "Prefers explicit types over inference in public APIs",
      );
    });

    test("prefers X rather than Y — title normalizes to 'over'", () => {
      const results = extractPatterns(
        "Team prefers named exports rather than default exports.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(
        "Prefers named exports over default exports",
      );
    });

    test("prefer X instead of Y — title normalizes to 'over'", () => {
      const results = extractPatterns(
        "We prefer async/await instead of raw Promises.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(
        "Prefers async/await over raw Promises",
      );
    });
  });

  describe("typically use/prefer/go with X", () => {
    test("team typically uses", () => {
      const results = extractPatterns(
        "Team typically use Conventional Commits for messages.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe(
        "Typically uses Conventional Commits for messages",
      );
    });

    test("we usually prefer — matches both typically and prefers patterns", () => {
      const results = extractPatterns(
        "We usually prefer composition over inheritance.",
      );
      // Matches both "We usually prefer" (typically pattern) and
      // "prefer composition over inheritance" (prefers pattern)
      expect(results).toHaveLength(2);
      const titles = results.map((r) => r.title);
      expect(titles).toContain("Typically uses composition over inheritance");
      expect(titles).toContain("Prefers composition over inheritance");
    });

    test("user always uses", () => {
      const results = extractPatterns(
        "User always use strict TypeScript settings.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(
        "Typically uses strict TypeScript settings",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    test("no patterns found returns empty array", () => {
      const results = extractPatterns(
        "The session involved debugging a segfault in the native module.",
      );
      expect(results).toHaveLength(0);
    });

    test("empty string returns empty array", () => {
      expect(extractPatterns("")).toHaveLength(0);
    });

    test("multiple patterns in one text", () => {
      const results = extractPatterns(
        "Team decided to use PostgreSQL for the database. " +
          "Chose React over Vue for the frontend. " +
          "User prefers dark mode over light mode.",
      );
      expect(results).toHaveLength(3);
      const categories = results.map((r) => r.category);
      expect(categories).toContain("decision");
      expect(categories).toContain("preference");
    });

    test("deduplicates by title (case-insensitive)", () => {
      const results = extractPatterns(
        "Decided to use PostgreSQL for the DB. " +
          "Later, decided to use PostgreSQL for the DB.",
      );
      // Both match the same pattern with identical captures → same title → deduped
      expect(results).toHaveLength(1);
    });

    test("comma-terminated match", () => {
      const results = extractPatterns(
        "Decided to use Redis, which supports pub/sub natively.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Decided to use Redis");
    });

    test("end-of-line terminated match", () => {
      const results = extractPatterns(
        "Chose SQLite over PostgreSQL",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Chose SQLite over PostgreSQL");
    });

    test("case-insensitive matching", () => {
      const results = extractPatterns(
        "DECIDED TO USE MongoDB for flexible schema.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Decided to use MongoDB for flexible schema");
    });

    test("content preserves original matched text", () => {
      const results = extractPatterns(
        "We chose Tailwind over Bootstrap for utility-first CSS.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe(
        "chose Tailwind over Bootstrap for utility-first CSS.",
      );
    });
  });
});
