import { describe, test, expect } from "bun:test";
import { inferProjectPath, getProjectPath } from "../src/config";

// ---------------------------------------------------------------------------
// inferProjectPath
// ---------------------------------------------------------------------------

describe("inferProjectPath", () => {
  test("extracts path from JSON-style cwd field (double-quoted)", () => {
    const system = `Some preamble\n"cwd": "/home/user/my-project"\nMore text`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts path from JSON-style cwd field (single-quoted)", () => {
    const system = `Tool def: 'cwd': '/Users/dev/app'`;
    expect(inferProjectPath(system)).toBe("/Users/dev/app");
  });

  test("extracts path from JSON-style cwd field (no quotes)", () => {
    const system = `cwd=/home/user/project`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });

  test("extracts path from Working directory line", () => {
    const system = `Working directory: /home/byk/Code/opencode-lore\nOther stuff`;
    expect(inferProjectPath(system)).toBe("/home/byk/Code/opencode-lore");
  });

  test("extracts path from working directory (lowercase w)", () => {
    const system = `working directory: /Users/dev/project`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("extracts directory from CLAUDE.md path reference", () => {
    const system = `Instructions from: /home/user/my-project/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts directory from AGENTS.md path reference", () => {
    const system = `Instructions from: /home/byk/Code/opencode-lore/AGENTS.md`;
    expect(inferProjectPath(system)).toBe("/home/byk/Code/opencode-lore");
  });

  test("extracts directory from .lore.md path reference", () => {
    const system = `See /Users/dev/project/.lore.md for details`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("falls back to generic /home/ path", () => {
    const system = `Some text mentioning /home/user/generic-project here`;
    expect(inferProjectPath(system)).toBe("/home/user/generic-project");
  });

  test("falls back to generic /Users/ path", () => {
    const system = `Some text mentioning /Users/dev/generic-project here`;
    expect(inferProjectPath(system)).toBe("/Users/dev/generic-project");
  });

  test("returns null for empty system prompt", () => {
    expect(inferProjectPath("")).toBeNull();
  });

  test("returns null for system prompt without paths", () => {
    expect(inferProjectPath("You are a helpful assistant.")).toBeNull();
  });

  test("returns null for paths not starting with /home/ or /Users/", () => {
    expect(inferProjectPath("cwd: /var/lib/project")).toBeNull();
  });

  test("prefers cwd field over generic path match", () => {
    // cwd pattern is checked first; if both are present, cwd wins
    const system = `Some /home/other/path here\n"cwd": "/home/user/correct-project"`;
    expect(inferProjectPath(system)).toBe("/home/user/correct-project");
  });

  test("prefers Working directory over CLAUDE.md reference", () => {
    const system = `Working directory: /home/user/project-a\nInstructions from: /home/user/project-b/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/project-a");
  });

  test("strips trailing slashes", () => {
    const system = `Working directory: /home/user/project/`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });
});

// ---------------------------------------------------------------------------
// getProjectPath
// ---------------------------------------------------------------------------

describe("getProjectPath", () => {
  test("prefers X-Lore-Project header over system prompt inference", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      { "x-lore-project": "/home/user/explicit-project" },
    );
    expect(result).toBe("/home/user/explicit-project");
  });

  test("falls back to inferProjectPath when no header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      {},
    );
    expect(result).toBe("/home/user/inferred-project");
  });

  test("falls back to process.cwd() when neither header nor inference match", () => {
    const result = getProjectPath("You are a helpful assistant.", {});
    expect(result).toBe(process.cwd());
  });

  test("ignores empty X-Lore-Project header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-project": "" },
    );
    expect(result).toBe("/home/user/project");
  });
});
