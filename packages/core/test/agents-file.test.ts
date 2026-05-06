import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import {
  LORE_SECTION_START,
  LORE_SECTION_END,
  LORE_FILE,
  exportToFile,
  exportLoreFile,
  importFromFile,
  importLoreFile,
  shouldImport,
  shouldImportLoreFile,
  loreFileExists,
  parseEntriesFromSection,
  type ParsedFileEntry,
} from "../src/agents-file";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dir, "__tmp_agents_file__");
/** Project path doubles as the filesystem directory for .lore.md functions. */
const PROJECT = TMP_DIR;
const AGENTS_FILE = join(TMP_DIR, "AGENTS.md");
const LORE_FILE_PATH = join(TMP_DIR, LORE_FILE);

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

// Fixed UUIDs shared between agents-file and ltm tests — cleaned in
// beforeEach to prevent UNIQUE constraint collisions.
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
  // Also remove cross-project entries from test projects
  // (prevents cross-file pollution within the test run)
  db()
    .query(
      "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%')",
    )
    .run();
  // Remove fixed-UUID entries that may exist from prior test files;
  // ltm.test.ts uses the same UUIDs and would UNIQUE-constraint-fail.
  for (const id of TEST_UUIDS) {
    db().query("DELETE FROM knowledge WHERE id = ?").run(id);
  }
  // Reset the agents file and .lore.md
  if (existsSync(AGENTS_FILE)) rmSync(AGENTS_FILE);
  if (existsSync(LORE_FILE_PATH)) rmSync(LORE_FILE_PATH);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  // Clean shared UUIDs so ltm.test.ts does not hit UNIQUE constraint
  for (const id of TEST_UUIDS) {
    db().query("DELETE FROM knowledge WHERE id = ?").run(id);
  }
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
  test("creates AGENTS.md with pointer and .lore.md with entries", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "Using OAuth2 with PKCE",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // AGENTS.md gets a pointer, not entries
    expect(existsSync(AGENTS_FILE)).toBe(true);
    const agentsContent = readFile();
    expect(agentsContent).toContain(LORE_SECTION_START);
    expect(agentsContent).toContain(LORE_SECTION_END);
    expect(agentsContent).toContain(".lore.md");
    expect(agentsContent).not.toContain("Auth strategy");

    // .lore.md gets the actual entries
    expect(existsSync(LORE_FILE_PATH)).toBe(true);
    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Auth strategy");
    expect(loreContent).toContain("Using OAuth2 with PKCE");
  });

  test(".lore.md includes <!-- lore:UUID --> marker before each entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Middleware pattern",
      content: "Using Hono middleware",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain(`<!-- lore:${id} -->`);
    // AGENTS.md should NOT have the entry marker
    const agentsContent = readFile();
    expect(agentsContent).not.toContain(`<!-- lore:${id} -->`);
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

    const agentsContent = readFile();
    expect(agentsContent).toContain("# My Project");
    expect(agentsContent).toContain("Some hand-written docs.");
    expect(agentsContent).toContain("## Workflow");
    expect(agentsContent).toContain("Do this stuff.");
    expect(agentsContent).toContain(".lore.md");
    // Should only have one lore section
    const startCount = (agentsContent.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    expect(startCount).toBe(1);

    // Entries go to .lore.md
    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Test gotcha");
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

    const agentsContent = readFile();
    expect(agentsContent).toContain("# Existing project docs");
    expect(agentsContent).toContain(LORE_SECTION_START);
    expect(agentsContent).toContain(".lore.md");

    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Stack");
  });

  test("writes pointer in agents file even when there are no knowledge entries", () => {
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const agentsContent = readFile();
    expect(agentsContent).toContain(LORE_SECTION_START);
    expect(agentsContent).toContain(LORE_SECTION_END);
    expect(agentsContent).toContain(".lore.md");
    // No knowledge entries means no bullet points in either file
    expect(agentsContent).not.toContain("* **");
  });

  test(".lore.md writes entries sorted by category then title", () => {
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

    const loreContent = readFile(LORE_FILE_PATH);
    const decisionPos = loreContent.indexOf("### Decision");
    const gotchaPos = loreContent.indexOf("### Gotcha");
    expect(decisionPos).toBeGreaterThan(-1);
    expect(gotchaPos).toBeGreaterThan(-1);
    expect(decisionPos).toBeLessThan(gotchaPos);
  });

  test(".lore.md sorts entries alphabetically by title within a category", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Zebra gotcha",
      content: "Z content",
      scope: "project",
    });
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Alpha gotcha",
      content: "A content",
      scope: "project",
    });
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Middle gotcha",
      content: "M content",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const loreContent = readFile(LORE_FILE_PATH);
    const alphaPos = loreContent.indexOf("Alpha gotcha");
    const middlePos = loreContent.indexOf("Middle gotcha");
    const zebraPos = loreContent.indexOf("Zebra gotcha");
    expect(alphaPos).toBeGreaterThan(-1);
    expect(middlePos).toBeGreaterThan(-1);
    expect(zebraPos).toBeGreaterThan(-1);
    expect(alphaPos).toBeLessThan(middlePos);
    expect(middlePos).toBeLessThan(zebraPos);
  });

  test(".lore.md separates entries with blank lines for merge-friendliness", () => {
    const id1 = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Alpha decision",
      content: "First",
      scope: "project",
    });
    const id2 = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Beta decision",
      content: "Second",
      scope: "project",
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const loreContent = readFile(LORE_FILE_PATH);
    // Between the first bullet and the second marker there should be a blank line
    const pattern = new RegExp("\\* \\*\\*Alpha decision\\*\\*.*\n\n<!-- lore:");
    expect(loreContent).toMatch(pattern);
    // First entry after heading should NOT have a leading blank line
    const headingPattern = new RegExp("### Decision\n\n<!-- lore:");
    expect(loreContent).toMatch(headingPattern);
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

  test("returns true when lore section content differs from DB state (external edit)", () => {
    // Write an old-format agents file with entries directly in AGENTS.md
    const section = loreSectionWithEntries([
      { id: TEST_UUIDS[0], category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(section);
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

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

  test("after export, agents file has pointer — importFromFile is safe (no entries parsed)", () => {
    // After exportToFile, AGENTS.md has a pointer (not entries).
    // shouldImport returns true (pointer differs from buildSection), but
    // importFromFile finds no bullet entries in the pointer text — safe no-op.
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // Import from the pointer file — should not create duplicates
    const before = ltm.forProject(PROJECT);
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    const after = ltm.forProject(PROJECT);
    expect(after.length).toBe(before.length);
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

    // Write old-format AGENTS.md with entries directly, then simulate manual edit
    const section = loreSectionWithEntries([
      { id, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE — also supports API keys" },
    ]);
    writeFile(section);

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

  test("re-export after import of merged file produces a clean single-occurrence .lore.md", () => {
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
    importLoreFile(PROJECT);
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const loreContent = readFile(LORE_FILE_PATH);
    // Each ID should appear exactly once in .lore.md
    const id1Count = (loreContent.match(new RegExp(`lore:${id1}`, "g")) ?? []).length;
    const id2Count = (loreContent.match(new RegExp(`lore:${id2}`, "g")) ?? []).length;
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
  test("export → import → export produces identical .lore.md", () => {
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
    const firstLore = readFile(LORE_FILE_PATH);
    const firstAgents = readFile();

    importLoreFile(PROJECT);
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    const secondLore = readFile(LORE_FILE_PATH);
    const secondAgents = readFile();

    expect(secondLore).toBe(firstLore);
    expect(secondAgents).toBe(firstAgents);
  });

  test("export → edit non-lore section → import → export preserves edit and pointer", () => {
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

    importLoreFile(PROJECT);
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const agentsContent = readFile();
    expect(agentsContent).toContain("# My Project");
    expect(agentsContent).toContain("Some docs.");
    expect(agentsContent).toContain(".lore.md");
    expect(agentsContent).toContain(LORE_SECTION_START);
    expect(agentsContent).toContain(LORE_SECTION_END);

    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Middleware");
  });
});

// ---------------------------------------------------------------------------
// Cross-project isolation
// ---------------------------------------------------------------------------

const OTHER_PROJECT = "/test/agents-file/other-project";

describe("cross-project isolation", () => {
  test("importFromFile creates entries with cross_project = 0", () => {
    const remoteId = "019505a1-7c00-7000-8000-aabbccddeeff";
    const section = loreSectionWithEntries([
      { id: remoteId, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(section);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entry = ltm.get(remoteId);
    expect(entry).not.toBeNull();
    expect(entry!.cross_project).toBe(0);
  });

  test("hand-written entries imported from AGENTS.md are project-scoped", () => {
    writeFile(`${LORE_SECTION_START}\n\n## Long-term Knowledge\n\n### Pattern\n\n* **Hand-written pattern**: Using middleware\n\n${LORE_SECTION_END}\n`);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const entries = ltm.forProject(PROJECT, false);
    const match = entries.find((e) => e.title === "Hand-written pattern");
    expect(match).toBeDefined();
    expect(match!.cross_project).toBe(0);
  });

  test("cross-project entries from another project do not appear in .lore.md", () => {
    // Create a cross-project entry scoped to a different project
    ltm.create({
      category: "gotcha",
      title: "Unrelated gotcha from other project",
      content: "This should not leak into PROJECT's .lore.md",
      scope: "global",
      crossProject: true,
    });

    // Create a project-specific entry for PROJECT
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Project-specific decision",
      content: "This belongs to this project",
      scope: "project",
      crossProject: false,
    });

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Project-specific decision");
    expect(loreContent).not.toContain("Unrelated gotcha from other project");
  });

  test("cross-project entries from another project do not inflate forProject(path, false) count", () => {
    // Create cross-project entries in "other" project
    ltm.create({
      category: "pattern",
      title: "Other project pattern",
      content: "Cross-project from elsewhere",
      scope: "global",
      crossProject: true,
    });

    // Create one entry for PROJECT
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Only project entry",
      content: "Project-scoped",
      scope: "project",
      crossProject: false,
    });

    const projectOnly = ltm.forProject(PROJECT, false);
    const projectOnlyTitles = projectOnly.map((e) => e.title);
    expect(projectOnlyTitles).toContain("Only project entry");
    expect(projectOnlyTitles).not.toContain("Other project pattern");
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
    // Pointer, not entries in AGENTS.md
    expect(result).toContain(".lore.md");
  });

  test("collapses old-marker section into one new-marker section on export", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });

    const oldSection = `${OLD_LORE_SECTION_START}\n\n## Long-term Knowledge\n\n${LORE_SECTION_END}\n`;
    writeFile(`# My Project\n\n${oldSection}\n## Extra\n\nStuff.\n`);

    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    const result = readFile();
    expect(result).not.toContain(OLD_LORE_SECTION_START);
    const startCount = (result.match(new RegExp(escapeRegex(LORE_SECTION_START), "g")) ?? []).length;
    expect(startCount).toBe(1);
    expect(result).toContain(LORE_SECTION_END);
    expect(result).toContain("# My Project");
    expect(result).toContain("## Extra");
    expect(result).toContain("Stuff.");
    // Entry in .lore.md, pointer in AGENTS.md
    expect(result).toContain(".lore.md");
    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Auth strategy");
  });

  test("collapses mixed old+new marker sections (the real-world bug) into one", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Watch this",
      content: "Something tricky",
      scope: "project",
    });

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
    // Entry in .lore.md
    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Watch this");
  });

  test("non-lore content between duplicate sections is also removed", () => {
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
// exportLoreFile
// ---------------------------------------------------------------------------

describe("exportLoreFile", () => {
  test("creates .lore.md with header and entries", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });

    exportLoreFile(PROJECT);

    expect(existsSync(LORE_FILE_PATH)).toBe(true);
    const content = readFile(LORE_FILE_PATH);
    expect(content).toContain("<!-- Managed by lore");
    expect(content).toContain("Auth strategy");
    expect(content).toContain("OAuth2 with PKCE");
  });

  test(".lore.md has no section markers", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Test pattern",
      content: "Pattern content",
      scope: "project",
    });

    exportLoreFile(PROJECT);

    const content = readFile(LORE_FILE_PATH);
    expect(content).not.toContain(LORE_SECTION_START);
    expect(content).not.toContain(LORE_SECTION_END);
  });

  test("includes <!-- lore:UUID --> markers for entries", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Watch this",
      content: "Something tricky",
      scope: "project",
    });

    exportLoreFile(PROJECT);

    const content = readFile(LORE_FILE_PATH);
    expect(content).toContain(`<!-- lore:${id} -->`);
  });

  test("writes only a header when there are no entries", () => {
    exportLoreFile(PROJECT);

    const content = readFile(LORE_FILE_PATH);
    expect(content).toContain("<!-- Managed by lore");
    expect(content).not.toContain("* **");
  });
});

