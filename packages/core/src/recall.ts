/**
 * Recall — unified search across Lore's memory sources.
 *
 * Pure search + result-formatting logic shared by every host's recall tool.
 * Hosts (OpenCode plugin, Pi extension, future ACP server) wrap `runRecall()`
 * in their tool-registration mechanism:
 *   - OpenCode: `tool()` from `@opencode-ai/plugin/tool`
 *   - Pi: `pi.registerTool()` with TypeBox schema
 *
 * Behavior is identical across hosts so curated knowledge travels with the user.
 */
import * as latReader from "./lat-reader";
import * as ltm from "./ltm";
import * as temporal from "./temporal";
import * as embedding from "./embedding";
import * as log from "./log";
import { db, ensureProject, projectName } from "./db";
import type { LoreConfig } from "./config";
import type { LLMClient } from "./types";
import {
  EMPTY_QUERY,
  expandQuery,
  ftsQuery,
  ftsQueryOr,
  reciprocalRankFusion,
} from "./search";
import { h, inline, lip, liph, p, root, serialize, t, ul } from "./markdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  created_at: number;
  session_id: string;
};

export type ScoredDistillation = Distillation & { rank: number };

export type RecallScope = "all" | "session" | "project" | "knowledge";

export type RecallInput = {
  query: string;
  /** Narrow the search surface. Defaults to `"all"`. */
  scope?: RecallScope;
  /** Project root — used by all scoring paths. */
  projectPath: string;
  /** Current session ID — required when `scope === "session"`. */
  sessionID?: string;
  /** Whether to include long-term knowledge results. Default `true`. */
  knowledgeEnabled?: boolean;
  /** Optional LLM client for query expansion (if `config.search.queryExpansion`). */
  llm?: LLMClient;
  /** Search config — provides recallLimit, queryExpansion, ftsWeights, etc. */
  searchConfig?: LoreConfig["search"];
};

/** Result of a full recall run — markdown-formatted string for the LLM. */
export type RecallResult = string;

type TaggedResult =
  | { source: "knowledge"; item: ltm.ScoredKnowledgeEntry }
  | {
      source: "cross-knowledge";
      item: ltm.ScoredKnowledgeEntry;
      projectLabel: string;
    }
  | { source: "distillation"; item: ScoredDistillation }
  | { source: "temporal"; item: temporal.ScoredTemporalMessage }
  | { source: "lat-section"; item: latReader.ScoredLatSection };

// ---------------------------------------------------------------------------
// Distillation search
// ---------------------------------------------------------------------------

/** LIKE-based fallback for when FTS5 fails unexpectedly on distillations. */
function searchDistillationsLike(input: {
  pid: string;
  query: string;
  sessionID?: string;
  limit: number;
}): Distillation[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (!terms.length) return [];
  const conditions = terms
    .map(() => "LOWER(observations) LIKE ?")
    .join(" AND ");
  const likeParams = terms.map((term) => `%${term}%`);
  const sql = input.sessionID
    ? `SELECT id, observations, generation, created_at, session_id FROM distillations WHERE project_id = ? AND session_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, observations, generation, created_at, session_id FROM distillations WHERE project_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`;
  const allParams = input.sessionID
    ? [input.pid, input.sessionID, ...likeParams, input.limit]
    : [input.pid, ...likeParams, input.limit];
  return db()
    .query(sql)
    .all(...allParams) as Distillation[];
}

