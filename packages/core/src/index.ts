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
export * as data from "./data";
export * as distillation from "./distillation";
export * as curator from "./curator";
export * as embedding from "./embedding";
export * as embeddingVendor from "./embedding-vendor";
export * as latReader from "./lat-reader";
export * as patternExtract from "./pattern-extract";
export * as instructionDetect from "./instruction-detect";
export * as log from "./log";
export * as conversationImport from "./import";

export {
  runRecall,
  searchRecall,
  recallById,
  RECALL_TOOL_DESCRIPTION,
  RECALL_PARAM_DESCRIPTIONS,
  type RecallInput,
  type RecallResult,
  type RecallScope,
  type ScoredDistillation,
  type TaggedResult,
  type ScoredTaggedResult,
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

export { dataDir } from "./data-dir";
export { load, config, type LoreConfig } from "./config";
export {
  db,
  dbPath,
  ensureProject,
  isFirstRun,
  projectId,
  projectName,
  mergeProjectInternal,
  loadForceMinLayer,
  saveForceMinLayer,
  saveSessionCosts,
  loadSessionCosts,
  loadAllSessionCosts,
  type SessionCostSnapshot,
  getMeta,
  setMeta,
  getInstanceId,
  close,
} from "./db";
export { normalizeRemoteUrl, getGitRemote, clearGitRemoteCache } from "./git";
export {
  transform,
  setModelLimits,
  setMaxLayer0Tokens,
  computeLayer0Cap,
  setMaxContextTokens,
  computeContextCap,
  getMaxContextTokens,
  updateBustRate,
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
  toolStripAnnotation,
  onIdleResume,
  getLastTurnAt,
  consumeCameOutOfIdle,
  // Test-only — exposed at the barrel so host-package tests can simulate idle
  // gaps without sleeping. Not part of the public API.
  setLastTurnAtForTest,
  inspectSessionState,
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
export {
  shouldImport,
  importFromFile,
  exportToFile,
  exportLoreFile,
  importLoreFile,
  shouldImportLoreFile,
  loreFileExists,
  clearLoreFileCache,
  LORE_FILE,
} from "./agents-file";
export { workerSessionIDs, isWorkerSession } from "./worker";
export * as workerModel from "./worker-model";
export {
  ftsQuery,
  ftsQueryOr,
  ftsQueryRelaxed,
  EMPTY_QUERY,
  reciprocalRankFusion,
  expandQuery,
  extractTopTerms,
  exactTermMatchRank,
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
  renderMarkdown,
} from "./markdown";