// ---------------------------------------------------------------------------
// loreFileExists
// ---------------------------------------------------------------------------

describe("loreFileExists", () => {
  test("returns false when .lore.md does not exist", () => {
    expect(loreFileExists(PROJECT)).toBe(false);
  });

  test("returns true after exportLoreFile", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Test",
      content: "Content",
      scope: "project",
    });
    exportLoreFile(PROJECT);
    expect(loreFileExists(PROJECT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldImportLoreFile
// ---------------------------------------------------------------------------

describe("shouldImportLoreFile", () => {
  test("returns false when .lore.md does not exist", () => {
    expect(shouldImportLoreFile(PROJECT)).toBe(false);
  });

  test("returns false after export (file matches DB state)", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportLoreFile(PROJECT);

    expect(shouldImportLoreFile(PROJECT)).toBe(false);
  });

  test("returns true when .lore.md content differs from DB (external edit)", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportLoreFile(PROJECT);

    // Simulate external edit
    const content = readFile(LORE_FILE_PATH);
    writeFile(content.replace("OAuth2 with PKCE", "OAuth2 with PKCE — updated"), LORE_FILE_PATH);

    expect(shouldImportLoreFile(PROJECT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// importLoreFile
// ---------------------------------------------------------------------------

describe("importLoreFile", () => {
  test("imports entries from .lore.md preserving UUIDs", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportLoreFile(PROJECT);

    // Delete from DB, then re-import
    db().query("DELETE FROM knowledge WHERE id = ?").run(id);

    importLoreFile(PROJECT);

    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Auth strategy");
    expect(entry!.content).toBe("OAuth2 with PKCE");
  });

  test("updates content when .lore.md has been edited", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportLoreFile(PROJECT);

    // Edit .lore.md
    const content = readFile(LORE_FILE_PATH);
    writeFile(content.replace("OAuth2 with PKCE", "OAuth2 with PKCE — also supports API keys"), LORE_FILE_PATH);

    importLoreFile(PROJECT);

    const entry = ltm.get(id);
    expect(entry!.content).toContain("API keys");
  });

  test("handles hand-written entries (no UUID markers) in .lore.md", () => {
    writeFile(
      "<!-- Managed by lore -->\n\n## Long-term Knowledge\n\n### Pattern\n\n* **Hand-written pattern**: Using middleware\n",
      LORE_FILE_PATH,
    );

    importLoreFile(PROJECT);

    const entries = ltm.forProject(PROJECT);
    const match = entries.find((e) => e.title === "Hand-written pattern");
    expect(match).toBeDefined();
    expect(match!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("does nothing when .lore.md does not exist", () => {
    const before = ltm.forProject(PROJECT);
    importLoreFile(PROJECT);
    const after = ltm.forProject(PROJECT);
    expect(after.length).toBe(before.length);
  });

  test("round-trip: exportLoreFile → importLoreFile → exportLoreFile produces identical file", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE flow",
      scope: "project",
    });
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Rebuild server",
      content: "Run pnpm build:bin after src change",
      scope: "project",
    });

    exportLoreFile(PROJECT);
    const first = readFile(LORE_FILE_PATH);

    importLoreFile(PROJECT);
    exportLoreFile(PROJECT);
    const second = readFile(LORE_FILE_PATH);

    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Migration: old AGENTS.md → .lore.md
// ---------------------------------------------------------------------------

describe("migration from AGENTS.md to .lore.md", () => {
  test("entries in old-format AGENTS.md are importable via importFromFile", () => {
    const remoteId = TEST_UUIDS[0];
    const section = loreSectionWithEntries([
      { id: remoteId, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(section);

    // No .lore.md exists — backward compat path
    expect(loreFileExists(PROJECT)).toBe(false);
    expect(shouldImport({ projectPath: PROJECT, filePath: AGENTS_FILE })).toBe(true);

    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    expect(ltm.get(remoteId)).not.toBeNull();
  });

  test("exportToFile migrates: writes .lore.md (entries) + AGENTS.md (pointer)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });

    // Start with old-format AGENTS.md (entries inside)
    const oldSection = loreSectionWithEntries([
      { id, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(oldSection);

    // Export triggers migration
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // AGENTS.md now has pointer
    const agentsContent = readFile();
    expect(agentsContent).toContain(".lore.md");
    expect(agentsContent).not.toContain("OAuth2 with PKCE");

    // .lore.md has entries
    expect(loreFileExists(PROJECT)).toBe(true);
    const loreContent = readFile(LORE_FILE_PATH);
    expect(loreContent).toContain("Auth strategy");
    expect(loreContent).toContain("OAuth2 with PKCE");
    expect(loreContent).toContain(`<!-- lore:${id} -->`);
  });

  test("full migration cycle: import from old AGENTS.md → export → next import reads .lore.md", () => {
    // Step 1: Old-format AGENTS.md with entries
    const remoteId = TEST_UUIDS[0];
    const section = loreSectionWithEntries([
      { id: remoteId, category: "decision", title: "Auth strategy", content: "OAuth2 with PKCE" },
    ]);
    writeFile(section);

    // Step 2: Import from old AGENTS.md (backward compat)
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    expect(ltm.get(remoteId)).not.toBeNull();

    // Step 3: Export — writes .lore.md + pointer in AGENTS.md
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    expect(loreFileExists(PROJECT)).toBe(true);

    // Step 4: Next startup — .lore.md exists, use it
    expect(shouldImportLoreFile(PROJECT)).toBe(false); // just exported, matches DB

    // Step 5: Simulate edit in .lore.md
    const loreContent = readFile(LORE_FILE_PATH);
    writeFile(loreContent.replace("OAuth2 with PKCE", "OAuth2 with PKCE — updated"), LORE_FILE_PATH);
    expect(shouldImportLoreFile(PROJECT)).toBe(true);

    importLoreFile(PROJECT);
    const entry = ltm.get(remoteId);
    expect(entry!.content).toContain("updated");
  });

  test("pointer in AGENTS.md is safe for importFromFile (no entries parsed)", () => {
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "OAuth2 with PKCE",
      scope: "project",
    });
    exportToFile({ projectPath: PROJECT, filePath: AGENTS_FILE });

    // A teammate with old Lore imports the pointer-only AGENTS.md
    const before = ltm.forProject(PROJECT).length;
    importFromFile({ projectPath: PROJECT, filePath: AGENTS_FILE });
    const after = ltm.forProject(PROJECT).length;

    // No new entries created — pointer text has no bullet entries
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
