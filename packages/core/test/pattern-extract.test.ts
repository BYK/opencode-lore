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
  // Process instruction patterns
  // -----------------------------------------------------------------------

  describe("user stated always X", () => {
    test("basic user stated always", () => {
      const results = extractPatterns(
        "🔴 (14:30) User stated always create a PR for changes.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Always create a PR for changes");
    });

    test("user asserted always", () => {
      const results = extractPatterns(
        "🔴 (14:30) User asserted always run tests before committing.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Always run tests before committing");
    });

    test("user said to always", () => {
      const results = extractPatterns(
        "🔴 (09:15) User said to always use squash merges for PRs.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Always use squash merges for PRs");
    });

    test("team stated always", () => {
      const results = extractPatterns(
        "Team stated always review code before merging.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Always review code before merging");
    });

    test("does not match without stated/asserted/said prefix", () => {
      // This should only match the existing "typically uses" pattern,
      // not the new "always" instruction pattern
      const results = extractPatterns(
        "User always use strict TypeScript settings.",
      );
      expect(results).toHaveLength(1);
      // Should match the existing "typically uses" pattern, not the new one
      expect(results[0].title).toBe("Typically uses strict TypeScript settings");
    });
  });

  describe("user stated never X", () => {
    test("basic user stated never", () => {
      const results = extractPatterns(
        "🔴 (14:31) User stated never push directly to main.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Never push directly to main");
    });

    test("user said to never", () => {
      const results = extractPatterns(
        "🔴 (10:00) User said to never commit secrets to the repo.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Never commit secrets to the repo");
    });

    test("does not match without stated/asserted/said prefix", () => {
      const results = extractPatterns(
        "Never use force push on shared branches.",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("user stated make sure to X", () => {
    test("basic user said make sure to", () => {
      const results = extractPatterns(
        "🔴 (09:15) User said make sure to run the linter before pushing.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Make sure to run the linter before pushing");
    });

    test("user stated make sure without 'to' does not match", () => {
      const results = extractPatterns(
        "🔴 (11:00) User stated make sure tests pass before merging.",
      );
      // Requires "make sure to" — without "to" the phrasing is non-standard
      expect(results).toHaveLength(0);
    });

    test("does not match without stated/asserted/said prefix", () => {
      const results = extractPatterns(
        "Make sure to update the changelog.",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("user stated don't forget to X", () => {
    test("basic user stated don't forget to — normalizes to Always", () => {
      const results = extractPatterns(
        "🔴 (10:00) User stated don't forget to update the changelog.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Always update the changelog");
    });

    test("user said do not forget to", () => {
      const results = extractPatterns(
        "🔴 (10:00) User said do not forget to add tests for new features.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Always add tests for new features");
    });

    test("deduplicates with matching always pattern", () => {
      const results = extractPatterns(
        "🔴 (10:00) User stated don't forget to update the changelog.\n" +
          "🔴 (10:05) User stated always update the changelog.",
      );
      // Both produce title "Always update the changelog" → deduped to 1
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Always update the changelog");
    });

    test("does not match without stated/asserted/said prefix", () => {
      const results = extractPatterns(
        "Don't forget to run the build.",
      );
      expect(results).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------
  // Declarative preference patterns (new)
  // -----------------------------------------------------------------

  describe("user uses/likes X for Y", () => {
    test("user uses X for Y", () => {
      const results = extractPatterns(
        "User uses pnpm for package management.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Uses pnpm for package management");
    });

    test("team likes X for Y", () => {
      const results = extractPatterns(
        "Team likes Vitest for unit testing.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Uses Vitest for unit testing");
    });

    test("we use X as Y", () => {
      const results = extractPatterns(
        "We use PostgreSQL as the primary database.",
      );
      expect(results).toHaveLength(1);
      // titleFn always formats as "Uses X for Y" regardless of which connective matched
      expect(results[0].title).toBe("Uses PostgreSQL for the primary database");
    });

    test("does not match without for/as/when/in", () => {
      const results = extractPatterns("User uses React.");
      expect(results).toHaveLength(0);
    });

    test("does not match without user/team/we prefix", () => {
      const results = extractPatterns(
        "The project uses ESLint for linting.",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("user doesn't like/use/want X", () => {
    test("user doesn't like X", () => {
      const results = extractPatterns(
        "User doesn't like ORMs.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Avoids ORMs");
    });

    test("team does not use X", () => {
      const results = extractPatterns(
        "Team does not use default exports.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Avoids default exports");
    });

    test("we don't want X", () => {
      const results = extractPatterns(
        "We don't want class components.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Avoids class components");
    });

    test("does not match without user/team/we prefix", () => {
      const results = extractPatterns(
        "Doesn't like the current architecture.",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("convention is X", () => {
    test("our convention is X", () => {
      const results = extractPatterns(
        "Our convention is kebab-case for file names.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
      expect(results[0].title).toBe("Convention: kebab-case for file names");
    });

    test("the convention is X", () => {
      const results = extractPatterns(
        "The convention is to use named exports.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Convention: to use named exports");
    });

    test("project convention is X", () => {
      const results = extractPatterns(
        "Project convention is camelCase for variables.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Convention: camelCase for variables");
    });

    test("does not match bare 'convention' without prefix", () => {
      const results = extractPatterns(
        "Convention is key to readability.",
      );
      expect(results).toHaveLength(0);
    });

    test("does not match 'standard of' idiom", () => {
      const results = extractPatterns(
        "The standard of living is high.",
      );
      expect(results).toHaveLength(0);
    });

    test("does not match 'rule of thumb'", () => {
      const results = extractPatterns(
        "The rule of thumb is to keep functions small.",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("process instruction edge cases", () => {
    test("multiple instruction patterns in one text", () => {
      const results = extractPatterns(
        "🔴 (14:30) User stated always create PRs for changes.\n" +
          "🔴 (14:31) User stated never push to main directly.\n" +
          "🔴 (14:32) User said make sure to run tests.",
      );
      expect(results).toHaveLength(3);
      const titles = results.map((r) => r.title);
      expect(titles).toContain("Always create PRs for changes");
      expect(titles).toContain("Never push to main directly");
      expect(titles).toContain("Make sure to run tests");
    });

    test("matches instruction with short but valid capture", () => {
      const results = extractPatterns(
        "User stated always do it.",
      );
      // "do it" is 5 chars (above the 2-char rejection threshold)
      // and "stated" prefix is present — this should match.
      expect(results).toHaveLength(1);
    });

    test("content preserves original matched text", () => {
      const results = extractPatterns(
        "User stated always create a PR for changes.",
      );
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("stated always create a PR");
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

    test("rejects template placeholders like X and Y", () => {
      const results = extractPatterns(
        'Patterns like "decided to use X" and "prefers X over Y" are matched.',
      );
      expect(results).toHaveLength(0);
    });

    test("rejects captures containing smart quote characters", () => {
      const results = extractPatterns(
        "decided to use \u201CPostgreSQL\u201D for the main database.",
      );
      expect(results).toHaveLength(0);
    });

    test("rejects very short captures (1-2 chars)", () => {
      const results = extractPatterns(
        "Decided to use Go, which is fast.",
      );
      // "Go" is only 2 chars — too short to be a reliable extraction
      expect(results).toHaveLength(0);
    });
  });
});
