// @loreai/core — shared memory engine for Lore.
//
// This barrel re-exports every core module so hosts (the OpenCode plugin, the
// Pi extension, or any future adapter) can import from a single entry:
//
//   import { ltm, temporal, gradient, ... } from "@loreai/core"
//
// Modules that are intentionally not re-exported:
// - `db.ts` internals are exposed via specific functions (db(), ensureProject(), etc.)
// - No Plugin/Hooks surface — those live in host-specific packages.

export * as temporal from "./temporal";
export * as ltm from "./ltm";
export * as distillation from "./distillation";
export * as curator from "./curator";
export * as embedding from "./embedding";
export * as latReader from "./lat-reader";
export * as log from "./log";

export {
  runRecall,
  RECALL_TOOL_DESCRIPTION,
  RECALL_PARAM_DESCRIPTIONS,
  type RecallInput,
  type RecallResult,
  type RecallScope,
  type ScoredDistillation,
} from "./recall";

export type {
  LoreMessage,
  LoreUserMessage,
  LoreAssistantMessage,
  LorePart,
  LoreTextPart,
  LoreReasoningPart,
  LoreToolPart,
  LoreGenericPart,
  LoreToolState,
  LoreToolStatePending,
  LoreToolStateRunning,
  LoreToolStateCompleted,
  LoreToolStateError,
  LoreMessageWithParts,
  LLMClient,
} from "./types";
export { isTextPart, isReasoningPart, isToolPart } from "./types";

export { load, config, type LoreConfig } from "./config";
export {
  db,
  ensureProject,
  isFirstRun,
  projectId,
  projectName,
  loadForceMinLayer,
  saveForceMinLayer,
  close,
} from "./db";
export {
  transform,
  setModelLimits,
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
} from "./gradient";
export {
  formatKnowledge,
  formatDistillations,
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
  CURATOR_SYSTEM,
  curatorUser,
  CONSOLIDATION_SYSTEM,
  consolidationUser,
  QUERY_EXPANSION_SYSTEM,
  COMPACT_SUMMARY_TEMPLATE,
  buildCompactPrompt,
} from "./prompt";
export { shouldImport, importFromFile, exportToFile } from "./agents-file";
export { workerSessionIDs, isWorkerSession } from "./worker";
export {
  ftsQuery,
  ftsQueryOr,
  EMPTY_QUERY,
  reciprocalRankFusion,
  expandQuery,
  extractTopTerms,
} from "./search";
export {
  serialize,
  inline,
  h,
  p,
  ul,
  lip,
  liph,
  t,
  root,
  strong,
  normalize,
  sanitizeSurrogates,
  unescapeMarkdown,
} from "./markdown";
