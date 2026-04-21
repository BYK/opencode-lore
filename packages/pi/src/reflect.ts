/**
 * Pi adapter for Lore's recall tool.
 *
 * Registers Lore's unified recall functionality as a Pi tool using TypeBox
 * for the parameter schema. The actual search/fusion/formatting logic lives
 * in `@loreai/core`'s `runRecall()`.
 */
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  RECALL_PARAM_DESCRIPTIONS,
  RECALL_TOOL_DESCRIPTION,
  runRecall,
  type LLMClient,
  type LoreConfig,
} from "@loreai/core";

// TypeBox schema for the tool's parameters. Matches the OpenCode tool's
// Zod schema exactly so behavior across hosts stays identical.
const RecallParams = Type.Object({
  query: Type.String({
    description: RECALL_PARAM_DESCRIPTIONS.query,
  }),
  scope: Type.Optional(
    StringEnum(["all", "session", "project", "knowledge"] as const, {
      description: RECALL_PARAM_DESCRIPTIONS.scope,
    }),
  ),
});

export function registerRecallTool(
  pi: ExtensionAPI,
  input: {
    projectPath: string;
    knowledgeEnabled: boolean;
    llmFactory: (ctx: ExtensionContext) => LLMClient;
    searchConfig?: LoreConfig["search"];
    /** Stable session identifier — Pi doesn't expose sessionID per call, so we
     *  synthesize one from the session file path and reuse it for all recall
     *  calls within this Pi instance. See index.ts for how this is computed. */
    sessionID: string;
  },
): void {
  pi.registerTool<typeof RecallParams, undefined>({
    name: "recall",
    label: "Recall",
    description: RECALL_TOOL_DESCRIPTION,
    parameters: RecallParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof RecallParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const result = await runRecall({
        query: params.query,
        scope: params.scope ?? "all",
        projectPath: input.projectPath,
        sessionID: input.sessionID,
        knowledgeEnabled: input.knowledgeEnabled,
        llm: input.llmFactory(ctx),
        searchConfig: input.searchConfig,
      });

      return {
        content: [{ type: "text" as const, text: result }],
        // `details` is required by AgentToolResult — undefined is fine for our
        // use case since nothing downstream introspects it.
        details: undefined,
      };
    },
  });
}
