import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { db, close, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import {
  LORE_SECTION_START,
  LORE_SECTION_END,
  exportToFile,
  importFromFile,
  shouldImport,
  parseEntriesFromSection,
  type ParsedFileEntry,
} from "../src/agents-file";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PROJECT = "/test/agents-file/project";
const TMP_DIR = join(import.meta.dir, "__tmp_agents_file__");
const AGENTS_FILE = join(TMP_DIR, "AGENTS.md");

function agentsPath(name = "AGENTS.md") {
  return join(TMP_DIR, name);
}

function readFile(path = AGENTS_FILE): string {
  return readFileSync(path, "utf8");
}

function writeFile(content: string, path = AGENTS_FILE) {
  writeFileSync(path, content, "utf8");
}

// Minimal valid lore section (empty knowledge)
function loreSectionOnly(): string {
  return `${LORE_SECTION_START}\n${LORE_SECTION_END}\n`;
}

// Build a lore section with known entries (as exportToFile would produce)
function loreSectionWithEntries(
  entries: Array<{ id: string; category: string; title: string; content: string }>,
): string {
  const lines: string[] = [LORE_SECTION_START];
  const grouped: Record<string, typeof entries> = {};
  for (const e of entries) {
    (grouped[e.category] ??= []).push(e);
  }
  lines.push("");
  lines.push("## Long-term Knowledge");
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push("");
    lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
    lines.push("");
    for (const item of items) {
      lines.push(`<!-- lore:${item.id} -->`);
      lines.push(`* **${item.title}**: ${item.content}`);
    }
  }
  lines.push("");
  lines.push(LORE_SECTION_END);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Fixed UUIDs used in importFromFile tests that must be cleaned up to prevent
// cross-test-file collisions (ltm.test.ts uses the same IDs for its own fixtures).
const TEST_UUIDS = [
  "019505a1-7c00-7000-8000-aabbccddeeff",
  "019505a2-7c00-7000-8000-bbbbbbbbbbbb",
  "019505a1-7c00-7000-8000-aaaaaaaaaaaa",
];

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  // Clean DB knowledge for this project (including any cross-project entries it created)
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  db().query("DELETE FROM knowledge WHERE project_id IS NULL").run();
  // Also remove any cross-project entries that originated from test projects
  // (prevents test pollution leaking into forProject(PROJECT, includeCross=true) queries)
  db()
    .query(
      "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%')",
    )
    .run();
  // Remove fixed-UUID entries that may have leaked from importFromFile tests;
  // ltm.test.ts uses the same UUIDs and will UNIQUE-constraint-fail if they exist.
  for (const id of TEST_UUIDS) {
    db().query("DELETE FROM knowledge WHERE id = ?").run(id);
  }
  // Reset the agents file
  if (existsSync(AGENTS_FILE)) rmSync(AGENTS_FILE);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  // Final cleanup of all fixed-UUID test entries so ltm.test.ts doesn't hit
  // UNIQUE constraint failures when it tries to insert the same IDs.
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  for (const id of TEST_UUIDS) {
    db().query("DELETE FROM knowledge WHERE id = ?").run(id);
  }
  close();
});

// ---------------------------------------------------------------------------
// parseEntriesFromSection
// ---------------------------------------------------------------------------

