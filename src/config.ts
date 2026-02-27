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
    .default({}),
  distillation: z
    .object({
      minMessages: z.number().min(3).default(8),
      maxSegment: z.number().min(5).default(50),
      metaThreshold: z.number().min(3).default(10),
    })
    .default({}),
  curator: z
    .object({
      enabled: z.boolean().default(true),
      onIdle: z.boolean().default(true),
      afterTurns: z.number().min(1).default(10),
      /** Max knowledge entries per project before consolidation triggers. Default: 25. */
      maxEntries: z.number().min(10).default(25),
    })
    .default({}),
  pruning: z
    .object({
      /** Days to keep distilled temporal messages before pruning. Default: 120. */
      retention: z.number().min(1).default(120),
      /** Max total temporal_messages storage in MB before emergency pruning. Default: 1024 (1 GB). */
      maxStorage: z.number().min(50).default(1024),
    })
    .default({}),
  crossProject: z.boolean().default(true),
  agentsFile: z
    .object({
      /** Set to false to disable all AGENTS.md export/import behaviour. */
      enabled: z.boolean().default(true),
      /** Path to the agents file, relative to the project root. */
      path: z.string().default("AGENTS.md"),
    })
    .default({}),
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
