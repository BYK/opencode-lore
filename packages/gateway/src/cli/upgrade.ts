/**
 * `lore upgrade [version]` — self-update command.
 *
 * Stub — full implementation in Step 8.
 */
import { VERSION } from "./version";

export async function commandUpgrade(args: string[]): Promise<void> {
  const target = args[0] ?? "latest";
  console.error(`[lore] Current version: ${VERSION}`);
  console.error(`[lore] Upgrade to "${target}" is not yet implemented.`);
  console.error("[lore] For now, update via: npm update -g @loreai/gateway");
  process.exit(1);
}
