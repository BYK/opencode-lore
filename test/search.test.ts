import { describe, test, expect } from "bun:test";
import {
  ftsQuery,
  ftsQueryOr,
  STOPWORDS,
  EMPTY_QUERY,
  normalizeRank,
  reciprocalRankFusion,
} from "../src/search";

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

  describe("normalizeRank", () => {
    test("best rank (most negative) normalizes to 1.0", () => {
      // minRank=-10 is best, maxRank=-1 is worst
      expect(normalizeRank(-10, -10, -1)).toBe(1);
    });

    test("worst rank normalizes to 0.0", () => {
      expect(normalizeRank(-1, -10, -1)).toBe(0);
    });

    test("mid-range rank normalizes proportionally", () => {
      const score = normalizeRank(-5.5, -10, -1);
      expect(score).toBeCloseTo(0.5, 1);
    });

    test("all same rank returns 1.0", () => {
      expect(normalizeRank(-5, -5, -5)).toBe(1);
    });

    test("single result returns 1.0", () => {
      expect(normalizeRank(-3, -3, -3)).toBe(1);
    });
  });

  describe("reciprocalRankFusion", () => {
    test("merges two lists by RRF score", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "a" }, { id: "b" }, { id: "c" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "b" }, { id: "a" }, { id: "d" }],
          key: (x) => x.id,
        },
      ]);

      const ids = fused.map((r) => r.item.id);
      // "a" appears at rank 0 in list 1 and rank 1 in list 2 → highest combined RRF
      // "b" appears at rank 1 in list 1 and rank 0 in list 2 → same as "a"
      expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]);
      // "c" and "d" only appear in one list each
      expect(ids).toContain("c");
      expect(ids).toContain("d");
      expect(ids.length).toBe(4);
    });

    test("items in multiple lists score higher than single-list items", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "shared" }, { id: "only-in-1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "shared" }, { id: "only-in-2" }],
          key: (x) => x.id,
        },
      ]);

      // "shared" appears in both lists → highest score
      expect(fused[0].item.id).toBe("shared");
      // Its score should be roughly 2 * 1/(60+0) ≈ 0.0333
      expect(fused[0].score).toBeCloseTo(2 / 60, 4);
    });

    test("preserves first occurrence when item appears in multiple lists", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "x", source: "list1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "x", source: "list2" }],
          key: (x) => x.id,
        },
      ]);

      // First occurrence (list1) should be kept
      expect((fused[0].item as { source: string }).source).toBe("list1");
    });

    test("empty lists produce empty result", () => {
      const fused = reciprocalRankFusion<{ id: string }>([
        { items: [], key: (x) => x.id },
        { items: [], key: (x) => x.id },
      ]);
      expect(fused.length).toBe(0);
    });

    test("single list returns items in order", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "first" }, { id: "second" }, { id: "third" }],
          key: (x) => x.id,
        },
      ]);

      expect(fused.map((r) => r.item.id)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    test("custom k parameter changes scores", () => {
      const fused = reciprocalRankFusion(
        [
          {
            items: [{ id: "a" }],
            key: (x) => x.id,
          },
        ],
        10, // smaller k → higher scores
      );

      // With k=10, rank 0 → 1/(10+0) = 0.1
      expect(fused[0].score).toBeCloseTo(0.1, 4);
    });
  });
});
