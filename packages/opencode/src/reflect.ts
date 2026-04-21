/**
 * OpenCode adapter for Lore's recall tool.
 *
 * Thin wrapper around `runRecall()` from `@loreai/core` that exposes it to
 * OpenCode's LLM via the plugin SDK's `tool()` helper. All search, scoring,
 * and formatting logic lives in the core package — this file only handles
 * the OpenCode-specific registration details.
 */
import { tool } from "@opencode-ai/plugin/tool";
import {
  RECALL_PARAM_DESCRIPTIONS,
  RECALL_TOOL_DESCRIPTION,
  runRecall,
  type LLMClient,
  type LoreConfig,
} from "@loreai/core";

export function createRecallTool(
  projectPath: string,
  knowledgeEnabled = true,
  llmFactory?: (sessionID: string) => LLMClient,
  searchConfig?: LoreConfig["search"],
): ReturnType<typeof tool> {
  return tool({
    description: RECALL_TOOL_DESCRIPTION,
    args: {
      query: tool.schema.string().describe(RECALL_PARAM_DESCRIPTIONS.query),
      scope: tool.schema
        .enum(["all", "session", "project", "knowledge"])
        .optional()
        .describe(RECALL_PARAM_DESCRIPTIONS.scope),
    },
    async execute(args, context) {
      const sid = context.sessionID;
      return runRecall({
        query: args.query,
        scope: args.scope ?? "all",
        projectPath,
        sessionID: sid,
        knowledgeEnabled,
        llm: llmFactory && sid ? llmFactory(sid) : undefined,
        searchConfig,
      });
    },
  });
}
