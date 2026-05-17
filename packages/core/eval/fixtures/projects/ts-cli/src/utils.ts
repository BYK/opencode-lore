import { mkdirSync, existsSync } from "node:fs";

export async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
