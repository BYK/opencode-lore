/**
 * Shared types for the Lore eval suite.
 *
 * All scenarios, the harness, judge, baselines, and the CLI entry point
 * import from this file so there is a single source of truth.
 */

// ---------------------------------------------------------------------------
// Dimensions & Scenarios
// ---------------------------------------------------------------------------

export type Dimension =
  | "context"
  | "recall"
  | "preferences"
  | "cross-project"
  | "cost";

export const ALL_DIMENSIONS: Dimension[] = [
  "context",
  "recall",
  "preferences",
  "cross-project",
  "cost",
];

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export type BaselineMode =
  | "lore"
  | "lore-context-only"
  | "lore-memory-only"
  | "tail-window"
  | "compaction"
  | "raw"
  | "auto-mem0";

export const ALL_BASELINES: BaselineMode[] = [
  "lore",
  "lore-context-only",
  "lore-memory-only",
  "tail-window",
  "compaction",
  "raw",
  "auto-mem0",
];

// ---------------------------------------------------------------------------
// Conversation transcripts
// ---------------------------------------------------------------------------

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface ConversationTurn {
  role: "user" | "assistant";
  content: ContentPart[];
  /** Pre-computed token estimate for this turn. */
  tokens?: number;
  /** Unix ms timestamp for temporal realism. */
  timestamp?: number;
}

export interface SessionTranscript {
  id: string;
  label: string;
  projectPath: string;
  turns: ConversationTurn[];
  metadata: {
    totalTokens: number;
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Planted facts & questions
// ---------------------------------------------------------------------------

export interface PlantedFact {
  turnIndex: number;
  cumulativeTokens: number;
  fact: string;
  questionDifficulty: "easy" | "medium" | "hard";
  category: string;
}

export interface ScoringCriterion {
  name: string;
  description: string;
  scale: {
    1: string;
    3: string;
    5: string;
  };
}

export interface ScoringRubric {
  criteria: ScoringCriterion[];
  weights: Record<string, number>;
}

export interface EvalQuestion {
  id: string;
  dimension: Dimension;
  scenario: string;
  sessionRef: string;
  question: string;
  referenceAnswer: string;
  rubric: ScoringRubric;
  metadata: {
    turnIndex?: number;
    cumulativeTokens?: number;
    difficulty: "easy" | "medium" | "hard";
    tags: string[];
  };
}

// ---------------------------------------------------------------------------
// Eval results
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
}

export interface JudgeResult {
  scores: Record<string, number>;
  compositeScore: number;
  reasoning: string;
  tokensUsed: number;
}

export interface EvalResult {
  timestamp: string;
  dimension: Dimension;
  scenario: string;
  questionId: string;
  mode: BaselineMode;
  question: string;
  referenceAnswer: string;
  hypothesis: string;
  scores: Record<string, number>;
  compositeScore: number;
  judgeReasoning: string;
  tokens: TokenUsage;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cost-specific metrics
// ---------------------------------------------------------------------------

export interface CostMetrics {
  totalCostWithLore: number;
  totalCostBaseline: number;
  loreOverheadPct: number;
  savingsPct: number;
  breakdown: {
    conversation: number;
    distillation: number;
    curation: number;
    recall: number;
    warmup: number;
  };
  counterfactual: {
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    cacheHitRate: number;
    batchSavings: number;
  };
}

// ---------------------------------------------------------------------------
// Replay results
// ---------------------------------------------------------------------------

export interface ReplayResult {
  sessionID: string;
  turnsReplayed: number;
  totalTokens: number;
  /** Gateway-reported layer at end of session. */
  finalLayer?: number;
  /** Per-turn token snapshots for cost analysis. */
  turnSnapshots: TurnSnapshot[];
}

export interface TurnSnapshot {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  layer?: number;
}

// ---------------------------------------------------------------------------
// Eval config
// ---------------------------------------------------------------------------

export type EvalMode = "fixture" | "live";

export interface EvalConfig {
  mode: EvalMode;
  gateway?: { host: string; port: number };
  model: string;
  judgeModel: string;
  concurrency: number;
  outputPath: string;
  dimensions: Dimension[];
  baselines: BaselineMode[];
  /** Directory to write session recordings (first run). */
  recordDir?: string;
  /** Directory to read session recordings (subsequent runs). */
  replayDir?: string;
  /** Filter to specific scenario IDs. */
  scenarios?: string[];
}

// ---------------------------------------------------------------------------
// Scenario interface
// ---------------------------------------------------------------------------

/**
 * Every scenario module exports an array of `ScenarioDefinition`.
 * The harness iterates over them, replays sessions, asks questions,
 * and scores results.
 */
export interface ScenarioDefinition {
  id: string;
  name: string;
  dimension: Dimension;
  /** Which baselines are applicable to this scenario. */
  applicableBaselines: BaselineMode[];
  /** Session transcripts to replay before asking questions. */
  sessions: SessionTranscript[];
  /** Questions to ask after replaying all sessions. */
  questions: EvalQuestion[];
  /**
   * Optional setup hook (e.g., seeding knowledge entries for cross-project).
   * Receives the gateway base URL and returns a cleanup function.
   */
  setup?: (gatewayUrl: string) => Promise<() => Promise<void>>;
}