describe("parseEntriesFromSection", () => {
  test("extracts entries with UUIDv7 markers", () => {
    const section = `
## Long-term Knowledge

### Decision

<!-- lore:019505a1-7c00-7000-8000-1a2b3c4d5e6f -->
* **Auth strategy**: Using OAuth2 with PKCE flow

### Gotcha

<!-- lore:019505a2-7c00-7000-8000-1a2b3c4d5e6f -->
* **Rebuild after src change**: Run pnpm build after editing packages/server/src
`;
    const entries = parseEntriesFromSection(section);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "019505a1-7c00-7000-8000-1a2b3c4d5e6f",
      category: "decision",
      title: "Auth strategy",
      content: "Using OAuth2 with PKCE flow",
    });
    expect(entries[1]).toMatchObject({
      id: "019505a2-7c00-7000-8000-1a2b3c4d5e6f",
      category: "gotcha",
      title: "Rebuild after src change",
    });
  });

  test("extracts hand-written entries without markers (no id)", () => {
    const section = `
## Long-term Knowledge

### Pattern

* **Middleware pattern**: Using Hono middleware for all routes
`;
    const entries = parseEntriesFromSection(section);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBeNull();
    expect(entries[0].title).toBe("Middleware pattern");
    expect(entries[0].category).toBe("pattern");
  });

  test("handles mixed marked and unmarked entries", () => {
    const section = `
## Long-term Knowledge

### Decision

<!-- lore:019505a1-7c00-7000-8000-aabbccddeeff -->
* **Auth strategy**: OAuth2 with PKCE

* **Hand-written decision**: Some decision added manually
`;
    const entries = parseEntriesFromSection(section);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("019505a1-7c00-7000-8000-aabbccddeeff");
    expect(entries[1].id).toBeNull();
    expect(entries[1].title).toBe("Hand-written decision");
  });

  test("returns empty array for empty section", () => {
    expect(parseEntriesFromSection("")).toHaveLength(0);
    expect(parseEntriesFromSection("   \n  ")).toHaveLength(0);
  });

  test("ignores malformed marker lines (not valid UUID format)", () => {
    const section = `
## Long-term Knowledge

### Pattern

<!-- lore:not-a-valid-uuid -->
* **Some entry**: Some content

<!-- lore:019505a1-7c00-7000-8000-1a2b3c4d5e6f -->
* **Valid entry**: Valid content
`;
    const entries = parseEntriesFromSection(section);
    // Malformed marker: entry gets no id (treated as hand-written)
    // Valid marker: entry gets the id
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBeNull();
    expect(entries[1].id).toBe("019505a1-7c00-7000-8000-1a2b3c4d5e6f");
  });

  test("deduplicates same UUID appearing twice — keeps first occurrence", () => {
    const section = `
## Long-term Knowledge

### Decision

<!-- lore:019505a1-7c00-7000-8000-aabbccddeeff -->
* **Auth strategy**: OAuth2 with PKCE

### Pattern

<!-- lore:019505a1-7c00-7000-8000-aabbccddeeff -->
* **Auth strategy duplicate**: same UUID different entry
`;
    const entries = parseEntriesFromSection(section);
    expect(entries).toHaveLength(2);
    // Both are returned but importFromFile will deduplicate on write
    const ids = entries.map((e) => e.id);
    expect(ids.filter((id) => id === "019505a1-7c00-7000-8000-aabbccddeeff")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// exportToFile
// ---------------------------------------------------------------------------

describe("exportToFile", () => {
  test("creates AGENTS.md from scratch when file does not exist", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "Using OAuth2 with PKCE",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    expect(existsSync(AGENTS_FILE)).toBe(true);
    const content = readFile();
    expect(content).toContain(LORE_SECTION_START);
    expect(content).toContain(LORE_SECTION_END);
    expect(content).toContain("Auth strategy");
    expect(content).toContain("OAuth2 with PKCE");
  });

  test("includes <!-- lore:UUID --> marker before each entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Middleware pattern",
      content: "Using Hono middleware",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    expect(content).toContain(`<!-- lore:${id} -->`);
  });

  test("replaces lore section on subsequent export, preserves non-lore content", () => {
    writeFile(`# My Project\n\nSome hand-written docs.\n\n${loreSectionOnly()}\n## Workflow\n\nDo this stuff.\n`);

    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Test gotcha",
      content: "This is a gotcha",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    expect(content).toContain("# My Project");
    expect(content).toContain("Some hand-written docs.");
    expect(content).toContain("## Workflow");
    expect(content).toContain("Do this stuff.");
    expect(content).toContain("Test gotcha");
    // Should only have one lore section
    const startCount = (content.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    expect(startCount).toBe(1);
  });

  test("appends lore section when file exists without markers", () => {
    writeFile("# Existing project docs\n\nSome content here.\n");

    ltm.create({
      projectPath: PROJECT,
      category: "architecture",
      title: "Stack",
      content: "SolidJS + Hono",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    expect(content).toContain("# Existing project docs");
    expect(content).toContain(LORE_SECTION_START);
    expect(content).toContain("Stack");
  });

  test("writes empty lore section when there are no knowledge entries", () => {
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    expect(content).toContain(LORE_SECTION_START);
    expect(content).toContain(LORE_SECTION_END);
    // No knowledge entries means no bullet points
    expect(content).not.toContain("* **");
  });

  test("writes entries sorted by category then title", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Zap gotcha",
      content: "Z gotcha content",
      scope: "project",
    });
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    const decisionPos = content.indexOf("### Decision");
    const gotchaPos = content.indexOf("### Gotcha");
    expect(decisionPos).toBeGreaterThan(-1);
    expect(gotchaPos).toBeGreaterThan(-1);
    expect(decisionPos).toBeLessThan(gotchaPos);
  });
});

// ---------------------------------------------------------------------------
// shouldImport
// ---------------------------------------------------------------------------

describe("shouldImport", () => {
  test("returns false when file does not exist", () => {
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(false);
  });

  test("returns true when file exists and has never been imported", () => {
    writeFile("# Some project docs\n\nSome content about the project.\n");
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(true);
  });

  test("returns false after export (lore section matches DB state)", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // After export, the file matches what lore would produce → no import needed
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(false);
  });

  test("returns true when lore section content differs from DB state (external edit)", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Simulate external edit: someone manually tweaked the lore section
    const content = readFile();
    const edited = content.replace(
      "OAuth2 with PKCE",
      "OAuth2 with PKCE — updated manually",
    );
    writeFile(edited);

    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(true);
  });

  test("returns true when file has content outside lore markers (hand-written AGENTS.md)", () => {
    // File exists with no lore markers — a pre-existing hand-written AGENTS.md
    writeFile("# Project\n\n## Architecture\n\n* **Stack**: SolidJS\n");
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(true);
  });

  test("returns false when file only has empty lore section and no DB entries", () => {
    // Export produced an empty section, nothing to import
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importFromFile — known IDs (cross-machine sync)
// ---------------------------------------------------------------------------

describe("importFromFile — known ID tracking", () => {
  test("imports entries from another machine by preserving their UUIDs", () => {
    const remoteId = "019505a1-7c00-7000-8000-aabbccddeeff";
    const section = loreSectionWithEntries([
      { id: remoteId, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(section);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entry = ltm.get(remoteId);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(remoteId);
    expect(entry!.title).toBe("Auth strategy");
  });

  test("does not duplicate an existing entry on re-import of same file", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Re-import the same file — should not create a second entry
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entries = ltm.forProject(PROJECT);
    const authEntries = entries.filter((e) => e.title === "Auth strategy");
    expect(authEntries).toHaveLength(1);
    expect(authEntries[0].id).toBe(id);
  });

  test("updates existing entry when content differs (manual edit in AGENTS.md)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Simulate manual edit
    const content = readFile();
    const edited = content.replace("OAuth2 with PKCE", "OAuth2 with PKCE — also supports API keys");
    writeFile(edited);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entry = ltm.get(id);
    expect(entry!.content).toContain("API keys");
  });

  test("creates hand-written entries (no marker) with new UUIDs", () => {
    writeFile(`${LORE_SECTION_START}\n\n## Long-term Knowledge\n\n### Pattern\n\n* **Middleware pattern**: Using Hono\n\n${LORE_SECTION_END}\n`);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entries = ltm.forProject(PROJECT);
    const match = entries.find((e) => e.title === "Middleware pattern");
    expect(match).toBeDefined();
    expect(match!.id).toBeTruthy();
    // ID should be a valid UUID format
    expect(match!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// importFromFile — hand-written AGENTS.md (no markers)
// ---------------------------------------------------------------------------

describe("importFromFile — hand-written AGENTS.md", () => {
  test("imports descriptive sections from a pre-existing AGENTS.md", () => {
    writeFile(`# My Project

## Architecture

* **Stack**: SolidJS frontend, Hono backend, SQLite via bun:sqlite
* **Auth**: OAuth2 with PKCE flow

## Gotchas

* **Rebuild server binary**: After editing packages/server/src, rebuild with pnpm build:bin
`);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entries = ltm.forProject(PROJECT);
    // Should have imported at least the architecture and gotcha entries
    expect(entries.length).toBeGreaterThan(0);
  });

  test("does not re-import the lore-managed section from the file", () => {
    // Create some DB entries, export to file, then add more entries
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Add hand-written content outside the lore section
    const existing = readFile();
    writeFile(`# My Project\n\nSome intro.\n\n${existing}`);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // The lore section content should NOT be re-imported as duplicates
    const entries = ltm.forProject(PROJECT);
    const authEntries = entries.filter((e) => e.title === "Auth strategy");
    expect(authEntries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Merge conflict + dedup scenarios
// ---------------------------------------------------------------------------

describe("dedup — merge conflict scenarios", () => {
  test("importing file with duplicate UUIDs only creates one entry", () => {
    const dupId = "019505a1-7c00-7000-8000-aabbccddeeff";
    // Simulate a bad merge that duplicated a section
    const content = `${LORE_SECTION_START}

## Long-term Knowledge

### Decision

<!-- lore:${dupId} -->
* **Auth strategy**: OAuth2 with PKCE

<!-- lore:${dupId} -->
* **Auth strategy**: OAuth2 with PKCE

${LORE_SECTION_END}`;
    writeFile(content);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entry = ltm.get(dupId);
    expect(entry).not.toBeNull();

    // Only one entry with this ID should exist
    const all = ltm.forProject(PROJECT);
    const matching = all.filter((e) => e.id === dupId);
    expect(matching).toHaveLength(1);
  });

  test("importing after merge preserves both entries from different machines when IDs differ", () => {
    // Alice created entry A on her machine, Bob created entry B on his.
    // After merge both appear in AGENTS.md with different IDs.
    const aliceId = "019505a1-7c00-7000-8000-aaaaaaaaaaaa";
    const bobId   = "019505a2-7c00-7000-8000-bbbbbbbbbbbb";

    const content = loreSectionWithEntries([
      { id: aliceId, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
      { id: bobId,   category: "decision", title: "Database choice", content: "SQLite via bun:sqlite" },
    ]);
    writeFile(content);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    expect(ltm.get(aliceId)).not.toBeNull();
    expect(ltm.get(bobId)).not.toBeNull();
  });

  test("re-export after import of merged file produces a clean single-occurrence file", () => {
    const id1 = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    const id2 = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Rebuild server",
      content: "Run pnpm build:bin after src change",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const content = readFile();
    // Each ID should appear exactly once
    const id1Count = (content.match(new RegExp(`lore:${id1}`, "g")) ?? []).length;
    const id2Count = (content.match(new RegExp(`lore:${id2}`, "g")) ?? []).length;
    expect(id1Count).toBe(1);
    expect(id2Count).toBe(1);
  });

  test("mangled marker (missing lore: prefix) treated as hand-written entry", () => {
    const content = `${LORE_SECTION_START}

## Long-term Knowledge

### Decision

<!-- 019505a1-7c00-7000-8000-aabbccddeeff -->
* **Auth strategy**: OAuth2 with PKCE

${LORE_SECTION_END}`;
    writeFile(content);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Should be imported but with a new generated ID (not the mangled one)
    const entries = ltm.forProject(PROJECT);
    const match = entries.find((e) => e.title === "Auth strategy");
    expect(match).toBeDefined();
    // The mangled UUID should NOT be used as the ID
    expect(match!.id).not.toBe("019505a1-7c00-7000-8000-aabbccddeeff");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: export → import → export produces stable output
// ---------------------------------------------------------------------------

describe("round-trip stability", () => {
  test("export → import → export produces identical file", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE flow for all authentication",
      scope: "project",
    });
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Rebuild server binary",
      content: "Run pnpm build:bin after editing packages/server/src",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    const firstExport = readFile();

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    const secondExport = readFile();

    expect(secondExport).toBe(firstExport);
  });

  test("export → edit non-lore section → import → export preserves edit and lore section", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Middleware",
      content: "Hono middleware for all routes",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Add hand-written section before the lore markers
    const exported = readFile();
    writeFile(`# My Project\n\nSome docs.\n\n${exported}`);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const final = readFile();
    expect(final).toContain("# My Project");
    expect(final).toContain("Some docs.");
    expect(final).toContain("Middleware");
    expect(final).toContain(LORE_SECTION_START);
    expect(final).toContain(LORE_SECTION_END);
  });
});

// ---------------------------------------------------------------------------
// Multi-section deduplication (self-healing)
// ---------------------------------------------------------------------------

const OLD_LORE_SECTION_START =
  "<!-- This section is auto-maintained by lore (https://github.com/BYK/opencode-lore) -->";

describe("exportToFile — self-healing duplicate sections", () => {
  test("collapses multiple new-marker sections into one on export", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });

    // Simulate a file that somehow got two lore sections (the duplication bug).
    // Non-lore content before the first and after the last section is preserved;
    // anything sandwiched between dup sections is consumed (unavoidable).
    const dupSection = `${LORE_SECTION_START}\n\n## Long-term Knowledge\n\n### Decision\n\n<!-- lore:${id} -->\n* **Auth strategy**: OAuth2 with PKCE\n\n${LORE_SECTION_END}\n`;
    const content = `# My Project\n\n${dupSection}\n${dupSection}\n\n## Conventions\n\nSome text.\n`;
    writeFile(content);

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const result = readFile();
    const startCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    const endCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_END), "g")) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
    // Non-lore content is preserved
    expect(result).toContain("# My Project");
    expect(result).toContain("## Conventions");
    expect(result).toContain("Some text.");
  });

  test("collapses old-marker section into one new-marker section on export", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });

    // File with old marker text (before the rename)
    const oldSection = `${OLD_LORE_SECTION_START}\n\n## Long-term Knowledge\n\n${LORE_SECTION_END}\n`;
    writeFile(`# My Project\n\n${oldSection}\n## Extra\n\nStuff.\n`);

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const result = readFile();
    // Old marker must be gone, new marker must appear exactly once
    expect(result).not.toContain(OLD_LORE_SECTION_START);
    const startCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    expect(startCount).toBe(1);
    expect(result).toContain(LORE_SECTION_END);
    // Non-lore content preserved
    expect(result).toContain("# My Project");
    expect(result).toContain("## Extra");
    expect(result).toContain("Stuff.");
    // Entry present
    expect(result).toContain("Auth strategy");
  });

  test("collapses mixed old+new marker sections (the real-world bug) into one", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Watch this",
      content: "Something tricky",
      scope: "project",
    });

    // Replicate the actual AGENTS.md state: old marker section first,
    // then several new marker sections appended after.
    const oldSection = `${OLD_LORE_SECTION_START}\n\n## Long-term Knowledge\n\n${LORE_SECTION_END}\n`;
    const newSection = `${LORE_SECTION_START}\n\n## Long-term Knowledge\n\n${LORE_SECTION_END}\n`;
    const badFile = [
      "# Project",
      "",
      "## Conventions",
      "",
      oldSection,
      "",
      "## More",
      "",
      newSection,
      "",
      newSection,
    ].join("\n");
    writeFile(badFile);

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const result = readFile();
    const allStartCount =
      (result.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length +
      (result.match(new RegExp(escapeRegex(OLD_LORE_SECTION_START), "g")) ?? []).length;
    const endCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_END), "g")) ?? []).length;
    expect(allStartCount).toBe(1);
    expect(endCount).toBe(1);
    expect(result).toContain(LORE_SECTION_START);
    expect(result).not.toContain(OLD_LORE_SECTION_START);
    expect(result).toContain("Watch this");
  });

  test("non-lore content between duplicate sections is also removed", () => {
    // If there's random text between two lore sections (shouldn't happen but
    // good to verify what 'after last section' means).
    ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Test",
      content: "Content",
      scope: "project",
    });

    const sec1 = `${LORE_SECTION_START}\n## Long-term Knowledge\n\n${LORE_SECTION_END}`;
    const sec2 = `${LORE_SECTION_START}\n## Long-term Knowledge\n\n${LORE_SECTION_END}`;
    writeFile(`# Before\n\n${sec1}\n\n## BETWEEN SECTIONS - should be removed\n\n${sec2}\n\n## After\n`);

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const result = readFile();
    expect(result).toContain("# Before");
    expect(result).toContain("## After");
    expect(result).not.toContain("BETWEEN SECTIONS");
    const startCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    expect(startCount).toBe(1);
  });
});

describe("shouldImport — old marker variant", () => {
  test("returns true when file has only old-marker lore section (content differs from DB)", () => {
    // File with old marker and some content that differs from empty DB
    const oldSection = `${OLD_LORE_SECTION_START}\n\n## Long-term Knowledge\n\n### Decision\n\n<!-- lore:019505a1-7c00-7000-8000-aabbccddeeff -->\n* **Auth strategy**: OAuth2 with PKCE\n\n${LORE_SECTION_END}\n`;
    writeFile(oldSection);

    // DB is empty, so the file's section differs from what we'd produce
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(true);
  });

  test("importFromFile reads entries from an old-marker section", () => {
    const remoteId = "019505a1-7c00-7000-8000-aabbccddeeff";
    const oldSection = `${OLD_LORE_SECTION_START}\n\n## Long-term Knowledge\n\n### Decision\n\n<!-- lore:${remoteId} -->\n* **Auth strategy**: OAuth2 with PKCE\n\n${LORE_SECTION_END}\n`;
    writeFile(oldSection);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entry = ltm.get(remoteId);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Auth strategy");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
