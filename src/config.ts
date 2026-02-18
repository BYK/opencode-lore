import { z } from "zod";

export const NuumConfig = z.object({
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
    })
    .default({}),
  crossProject: z.boolean().default(true),
});

export type NuumConfig = z.infer<typeof NuumConfig>;

let current: NuumConfig = NuumConfig.parse({});

export function config(): NuumConfig {
  return current;
}

export async function load(directory: string): Promise<NuumConfig> {
  const paths = [`${directory}/.opencode/nuum.json`, `${directory}/nuum.json`];
  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const raw = await file.json();
      current = NuumConfig.parse(raw);
      return current;
    }
  }
  current = NuumConfig.parse({});
  return current;
}
