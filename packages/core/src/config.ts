import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LoreConfig = z.object({
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  /** Explicit worker model override. When set, all background workers (distillation,
   *  curation, query expansion) use this model instead of the session model or the
   *  auto-selected worker model. Bypasses dynamic worker model selection entirely. */
  workerModel: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  budget: z
    .object({
      distilled: z.number().min(0.05).max(0.5).default(0.25),
      raw: z.number().min(0.1).max(0.7).default(0.4),
      output: z.number().min(0.1).max(0.5).default(0.25),
      /** Max fraction of usable context reserved for LTM system-prompt injection. Default: 0.05 (5%). */
      ltm: z.number().min(0.02).max(0.3).default(0.05),
      /** Per-turn cache-read cost target in dollars. Controls when layer 0 (full
       *  passthrough) escalates to layer 1 (compressed). The cap is derived as:
       *  maxLayer0Tokens = max(target / model.cost.cache.read, 40K).
       *  Lower = cheaper but earlier compression. Default: 0.10. Set to 0 to
       *  disable cost-aware capping (use the model's full context). */
      targetCacheReadCostPerTurn: z.number().min(0).default(0.10),
      /** Direct override for the layer-0 token cap. When set, bypasses the
       *  cost-aware formula from targetCacheReadCostPerTurn. 0 = disabled
       *  (no cap, use full context). Default: undefined (use cost-aware auto). */
      maxLayer0Tokens: z.number().min(0).optional(),
      /** Target maximum cost (USD) for a single full cache bust (cold write of
       *  the entire context). Controls the total-context token cap at layer 1+:
       *  maxContextTokens = targetBustCost / cacheWriteCostPerToken.
       *  For opus-4-6 ($6.25/M write): $1.00 → 160K cap.
       *  For sonnet-4 ($3.75/M write): $1.00 → 267K (effectively uncapped at 200K).
       *  The cap is further adjusted dynamically per session based on observed
       *  bust rate (EMA) and break frequency. Default: 1.00. Set to 0 to disable. */
      targetBustCost: z.number().min(0).default(1.00),
      /** Direct override for the total-context token cap at layer 1+. When set,
       *  bypasses the cost-aware formula from targetBustCost. 0 = disabled.
       *  Default: undefined (use cost-aware auto). */
      maxContextTokens: z.number().min(0).optional(),
    })
    .default({ distilled: 0.25, raw: 0.4, output: 0.25, ltm: 0.05, targetCacheReadCostPerTurn: 0.10, targetBustCost: 1.00 }),
  /**
   * Cold-cache idle-resume handling.
   *
   * Anthropic's prompt cache evicts entries after ~5 min (default tier) /
   * ~1 hour (extended tier). When a session resumes after the eviction window,
   * Lore's byte-identity caches (distilled prefix, raw window pin, LTM block)
   * are providing no value because the underlying provider cache is already
   * cold. On detection, Lore refreshes those caches so the next turn can
   * produce a better-fitting window without paying a cache cost it would
   * otherwise be trying to preserve. Reasoning blocks are NOT touched —
   * Anthropic's April 23 postmortem identified dropping reasoning blocks as
   * the root cause of forgetfulness/repetition.
   *
   * `idleResumeMinutes` is the threshold in minutes. Default 5 — matches
   * Anthropic's default-tier prompt cache TTL. After 5 min of inactivity the
   * upstream cache is cold, so preserving byte-identity wastes cache-write cost
   * for no benefit. Refreshing the caches on resume produces a better-fitting
   * window at the same cold-write price. Users on Anthropic's extended-cache
   * tier (1 h TTL) should set this to 60 in `.lore.json`.
   * Set to 0 to disable the feature.
   */
  idleResumeMinutes: z.number().min(0).max(24 * 60).default(5),
  distillation: z
    .object({
      minMessages: z.number().min(3).default(5),
      /** Minimum total tokens for a segment to be worth distilling.
       *  Segments below this are deferred (normal mode) or absorbed without
       *  an LLM call (force/urgent mode). Default: 64. */
      minSegmentTokens: z.number().min(16).default(64),
      /** Maximum total tokens per distillation segment. Segments exceeding
       *  this are split at time-gap or token boundaries. Replaces the former
       *  message-count-based maxSegment. Default: 8192. */
      maxSegmentTokens: z.number().min(256).default(16384),
      metaThreshold: z.number().min(3).default(20),
      /** Max chars per tool output when rendering temporal messages for distillation input.
       *  Outputs longer than this are replaced with a compact annotation preserving line
       *  count, error signals, and file paths. Default: 2000 (matches upstream OpenCode's
       *  TOOL_OUTPUT_MAX_CHARS during compaction). Set to 0 to disable. */
      toolOutputMaxChars: z.number().min(0).default(2_000),
    })
    .default({
      minMessages: 5,
      minSegmentTokens: 64,
      maxSegmentTokens: 16384,
      metaThreshold: 20,
      toolOutputMaxChars: 2_000,
    }),
  knowledge: z
    .object({
      /** Set to false to disable long-term knowledge storage and system-prompt injection.
       *  Conversation recall (temporal search, distillation search) and context management
       *  (gradient transform, distillation) remain fully active. Disabling this turns off
       *  the curator, knowledge DB writes, AGENTS.md sync, and LTM injection into the
       *  system prompt. Default: true. */
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  curator: z
    .object({
      enabled: z.boolean().default(true),
      onIdle: z.boolean().default(true),
      afterTurns: z.number().min(1).default(3),
      /** Max knowledge entries per project before consolidation triggers. Default: 25. */
      maxEntries: z.number().min(10).default(25),
    })
    .default({ enabled: true, onIdle: true, afterTurns: 3, maxEntries: 25 }),
  pruning: z
    .object({
      /** Days to keep distilled temporal messages before pruning. Default: 120. */
      retention: z.number().min(1).default(120),
      /** Max total temporal_messages storage in MB before emergency pruning. Default: 1024 (1 GB). */
      maxStorage: z.number().min(50).default(1024),
    })
    .default({ retention: 120, maxStorage: 1024 }),
  search: z
    .object({
      /** BM25 column weights for knowledge FTS5 [title, content, category]. */
      ftsWeights: z
        .object({
          title: z.number().min(0).default(6.0),
          content: z.number().min(0).default(2.0),
          category: z.number().min(0).default(3.0),
        })
        .default({ title: 6.0, content: 2.0, category: 3.0 }),
      /** Max results per source in recall tool before fusion. Default: 10. */
      recallLimit: z.number().min(1).max(50).default(10),
      /** Enable LLM-based query expansion for the recall tool. Default: false.
       *  When enabled, the configured model generates 2–3 alternative query phrasings
       *  before search, improving recall for ambiguous queries. */
      queryExpansion: z.boolean().default(false),
      /** Vector embedding search.
       *  Supports multiple providers:
       *  - "local" (default): fastembed + ONNX Runtime, no API key needed.
       *    Uses bge-small-en-v1.5 (384 dims). Model downloaded on first use (~33MB),
       *    cached in ~/.cache/fastembed. ~150ms per query embed.
       *  - "voyage": Voyage AI (VOYAGE_API_KEY, voyage-code-3, 1024 dims)
       *  - "openai": OpenAI (OPENAI_API_KEY, text-embedding-3-small, 1536 dims)
       *  Set enabled: false to explicitly disable even with a provider available. */
      embeddings: z
        .object({
          /** Enable/disable vector embedding search. Default: true.
           *  Set to false to explicitly disable. */
          enabled: z.boolean().default(true),
          /** Embedding provider. Default: "local".
           *  - "local": fastembed + ONNX Runtime, no API key (default model: bge-small-en-v1.5, 384 dims)
           *  - "voyage": VOYAGE_API_KEY (default model: voyage-code-3, 1024 dims)
           *  - "openai": OPENAI_API_KEY (default model: text-embedding-3-small, 1536 dims) */
          provider: z.enum(["local", "voyage", "openai"]).default("local"),
          /** Model ID for the embedding provider. Default depends on provider. */
          model: z.string().default("BGESmallENV15"),
          /** Embedding dimensions. Default: 384 (local) / 1024 (voyage) / 1536 (openai). */
          dimensions: z.number().min(64).max(2048).default(384),
        })
        .default({
          enabled: true,
          provider: "local",
          model: "BGESmallENV15",
          dimensions: 384,
        }),
      /** Recall output formatting — controls how search results are presented to the agent. */
      recall: z
        .object({
          /** Total character budget for recall output. Controls how much context the
           *  recall results consume. ~2K tokens at 8000 chars. Default: 8000. */
          charBudget: z.number().min(2000).max(20000).default(8000),
          /** Minimum RRF score relative to top result. Results below
           *  topScore * relevanceFloor are dropped. Default: 0.15.
           *  Set to 0 to disable score-based cutoff. */
          relevanceFloor: z.number().min(0).max(1).default(0.15),
          /** Max results to show in recall output. Default: 15. */
          maxResults: z.number().min(3).max(30).default(15),
        })
        .default({ charBudget: 8000, relevanceFloor: 0.15, maxResults: 15 }),
    })
    .default({
      ftsWeights: { title: 6.0, content: 2.0, category: 3.0 },
      recallLimit: 10,
      queryExpansion: false,
      embeddings: { enabled: true, provider: "local" as const, model: "BGESmallENV15", dimensions: 384 },
      recall: { charBudget: 8000, relevanceFloor: 0.15, maxResults: 15 },
    }),
  cache: z
    .object({
      /** TTL for the conversation cache breakpoint.
       *  - "5m" — standard Anthropic ephemeral (5 min eviction, 1.25× write cost)
       *  - "1h" — extended 1-hour TTL (2× write cost, requires extended cache tier)
       *  - "auto" — auto-upgrade to 1h when frequent cold-cache turns are detected.
       *    Monitors rolling window of recent turns; upgrades when >40% are cold-cache,
       *    downgrades when <20%. Auto-syncs idleResumeMinutes to 60 when 1h is active.
       *  Default: "auto". */
      conversationTTL: z.enum(["5m", "1h", "auto"]).default("auto"),
      /** Speculative cache warming — sends max_tokens:0 keepalive requests to
       *  refresh the Anthropic prompt cache before it expires. Uses survival
       *  analysis on inter-turn gaps to predict whether the user will return. */
      warming: z
        .object({
          /** Enable cache warming. Default: true. */
          enabled: z.boolean().default(true),
          /** Override the survival probability threshold below which warming is
           *  skipped. Default: auto-derived from cache read/write cost ratio
           *  (~0.08 for 5m TTL, ~0.05 for 1h TTL). */
          minReturnProbability: z.number().min(0).max(1).optional(),
        })
        .default({ enabled: true }),
    })
    .default({
      conversationTTL: "auto",
      warming: { enabled: true },
    }),
  crossProject: z.boolean().default(false),
  agentsFile: z
    .object({
      /** Set to false to disable all AGENTS.md export/import behaviour. */
      enabled: z.boolean().default(true),
      /** Path to the agents file, relative to the project root. */
      path: z.string().default("AGENTS.md"),
    })
    .default({ enabled: true, path: "AGENTS.md" }),
});

export type LoreConfig = z.infer<typeof LoreConfig>;

let current: LoreConfig = LoreConfig.parse({});

export function config(): LoreConfig {
  return current;
}

export async function load(directory: string): Promise<LoreConfig> {
  const path = join(directory, ".lore.json");
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    current = LoreConfig.parse(raw);
    return current;
  }
  current = LoreConfig.parse({});
  return current;
}
