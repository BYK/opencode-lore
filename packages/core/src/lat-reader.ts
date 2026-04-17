/**
 * lat.md reader — indexes lat.md/ directory sections for recall integration.
 *
 * When a project has a `lat.md/` directory (from the lat.md knowledge graph tool),
 * this module parses the markdown files, extracts hierarchical sections, and stores
 * them in SQLite with FTS5 indexing. Sections are included in recall results via
 * RRF fusion and in LTM system-prompt injection via session-context scoring.
 *
 * Change detection uses SHA-256 content hashes per file — unchanged files are skipped.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, relative, basename } from "path";
import { remark } from "remark";
import type { Root, Heading, Paragraph, Text } from "mdast";
import { db, ensureProject } from "./db";
import { sha256 } from "#db/driver";
import { ftsQuery, ftsQueryOr, extractTopTerms, EMPTY_QUERY } from "./search";
import * as log from "./log";

const processor = remark();

// ~3 chars per token — same heuristic as ltm.ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export type LatSection = {
  id: string;
  project_id: string;
  file: string;
  heading: string;
  depth: number;
  content: string;
  content_hash: string;
  first_paragraph: string | null;
  updated_at: number;
};

export type ScoredLatSection = LatSection & { rank: number };

// ---- Section parsing ----

type ParsedSection = {
  id: string;
  file: string;
  heading: string;
  depth: number;
  content: string;
  first_paragraph: string | null;
};

/** Extract heading text from an mdast Heading node. */
function headingText(node: Heading): string {
  return node.children
    .filter((c): c is Text => c.type === "text")
    .map((c) => c.value)
    .join("");
}

/** Extract inline text from a paragraph (flattening nested phrasing). */
function paragraphText(node: Paragraph): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.type === "text") parts.push(child.value);
    else if (child.type === "inlineCode") parts.push("`" + child.value + "`");
    else if ("children" in child) {
      for (const gc of child.children) {
        if ("value" in gc && typeof gc.value === "string") parts.push(gc.value);
      }
    }
  }
  return parts.join("");
}

/**
 * Parse a single markdown file into sections.
 * Each heading creates a section; content is everything between headings.
 * Section IDs use the lat.md convention: `file#Heading#SubHeading`.
 */
export function parseSections(filePath: string, content: string, projectRoot: string): ParsedSection[] {
  const tree = processor.parse(content) as Root;
  const fileRel = relative(projectRoot, filePath).replace(/\.md$/, "");
  const lines = content.split("\n");

  // Collect headings with positions
  const headings: Array<{ node: Heading; text: string; line: number; depth: number }> = [];
  for (const node of tree.children) {
    if (node.type === "heading" && node.position) {
      headings.push({
        node,
        text: headingText(node),
        line: node.position.start.line,
        depth: node.depth,
      });
    }
  }

  if (!headings.length) return [];

  // Build hierarchical IDs using a depth stack (same algorithm as lat.md's lattice.ts)
  const stack: Array<{ id: string; depth: number }> = [];
  const sections: ParsedSection[] = [];

  for (let i = 0; i < headings.length; i++) {
    const { text, depth, line } = headings[i];

    // Pop stack until we find a parent with smaller depth
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const id = parent ? `${parent.id}#${text}` : `${fileRel}#${text}`;

    stack.push({ id, depth });

    // Content: lines from after this heading to before the next heading (or EOF)
    const startLine = line; // 1-indexed
    const endLine = i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length;

    // Skip the heading line itself, collect content
    const contentLines = lines.slice(startLine, endLine);
    const sectionContent = contentLines.join("\n").trim();

    // First paragraph: find the first paragraph node after this heading
    let firstParagraph: string | null = null;
    for (const node of tree.children) {
      if (!node.position) continue;
      if (node.position.start.line <= startLine) continue;
      if (i + 1 < headings.length && node.position.start.line >= headings[i + 1].line) break;
      if (node.type === "paragraph") {
        const text = paragraphText(node);
        firstParagraph = text.length > 250 ? text.slice(0, 250) : text;
        break;
      }
    }

    sections.push({
      id,
      file: fileRel,
      heading: text,
      depth,
      content: sectionContent,
      first_paragraph: firstParagraph,
    });
  }

  return sections;
}

// ---- File discovery ----

/** Recursively list all .md files in a directory. */
function listMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(...listMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory not readable — skip
  }
  return results.sort();
}

/** Compute SHA-256 hash of file content for change detection. */
function contentHash(content: string): string {
  return sha256(content);
}

// ---- Public API ----

/** Check if a project has a lat.md/ directory. */
export function hasLatDir(projectPath: string): boolean {
  const latDir = join(projectPath, "lat.md");
  return existsSync(latDir) && statSync(latDir).isDirectory();
}

/**
 * Refresh the lat_sections cache for a project.
 * Scans lat.md/ directory, parses markdown files, and upserts sections.
 * Skips files whose content hash hasn't changed since last scan.
 * Removes sections from files that no longer exist.
 *
 * @returns Number of sections updated/inserted
 */
