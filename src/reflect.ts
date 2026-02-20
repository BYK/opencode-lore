import { tool } from "@opencode-ai/plugin/tool";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import { db, ensureProject } from "./db";
import { serialize, inline, h, p, ul, lip, liph, t, root } from "./markdown";

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  created_at: number;
  session_id: string;
};

function searchDistillations(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
}): Distillation[] {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 10;
  // Search distillation narratives and facts with LIKE since we don't have FTS on them
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  const conditions = terms
    .map(() => "LOWER(observations) LIKE ?")
    .join(" AND ");
  const params: string[] = [];
  for (const term of terms) {
    params.push(`%${term}%`);
  }

  const query = input.sessionID
    ? `SELECT id, observations, generation, created_at, session_id FROM distillations WHERE project_id = ? AND session_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, observations, generation, created_at, session_id FROM distillations WHERE project_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`;
  const allParams = input.sessionID
    ? [pid, input.sessionID, ...params, limit]
    : [pid, ...params, limit];

  return db()
    .query(query)
    .all(...allParams) as Distillation[];
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

export function createRecallTool(projectPath: string): ReturnType<typeof tool> {
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

      const temporalResults =
        scope === "knowledge"
          ? []
          : temporal.search({
              projectPath,
              query: args.query,
              sessionID: scope === "session" ? sid : undefined,
              limit: 10,
            });

      const distillationResults =
        scope === "knowledge"
          ? []
          : searchDistillations({
              projectPath,
              query: args.query,
              sessionID: scope === "session" ? sid : undefined,
              limit: 5,
            });

      const knowledgeResults =
        scope === "session"
          ? []
          : ltm.search({
              query: args.query,
              projectPath,
              limit: 10,
            });

      return formatResults({
        temporalResults,
        distillationResults,
        knowledgeResults,
      });
    },
  });
}
