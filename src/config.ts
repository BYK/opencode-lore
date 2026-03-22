import { z } from "zod";

export const LoreConfig = z.object({
  model: z
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
      /** Max fraction of usable context reserved for LTM system-prompt injection. Default: 0.10 (10%). */
      ltm: z.number().min(0.02).max(0.3).default(0.10),
    })
    .default({ distilled: 0.25, raw: 0.4, output: 0.25, ltm: 0.10 }),
  distillation: z
    .object({
      minMessages: z.number().min(3).default(8),
      maxSegment: z.number().min(5).default(50),
      metaThreshold: z.number().min(3).default(10),
    })
    .default({ minMessages: 8, maxSegment: 50, metaThreshold: 10 }),
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
      afterTurns: z.number().min(1).default(10),
      /** Max knowledge entries per project before consolidation triggers. Default: 25. */
      maxEntries: z.number().min(10).default(25),
    })
    .default({ enabled: true, onIdle: true, afterTurns: 10, maxEntries: 25 }),
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
      /** Vector embedding search via Voyage AI. Requires VOYAGE_API_KEY env var. */
      embeddings: z
        .object({
          /** Enable vector embedding search. Requires VOYAGE_API_KEY env var. Default: false. */
          enabled: z.boolean().default(false),
          /** Voyage AI model ID. Default: voyage-code-3. */
          model: z.string().default("voyage-code-3"),
          /** Embedding dimensions. Default: 1024. */
          dimensions: z.number().min(256).max(2048).default(1024),
        })
        .default({
          enabled: false,
          model: "voyage-code-3",
          dimensions: 1024,
        }),
    })
    .default({
      ftsWeights: { title: 6.0, content: 2.0, category: 3.0 },
      recallLimit: 10,
      queryExpansion: false,
      embeddings: { enabled: false, model: "voyage-code-3", dimensions: 1024 },
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
  const file = Bun.file(`${directory}/.lore.json`);
  if (await file.exists()) {
    const raw = await file.json();
    current = LoreConfig.parse(raw);
    return current;
  }
  current = LoreConfig.parse({});
  return current;
}
