/**
 * agents-file.ts — AGENTS.md export/import/sync for lore.
 *
 * Lore owns a clearly delimited section inside the file, bounded by HTML
 * comment markers. Everything outside those markers is preserved verbatim.
 * Each knowledge entry is preceded by a hidden <!-- lore:UUID --> comment so
 * the same entry can be tracked across machines and merge conflicts resolved
 * without duplication.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as ltm from "./ltm";
import { serialize, inline, h, ul, liph, strong, t, root, unescapeMarkdown } from "./markdown";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LORE_SECTION_START =
  "<!-- This section is auto-maintained by lore (https://github.com/BYK/opencode-lore) -->";
export const LORE_SECTION_END = "<!-- End lore-managed section -->";

/** Regex matching a valid UUID (v4 or v7) — 8-4-4-4-12 hex groups. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Matches `<!-- lore:UUID -->` tracking markers. */
const MARKER_RE = /^<!--\s*lore:([0-9a-f-]+)\s*-->$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedFileEntry = {
  /** UUID from `<!-- lore:UUID -->` marker, or null for hand-written entries. */
  id: string | null;
  category: string;
  title: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Section extraction helpers
// ---------------------------------------------------------------------------

/**
 * Split file content into three parts: before, lore section body, after.
 * Returns null for section body when markers are absent.
 */
function splitFile(fileContent: string): {
  before: string;
  section: string | null;
  after: string;
} {
  const startIdx = fileContent.indexOf(LORE_SECTION_START);
  const endIdx = fileContent.indexOf(LORE_SECTION_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { before: fileContent, section: null, after: "" };
  }

  const before = fileContent.slice(0, startIdx);
  const section = fileContent.slice(
    startIdx + LORE_SECTION_START.length,
    endIdx,
  );
  const after = fileContent.slice(endIdx + LORE_SECTION_END.length);
  return { before, section, after };
}

// ---------------------------------------------------------------------------
// Parse entries from a lore section body (or any markdown block)
// ---------------------------------------------------------------------------

/**
 * Extract ParsedFileEntry objects from a markdown section body.
 * Handles:
 * - `<!-- lore:UUID -->` markers before bullet points  → id set
 * - Bare bullet points without markers                → id null
 * - Category derived from the nearest preceding `### Heading`
 * - Malformed or non-UUID markers                    → id null (hand-written)
 * - Duplicate UUIDs                                  → both returned; caller deduplicates
 */
export function parseEntriesFromSection(section: string): ParsedFileEntry[] {
  const lines = section.split("\n");
  const entries: ParsedFileEntry[] = [];
  let currentCategory = "pattern";
  let pendingId: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    // Category heading: ### Decision / ### Gotcha / etc.
    const headingMatch = line.match(/^###\s+(.+)$/);
    if (headingMatch) {
      currentCategory = headingMatch[1].toLowerCase();
      pendingId = null;
      continue;
    }

    // Marker line: <!-- lore:UUID -->
    const markerMatch = line.match(MARKER_RE);
    if (markerMatch) {
      const candidate = markerMatch[1];
      pendingId = UUID_RE.test(candidate) ? candidate : null;
      continue;
    }

    // Bullet entry: * **Title**: Content
    const bulletMatch = line.match(/^\*\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (bulletMatch) {
      // Unescape remark's markdown escapes (e.g. \< → <, \\ → \).
      // Without this, each export/import cycle doubles the backslash-escapes,
      // exponentially inflating stored content.
      entries.push({
        id: pendingId,
        category: currentCategory,
        title: unescapeMarkdown(bulletMatch[1].trim()),
        content: unescapeMarkdown(bulletMatch[2].trim()),
      });
      pendingId = null; // consume the pending marker
      continue;
    }

    // Any non-matching non-empty line resets the pending marker
    if (line !== "" && !line.startsWith("##") && !line.startsWith("<!--")) {
      pendingId = null;
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Content hash (for change detection)
// ---------------------------------------------------------------------------

function hashSection(section: string): string {
  let h = 0;
  for (let i = 0; i < section.length; i++) {
    h = (Math.imul(31, h) + section.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex string
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Build the lore section body from DB entries
// ---------------------------------------------------------------------------

function buildSection(projectPath: string): string {
  // Export only project-specific entries (cross_project=0, project_id = this project).
  // Cross-project entries live in the shared DB on each machine and don't belong
  // in a per-project AGENTS.md — including them would inflate the file with
  // unrelated knowledge from every other project the user has worked on.
  const entries = ltm.forProject(projectPath, false);
  if (!entries.length) {
    return "\n";
  }

  // Group entries by category, preserving DB order (confidence DESC, updated_at DESC).
  const grouped = new Map<string, typeof entries>();
  for (const e of entries) {
    const group = grouped.get(e.category) ?? [];
    group.push(e);
    grouped.set(e.category, group);
  }

  // Build the section body by iterating entries directly, emitting each entry
  // with its own <!-- lore:UUID --> marker. This avoids the title-based Map
  // deduplication bug where multiple entries with the same title all got the
  // same UUID marker from the last Map.set() winner.
  const out: string[] = [""];

  // Section heading
  out.push("## Long-term Knowledge");

  for (const [category, items] of grouped) {
    out.push("");
    out.push(`### ${category.charAt(0).toUpperCase() + category.slice(1)}`);
    out.push("");
    for (const entry of items) {
      out.push(`<!-- lore:${entry.id} -->`);
      // Render the bullet using remark serializer for proper markdown escaping.
      // serialize(root(ul([liph(...)]))) produces "* **Title**: content\n".
      // Trim the trailing newline since we join with \n ourselves.
      const bullet = serialize(
        root(ul([liph(strong(inline(entry.title)), t(": " + inline(entry.content)))]))
      ).trimEnd();
      out.push(bullet);
    }
  }

  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Write current knowledge entries into the AGENTS.md file, preserving all
 * non-lore content. Creates the file if it doesn't exist.
 */
export function exportToFile(input: {
  projectPath: string;
  filePath: string;
}): void {
  const sectionBody = buildSection(input.projectPath);
  const newSection =
    LORE_SECTION_START + sectionBody + LORE_SECTION_END + "\n";

  let fileContent = "";
  if (existsSync(input.filePath)) {
    fileContent = readFileSync(input.filePath, "utf8");
  }

  const { before, after } = splitFile(fileContent);

  // Ensure there's a blank line separator before the section when appending
  const prefix = before.trimEnd();
  const prefixWithSep = prefix.length > 0 ? prefix + "\n\n" : "";
  const suffix = after.trimStart();
  const suffixWithSep = suffix.length > 0 ? "\n" + suffix : "";

  const result = prefixWithSep + newSection + suffixWithSep;

  mkdirSync(dirname(input.filePath), { recursive: true });
  writeFileSync(input.filePath, result, "utf8");
}

// ---------------------------------------------------------------------------
// shouldImport
// ---------------------------------------------------------------------------

/**
 * Returns true if the file needs to be imported:
 * - File exists and has never been processed (no lore markers)
 * - File exists and its lore section differs from what lore would currently produce
 */
export function shouldImport(input: {
  projectPath: string;
  filePath: string;
}): boolean {
  if (!existsSync(input.filePath)) return false;

  const fileContent = readFileSync(input.filePath, "utf8");
  const { section } = splitFile(fileContent);

  if (section === null) {
    // No lore markers — this is a hand-written file that hasn't been imported
    return fileContent.trim().length > 0;
  }

  // Compare the file's lore section body against what we'd produce now
  const expected = buildSection(input.projectPath);
  return hashSection(section) !== hashSection(expected);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Import knowledge entries from the agents file into the local DB.
 *
 * Behaviour per entry:
 * - Known UUID (already in DB)  → update content if it changed (manual edit)
 * - Unknown UUID (other machine)→ create with that exact ID
 * - No UUID (hand-written)      → create with a new UUIDv7
 * - Duplicate UUID in same file → first occurrence wins, rest ignored
 */
export function importFromFile(input: {
  projectPath: string;
  filePath: string;
}): void {
  if (!existsSync(input.filePath)) return;

  const fileContent = readFileSync(input.filePath, "utf8");
  const { section, before } = splitFile(fileContent);

  // Determine what to parse:
  // - If lore markers exist: parse ONLY the lore section body (avoid re-importing our own output)
  // - If no markers: parse the full file (first-time hand-written AGENTS.md import)
  const textToParse = section ?? fileContent;

  const fileEntries = parseEntriesFromSection(textToParse);
  if (!fileEntries.length) return;

  const seenIds = new Set<string>();

  for (const entry of fileEntries) {
    if (entry.id !== null) {
      // Deduplicate: if same UUID appears twice in file, first wins
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);

      const existing = ltm.get(entry.id);
      if (existing) {
        // Known entry — update only if content changed (manual edit in file)
        if (existing.content !== entry.content) {
          ltm.update(entry.id, { content: entry.content });
        }
      } else {
        // Unknown UUID — entry came from another machine, preserve its ID
        ltm.create({
          projectPath: input.projectPath,
          category: entry.category,
          title: entry.title,
          content: entry.content,
          scope: "project",
          id: entry.id,
        });
      }
    } else {
      // Hand-written entry — create with a new UUIDv7
      // Check for a near-duplicate by title to avoid double-import on re-runs
      const existing = ltm.forProject(input.projectPath, true);
      const titleMatch = existing.find(
        (e) => e.title.toLowerCase() === entry.title.toLowerCase(),
      );
      if (!titleMatch) {
        ltm.create({
          projectPath: input.projectPath,
          category: entry.category,
          title: entry.title,
          content: entry.content,
          scope: "project",
        });
      }
    }
  }
}
