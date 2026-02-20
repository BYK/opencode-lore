import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { remark } from "remark";
import { normalize } from "../src/markdown";
import { formatDistillations, formatKnowledge } from "../src/prompt";

const proc = remark();

// Count listItem nodes recursively in a remark AST
function countListItems(md: string): number {
  let items = 0;
  function walk(node: { type: string; children?: unknown[] }) {
    if (node.type === "listItem") items++;
    for (const child of node.children ?? [])
      walk(child as { type: string; children?: unknown[] });
  }
  walk(proc.parse(md) as { type: string; children?: unknown[] });
  return items;
}

// Generates markdown-hostile strings — embedded syntax that could break structure
const hostile = fc
  .array(
    fc.oneof(
      fc.constant("`"),
      fc.constant("```"),
      fc.constant("````"),
      fc.constant("#"),
      fc.constant("## "),
      fc.constant("### "),
      fc.constant("---"),
      fc.constant("***"),
      fc.constant("___"),
      fc.constant("\n"),
      fc.constant("- "),
      fc.constant("1. "),
      fc.constant("* "),
      fc.constant("> "),
      fc.string({ minLength: 1, maxLength: 20 }),
    ),
    { minLength: 1, maxLength: 10 },
  )
  .map((parts) => parts.join(""));

describe("normalize", () => {
  test("is idempotent on its own output", () => {
    fc.assert(
      fc.property(
        hostile.map((s) => normalize(s)),
        (normalized) => {
          expect(normalize(normalized)).toBe(normalized);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("handles empty string", () => {
    expect(normalize("")).toBe("");
  });

  test("preserves already-normalized markdown", () => {
    const input = "## Heading\n\n* item 1\n* item 2\n";
    expect(normalize(input)).toBe(input);
  });
});

describe("formatDistillations", () => {
  test("output contains all observation text", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            observations: hostile.filter((s) => s.trim().length > 0),
            generation: fc.oneof(fc.constant(0), fc.constant(1)),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        (distillations) => {
          const result = formatDistillations(distillations);
          for (const d of distillations) {
            expect(result).toContain(d.observations.trim());
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  test("separates gen-0 and gen-1 under correct headers", () => {
    const result = formatDistillations([
      { observations: "Early work summary", generation: 1 },
      { observations: "Recent observation", generation: 0 },
    ]);
    expect(result).toContain("### Earlier Work (summarized)");
    expect(result).toContain("### Recent Work (distilled)");
    expect(result).toContain("Early work summary");
    expect(result).toContain("Recent observation");
  });

  test("gen-0 only shows Recent Work header", () => {
    const result = formatDistillations([
      { observations: "Some observation", generation: 0 },
    ]);
    expect(result).toContain("### Recent Work (distilled)");
    expect(result).not.toContain("Earlier Work");
  });

  test("gen-1 only shows Earlier Work header", () => {
    const result = formatDistillations([
      { observations: "Summarized work", generation: 1 },
    ]);
    expect(result).toContain("### Earlier Work (summarized)");
    expect(result).not.toContain("Recent Work");
  });

  test("handles empty input", () => {
    expect(formatDistillations([])).toBe("");
  });
});

describe("formatKnowledge", () => {
  test("output === normalize(output) — AST serializer produces already-normalized markdown", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            category: fc.oneof(
              fc.constant("decision"),
              fc.constant("pattern"),
              fc.constant("gotcha"),
            ),
            title: hostile.filter((s) => s.trim().length > 0),
            content: hostile.filter((s) => s.trim().length > 0),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (entries) => {
          const result = formatKnowledge(entries);
          if (!result) return;
          expect(normalize(result)).toBe(result);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("listItem count matches entry count per category", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            category: fc.oneof(fc.constant("decision"), fc.constant("pattern")),
            title: hostile.filter((s) => s.trim().length > 0),
            content: hostile.filter((s) => s.trim().length > 0),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (entries) => {
          const result = formatKnowledge(entries);
          if (!result) return;
          expect(countListItems(result)).toBe(entries.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("regression: code fence in content stays in list", () => {
    const result = formatKnowledge([
      {
        category: "pattern",
        title: "Code pattern",
        content: "Use:\n```ts\nconst x = 1\n```\ninstead of let",
      },
    ]);
    expect(countListItems(result)).toBe(1);
  });

  test("regression: triple backticks in title are escaped", () => {
    const result = formatKnowledge([
      {
        category: "gotcha",
        title: "```ts broke things",
        content: "Some content",
      },
    ]);
    // Should not contain an unescaped code block
    const tree = proc.parse(result);
    const codes = tree.children.filter((n) => n.type === "code");
    expect(codes.length).toBe(0);
  });

  test("handles empty input", () => {
    expect(formatKnowledge([])).toBe("");
  });
});
