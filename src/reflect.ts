import { tool } from "@opencode-ai/plugin/tool";
import type { createOpencodeClient } from "@opencode-ai/sdk";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import * as log from "./log";
import { db, ensureProject } from "./db";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY, reciprocalRankFusion, expandQuery } from "./search";
import { serialize, inline, h, p, ul, lip, liph, t, root } from "./markdown";
import type { LoreConfig } from "./config";

type Client = ReturnType<typeof createOpencodeClient>;

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  created_at: number;
  session_id: string;
};

// LIKE-based fallback for when FTS5 fails unexpectedly on distillations.
function searchDistillationsLike(input: {
  pid: string;
  query: string;
  sessionID?: string;
  limit: number;
}): Distillation[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const conditions = terms
    .map(() => "LOWER(observations) LIKE ?")
    .join(" AND ");
  const likeParams = terms.map((t) => `%${t}%`);
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

type ScoredDistillation = Distillation & { rank: number };

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
    }).map((d, i) => ({ ...d, rank: -(10 - i) }));
  }
}

function formatResults(input: {
  temporalResults: temporal.TemporalMessage[];
  distillationResults: Distillation[];
  knowledgeResults: ltm.KnowledgeEntry[];
}): string {
  const children: ReturnType<typeof root>["children"] = [];

  if (input.knowledgeResults.length) {
    children.push(h(2, "Long-term Knowledge"));
    children.push(
      ul(
        input.knowledgeResults.map((k) =>
          liph(t(`[${k.category}] ${inline(k.title)}: ${inline(k.content)}`)),
        ),
      ),
    );
  }

  if (input.distillationResults.length) {
    children.push(h(2, "Distilled History"));
    for (const d of input.distillationResults) {
      children.push(p(inline(d.observations)));
    }
  }

  if (input.temporalResults.length) {
    children.push(h(2, "Raw Message Matches"));
    children.push(
      ul(
        input.temporalResults.map((m) => {
          const preview =
            m.content.length > 500
              ? m.content.slice(0, 500) + "..."
              : m.content;
          return lip(
            `[${m.role}] (session: ${m.session_id.slice(0, 8)}...) ${inline(preview)}`,
          );
        }),
      ),
    );
  }

  if (!children.length) return "No results found for this query.";
  return serialize(root(...children));
}

type TaggedResult =
  | { source: "knowledge"; item: ltm.ScoredKnowledgeEntry }
  | { source: "distillation"; item: ScoredDistillation }
  | { source: "temporal"; item: temporal.ScoredTemporalMessage };

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
      case "distillation": {
        const d = tagged.item;
        const preview =
          d.observations.length > 500
            ? d.observations.slice(0, 500) + "..."
            : d.observations;
        return lip(
          `**[distilled]** ${inline(preview)}`,
        );
      }
      case "temporal": {
        const m = tagged.item;
        const preview =
          m.content.length > 500
            ? m.content.slice(0, 500) + "..."
            : m.content;
        return lip(
          `**[temporal/${m.role}]** (session: ${m.session_id.slice(0, 8)}...) ${inline(preview)}`,
        );
      }
    }
  });

  return serialize(root(h(2, "Recall Results"), ul(items)));
}

export function createRecallTool(
  projectPath: string,
  knowledgeEnabled = true,
  client?: Client,
  searchConfig?: LoreConfig["search"],
): ReturnType<typeof tool> {
  return tool({
    description:
      "Search your persistent memory for this project. Your visible context is a trimmed window — older messages, decisions, and details may not be visible to you even within the current session. Use this tool whenever you need information that isn't in your current context: file paths, past decisions, user preferences, prior approaches, or anything from earlier in this conversation or previous sessions. Always prefer recall over assuming you don't have the information. Searches long-term knowledge, distilled history, and raw message archives.",
    args: {
      query: tool.schema
        .string()
        .describe(
          "What to search for — be specific. Include keywords, file names, or concepts.",
        ),
      scope: tool.schema
        .enum(["all", "session", "project", "knowledge"])
        .optional()
        .describe(
          "Search scope: 'all' (default) searches everything, 'session' searches current session only, 'project' searches all sessions in this project, 'knowledge' searches only long-term knowledge.",
        ),
    },
    async execute(args, context) {
      const scope = args.scope ?? "all";
      const sid = context.sessionID;
      const limit = searchConfig?.recallLimit ?? 10;

      // If the query is all stopwords / single chars, short-circuit with guidance
      if (ftsQuery(args.query) === EMPTY_QUERY) {
        return "Query too vague — try using specific keywords, file names, or technical terms.";
      }

      // Optional query expansion: generate alternative phrasings via LLM
      let queries = [args.query];
      if (searchConfig?.queryExpansion && client && sid) {
        try {
          queries = await expandQuery(client, args.query, sid);
        } catch (err) {
          log.info("recall: query expansion failed, using original:", err);
        }
      }

      // Run scored searches for each query variant
      // Original query is always first; if expansion produced extras,
      // we include the original twice in the RRF lists (2× weight).
      const allRrfLists: Array<{ items: TaggedResult[]; key: (r: TaggedResult) => string }> = [];

      for (const query of queries) {
        const knowledgeResults: ltm.ScoredKnowledgeEntry[] = [];
        if (knowledgeEnabled && scope !== "session") {
          try {
            knowledgeResults.push(
              ...ltm.searchScored({
                query,
                projectPath,
                limit,
              }),
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
                query,
                sessionID: scope === "session" ? sid : undefined,
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
                query,
                sessionID: scope === "session" ? sid : undefined,
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

      // Fuse results using Reciprocal Rank Fusion across all query variants
      const fused = reciprocalRankFusion<TaggedResult>(allRrfLists);

      return formatFusedResults(fused, 20);
    },
  });
}