export function refresh(projectPath: string): number {
  const latDir = join(projectPath, "lat.md");
  if (!existsSync(latDir) || !statSync(latDir).isDirectory()) return 0;

  const pid = ensureProject(projectPath);
  const files = listMarkdownFiles(latDir);
  let upserted = 0;

  // Track which files we've seen for cleanup
  const seenFiles = new Set<string>();

  const upsertStmt = db().query(
    `INSERT OR REPLACE INTO lat_sections (id, project_id, file, heading, depth, content, content_hash, first_paragraph, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fileRel = relative(projectPath, filePath);
    seenFiles.add(fileRel);
    const hash = contentHash(content);

    // Check if any section from this file already has this hash
    const existing = db()
      .query("SELECT content_hash FROM lat_sections WHERE project_id = ? AND file = ? LIMIT 1")
      .get(pid, fileRel.replace(/\.md$/, "")) as { content_hash: string } | null;

    if (existing && existing.content_hash === hash) {
      continue; // File unchanged
    }

    // Delete old sections for this file before inserting new ones
    db()
      .query("DELETE FROM lat_sections WHERE project_id = ? AND file = ?")
      .run(pid, fileRel.replace(/\.md$/, ""));

    const sections = parseSections(filePath, content, projectPath);
    const now = Date.now();

    for (const section of sections) {
      upsertStmt.run(
        section.id,
        pid,
        section.file,
        section.heading,
        section.depth,
        section.content,
        hash,
        section.first_paragraph,
        now,
      );
      upserted++;
    }
  }

  // Cleanup: remove sections from files that no longer exist
  const seenFileStems = new Set([...seenFiles].map((f) => f.replace(/\.md$/, "")));
  const allFiles = db()
    .query("SELECT DISTINCT file FROM lat_sections WHERE project_id = ?")
    .all(pid) as Array<{ file: string }>;

  for (const row of allFiles) {
    if (!seenFileStems.has(row.file)) {
      db().query("DELETE FROM lat_sections WHERE project_id = ? AND file = ?").run(pid, row.file);
      log.info(`lat-reader: removed sections for deleted file ${row.file}`);
    }
  }

  if (upserted > 0) {
    log.info(`lat-reader: indexed ${upserted} sections from ${files.length} files`);
  }

  return upserted;
}

/**
 * Search lat sections by FTS5 with BM25 scoring.
 * Uses AND-then-OR fallback (same pattern as knowledge search).
 */
export function searchScored(input: {
  query: string;
  projectPath: string;
  limit?: number;
}): ScoredLatSection[] {
  const limit = input.limit ?? 10;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const pid = ensureProject(input.projectPath);

  const ftsSQL = `SELECT s.id, s.project_id, s.file, s.heading, s.depth, s.content,
         s.content_hash, s.first_paragraph, s.updated_at,
         bm25(lat_sections_fts, 6.0, 2.0) as rank
       FROM lat_sections s
       JOIN lat_sections_fts f ON s.rowid = f.rowid
       WHERE lat_sections_fts MATCH ?
       AND s.project_id = ?
       ORDER BY rank LIMIT ?`;

  try {
    const results = db().query(ftsSQL).all(q, pid, limit) as ScoredLatSection[];
    if (results.length) return results;

    // AND returned nothing — try OR fallback
    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    return db().query(ftsSQL).all(qOr, pid, limit) as ScoredLatSection[];
  } catch {
    return [];
  }
}

/**
 * Score lat sections against session context for LTM injection.
 * Uses OR-based FTS5 BM25 (same approach as ltm.ts scoreEntriesFTS).
 *
 * @returns Scored entries sorted by score descending, capped at maxTokens budget
 */
export function scoreForSession(
  projectPath: string,
  sessionContext: string,
  maxTokens: number,
): LatSection[] {
  if (!hasLatDir(projectPath)) return [];

  const pid = ensureProject(projectPath);
  const terms = extractTopTerms(sessionContext);
  if (!terms.length) return [];

  const q = terms.map((t) => `${t}*`).join(" OR ");

  let results: Array<LatSection & { rank: number }>;
  try {
    results = db()
      .query(
        `SELECT s.id, s.project_id, s.file, s.heading, s.depth, s.content,
                s.content_hash, s.first_paragraph, s.updated_at,
                bm25(lat_sections_fts, 6.0, 2.0) as rank
         FROM lat_sections s
         JOIN lat_sections_fts f ON s.rowid = f.rowid
         WHERE lat_sections_fts MATCH ?
         AND s.project_id = ?
         ORDER BY rank`,
      )
      .all(q, pid) as Array<LatSection & { rank: number }>;
  } catch {
    return [];
  }

  if (!results.length) return [];

  // Greedy-pack into token budget
  const HEADER_OVERHEAD = 10;
  let used = HEADER_OVERHEAD;
  const packed: LatSection[] = [];

  for (const entry of results) {
    if (used >= maxTokens) break;
    const cost = estimateTokens(entry.heading + (entry.first_paragraph ?? entry.content)) + 5;
    if (used + cost > maxTokens) continue;
    packed.push(entry);
    used += cost;
  }

  return packed;
}

/** Count lat sections for a project. */
export function count(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const row = db()
    .query("SELECT COUNT(*) as cnt FROM lat_sections WHERE project_id = ?")
    .get(pid) as { cnt: number };
  return row.cnt;
}
