import { describe, test, expect } from "bun:test";
import { ftsQuery, ftsQueryOr, STOPWORDS, EMPTY_QUERY } from "../src/search";

describe("search", () => {
  describe("ftsQuery (AND semantics)", () => {
    test("plain words get prefix wildcard with implicit AND", () => {
      expect(ftsQuery("OAuth PKCE flow")).toBe("OAuth* PKCE* flow*");
    });

    test("hyphenated terms: dash stripped, not treated as NOT operator", () => {
      expect(ftsQuery("opencode-nuum")).toBe("opencode* nuum*");
      expect(ftsQuery("three-tier")).toBe("three* tier*");
    });

    test("dot in domain name: dot stripped, tokens preserved", () => {
      expect(ftsQuery("sanity.io")).toBe("sanity* io*");
    });

    test("other punctuation stripped", () => {
      // "what's the fix?" → "what" is stopword, "s" is single char, "the" is stopword → only "fix"
      expect(ftsQuery("what's the fix?")).toBe("fix*");
    });

    test("empty string returns empty sentinel", () => {
      expect(ftsQuery("")).toBe(EMPTY_QUERY);
    });

    test("punctuation-only returns empty sentinel", () => {
      expect(ftsQuery("!@#$%^&*()")).toBe(EMPTY_QUERY);
    });

    test("single-character tokens are dropped", () => {
      // "I" is single char, "a" is single char
      expect(ftsQuery("I found a bug")).toBe("found* bug*");
    });

    test("2-char tokens are preserved (DB, CI, IO, PR)", () => {
      expect(ftsQuery("DB migration")).toBe("DB* migration*");
      expect(ftsQuery("CI pipeline")).toBe("CI* pipeline*");
      expect(ftsQuery("IO error")).toBe("IO* error*");
      expect(ftsQuery("PR review")).toBe("PR* review*");
    });

    test("stopwords are removed", () => {
      // "the" and "with" are stopwords
      expect(ftsQuery("the database with indexes")).toBe("database* indexes*");
    });

    test("all-stopword query returns empty sentinel", () => {
      expect(ftsQuery("what is this")).toBe(EMPTY_QUERY);
      expect(ftsQuery("the from with")).toBe(EMPTY_QUERY);
    });

    test("all single-char tokens returns empty sentinel", () => {
      expect(ftsQuery("I a")).toBe(EMPTY_QUERY);
    });

    test("mixed stopwords and single chars returns empty sentinel", () => {
      expect(ftsQuery("I have the")).toBe(EMPTY_QUERY);
    });

    test("preserves case of original tokens", () => {
      // FTS5 handles case-insensitive matching internally via unicode61 tokenizer
      expect(ftsQuery("SQLite FTS5")).toBe("SQLite* FTS5*");
    });

    test("underscores preserved as word chars", () => {
      expect(ftsQuery("my_variable")).toBe("my_variable*");
    });
  });

  describe("ftsQueryOr (OR semantics)", () => {
    test("plain words joined with OR", () => {
      expect(ftsQueryOr("OAuth PKCE flow")).toBe("OAuth* OR PKCE* OR flow*");
    });

    test("same filtering as ftsQuery", () => {
      expect(ftsQueryOr("what's the fix?")).toBe("fix*");
    });

    test("empty string returns empty sentinel", () => {
      expect(ftsQueryOr("")).toBe(EMPTY_QUERY);
    });

    test("all-stopword query returns empty sentinel", () => {
      expect(ftsQueryOr("what is this")).toBe(EMPTY_QUERY);
    });

    test("stopwords removed, remaining terms OR'd", () => {
      expect(ftsQueryOr("the database with indexes")).toBe(
        "database* OR indexes*",
      );
    });

    test("single term produces no OR", () => {
      expect(ftsQueryOr("database")).toBe("database*");
    });
  });

  describe("STOPWORDS", () => {
    test("contains expected categories", () => {
      // Articles
      expect(STOPWORDS.has("the")).toBe(true);
      expect(STOPWORDS.has("this")).toBe(true);
      // Pronouns
      expect(STOPWORDS.has("they")).toBe(true);
      expect(STOPWORDS.has("what")).toBe(true);
      // Common verbs
      expect(STOPWORDS.has("have")).toBe(true);
      expect(STOPWORDS.has("been")).toBe(true);
      // Prepositions
      expect(STOPWORDS.has("with")).toBe(true);
      expect(STOPWORDS.has("from")).toBe(true);
      // Adverbs
      expect(STOPWORDS.has("just")).toBe(true);
      expect(STOPWORDS.has("very")).toBe(true);
    });

    test("does NOT contain domain terms", () => {
      expect(STOPWORDS.has("handle")).toBe(false);
      expect(STOPWORDS.has("state")).toBe(false);
      expect(STOPWORDS.has("type")).toBe(false);
      expect(STOPWORDS.has("error")).toBe(false);
      expect(STOPWORDS.has("function")).toBe(false);
      expect(STOPWORDS.has("database")).toBe(false);
    });
  });

  describe("EMPTY_QUERY sentinel", () => {
    test("is double-quoted empty string", () => {
      expect(EMPTY_QUERY).toBe('""');
    });
  });
});
