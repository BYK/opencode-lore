import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ProjectConfig {
  name: string;
  version: string;
}

const CONFIG_FILE = "project.json";

export function loadConfig(dir: string): ProjectConfig | null {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeConfig(dir: string, config: ProjectConfig): void {
  const path = join(dir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(config, null, 2));
}