function searchDistillationsScored(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
}): ScoredDistillation[] {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 10;
  const q = ftsQuery(input.query);
  if (q === EMPTY_QUERY) return [];

  const ftsSQL = input.sessionID
    ? `SELECT d.id, d.observations, d.generation, d.created_at, d.session_id, rank
       FROM distillations d
       JOIN distillation_fts f ON d.rowid = f.rowid
       WHERE distillation_fts MATCH ?
       AND d.project_id = ? AND d.session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT d.id, d.observations, d.generation, d.created_at, d.session_id, rank
       FROM distillations d
       JOIN distillation_fts f ON d.rowid = f.rowid
       WHERE distillation_fts MATCH ?
       AND d.project_id = ?
       ORDER BY rank LIMIT ?`;
  const params = input.sessionID
    ? [q, pid, input.sessionID, limit]
    : [q, pid, limit];

  try {
    const results = db().query(ftsSQL).all(...params) as ScoredDistillation[];
    if (results.length) return results;

    // AND returned nothing — try OR fallback
    const qOr = ftsQueryOr(input.query);
    if (qOr === EMPTY_QUERY) return [];
    const paramsOr = input.sessionID
      ? [qOr, pid, input.sessionID, limit]
      : [qOr, pid, limit];
    return db().query(ftsSQL).all(...paramsOr) as ScoredDistillation[];
  } catch {
    // FTS5 failed — fall back to LIKE search with synthetic rank
    return searchDistillationsLike({
      pid,
      query: input.query,
      sessionID: input.sessionID,
      limit,
    }).map((dist, i) => ({ ...dist, rank: -(10 - i) }));
  }
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatFusedResults(
  results: Array<{ item: TaggedResult; score: number }>,
  maxResults: number,
): string {
  if (!results.length) return "No results found for this query.";

  const items = results.slice(0, maxResults).map(({ item: tagged }) => {
    switch (tagged.source) {
      case "knowledge": {
        const k = tagged.item;
        return liph(
          t(
            `**[knowledge/${k.category}]** ${inline(k.title)}: ${inline(k.content)}`,
          ),
        );
      }
      case "cross-knowledge": {
        const k = tagged.item;
        return liph(
          t(
            `**[knowledge/${k.category} from: ${tagged.projectLabel}]** ${inline(k.title)}: ${inline(k.content)}`,
          ),
        );
      }
      case "distillation": {
        const d = tagged.item;
        const preview =
          d.observations.length > 500
            ? d.observations.slice(0, 500) + "..."
            : d.observations;
        return lip(`**[distilled]** ${inline(preview)}`);
      }
      case "temporal": {
        const m = tagged.item;
        const preview =
          m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
        return lip(
          `**[temporal/${m.role}]** (session: ${m.session_id.slice(0, 8)}...) ${inline(preview)}`,
        );
      }
      case "lat-section": {
        const s = tagged.item;
        const preview = s.first_paragraph
          ? inline(s.first_paragraph)
          : inline(
              s.content.length > 300 ? s.content.slice(0, 300) + "..." : s.content,
            );
        return liph(
          t(`**[lat.md/${s.file}]** ${inline(s.heading)}: ${preview}`),
        );
      }
    }
  });

  return serialize(root(h(2, "Recall Results"), ul(items)));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Full recall run: search every relevant source, fuse with RRF, format as markdown. */
export async function runRecall(input: RecallInput): Promise<RecallResult> {
  const {
    query,
    scope = "all",
    projectPath,
    sessionID,
    knowledgeEnabled = true,
    llm,
    searchConfig,
  } = input;

  const limit = searchConfig?.recallLimit ?? 10;

  // Short-circuit vague queries — stopwords-only would match everything.
  if (ftsQuery(query) === EMPTY_QUERY) {
    return "Query too vague — try using specific keywords, file names, or technical terms.";
  }

  // Optional query expansion: generate alternative phrasings via LLM.
  let queries = [query];
  if (searchConfig?.queryExpansion && llm) {
    try {
      queries = await expandQuery(llm, query);
    } catch (err) {
      log.info("recall: query expansion failed, using original:", err);
    }
  }

  // Collect per-query RRF lists. Original query is always first; if expansion
  // produced extras, we still weight the original twice by adding both original
  // and expanded lists (RRF naturally weights items appearing in more lists).
  const allRrfLists: Array<{
    items: TaggedResult[];
    key: (r: TaggedResult) => string;
  }> = [];

  for (const q of queries) {
    const knowledgeResults: ltm.ScoredKnowledgeEntry[] = [];
    if (knowledgeEnabled && scope !== "session") {
      try {
        knowledgeResults.push(
          ...ltm.searchScored({ query: q, projectPath, limit }),
        );
      } catch (err) {
        log.error("recall: knowledge search failed:", err);
      }
    }

    const distillationResults: ScoredDistillation[] = [];
    if (scope !== "knowledge") {
      try {
        distillationResults.push(
          ...searchDistillationsScored({
            projectPath,
            query: q,
            sessionID: scope === "session" ? sessionID : undefined,
            limit,
          }),
        );
      } catch (err) {
        log.error("recall: distillation search failed:", err);
      }
    }

    const temporalResults: temporal.ScoredTemporalMessage[] = [];
    if (scope !== "knowledge") {
      try {
        temporalResults.push(
          ...temporal.searchScored({
            projectPath,
            query: q,
            sessionID: scope === "session" ? sessionID : undefined,
            limit,
          }),
        );
      } catch (err) {
        log.error("recall: temporal search failed:", err);
      }
    }

    allRrfLists.push(
      {
        items: knowledgeResults.map((item) => ({
          source: "knowledge" as const,
          item,
        })),
        key: (r) => `k:${r.item.id}`,
      },
      {
        items: distillationResults.map((item) => ({
          source: "distillation" as const,
          item,
        })),
        key: (r) => `d:${r.item.id}`,
      },
      {
        items: temporalResults.map((item) => ({
          source: "temporal" as const,
          item,
        })),
        key: (r) => `t:${r.item.id}`,
      },
    );
  }

  // Vector search on the original query (not expansions — avoid redundant embeds).
  if (embedding.isAvailable() && scope !== "session") {
    try {
      const [queryVec] = await embedding.embed([query], "query");

      // Knowledge vector search
      if (knowledgeEnabled) {
        const vectorHits = embedding.vectorSearch(queryVec, limit);
        const vectorTagged: TaggedResult[] = [];
        for (const hit of vectorHits) {
          const entry = ltm.get(hit.id);
          if (entry) {
            vectorTagged.push({
              source: "knowledge",
              item: { ...entry, rank: -hit.similarity },
            });
          }
        }
        if (vectorTagged.length) {
          // Same `k:` key prefix as BM25 knowledge — RRF merges, not duplicates
          allRrfLists.push({
            items: vectorTagged,
            key: (r) => `k:${r.item.id}`,
          });
        }
      }

      // Distillation vector search
      if (scope !== "knowledge") {
        const distVectorHits = embedding.vectorSearchDistillations(queryVec, limit);
        const distVectorTagged: TaggedResult[] = distVectorHits
          .map((hit): TaggedResult | null => {
            const row = db()
              .query(
                "SELECT id, observations, generation, created_at, session_id FROM distillations WHERE id = ?",
              )
              .get(hit.id) as Distillation | null;
            if (!row) return null;
            return {
              source: "distillation",
              item: { ...row, rank: -hit.similarity },
            };
          })
          .filter((r): r is TaggedResult => r !== null);
        if (distVectorTagged.length) {
          allRrfLists.push({
            items: distVectorTagged,
            key: (r) => `d:${r.item.id}`,
          });
        }
      }
    } catch (err) {
      log.info("recall: vector search failed:", err);
    }
  }

  // lat.md section search
  if (scope !== "session" && latReader.hasLatDir(projectPath)) {
    try {
      const latResults = latReader.searchScored({
        query,
        projectPath,
        limit,
      });
      if (latResults.length) {
        allRrfLists.push({
          items: latResults.map((item) => ({
            source: "lat-section" as const,
            item,
          })),
          key: (r) =>
            `lat:${(r as { source: "lat-section"; item: latReader.ScoredLatSection }).item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: lat.md section search failed:", err);
    }
  }

  // Cross-project knowledge discovery — only in "all" scope.
  if (knowledgeEnabled && scope === "all") {
    try {
      const crossProjectResults = ltm.searchScoredOtherProjects({
        query,
        excludeProjectPath: projectPath,
        limit,
      });
      if (crossProjectResults.length) {
        allRrfLists.push({
          items: crossProjectResults.map((item: ltm.ScoredKnowledgeEntry) => {
            const label =
              (item.project_id ? projectName(item.project_id) : null) ?? "other";
            return {
              source: "cross-knowledge" as const,
              item,
              projectLabel: label,
            } as TaggedResult;
          }),
          key: (r) => `xk:${r.item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: cross-project knowledge search failed:", err);
    }
  }

  const fused = reciprocalRankFusion<TaggedResult>(allRrfLists);
  return formatFusedResults(fused, 20);
}

/** Standard tool description reused verbatim by each host adapter. */
export const RECALL_TOOL_DESCRIPTION =
  "Search your persistent memory for this project. Your visible context is a trimmed window — older messages, decisions, and details may not be visible to you even within the current session. Use this tool whenever you need information that isn't in your current context: file paths, past decisions, user preferences, prior approaches, or anything from earlier in this conversation or previous sessions. Always prefer recall over assuming you don't have the information. Searches long-term knowledge, distilled history, and raw message archives.";

/** Standard parameter descriptions reused by each host adapter. */
export const RECALL_PARAM_DESCRIPTIONS = {
  query: "What to search for — be specific. Include keywords, file names, or concepts.",
  scope:
    "Search scope: 'all' (default) searches everything, 'session' searches current session only, 'project' searches all sessions in this project, 'knowledge' searches only long-term knowledge.",
};
