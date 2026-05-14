/**
 * Shared data-directory path resolution with one-time migration from the
 * legacy `opencode-lore` directory name to `lore`.
 *
 * Both `db.ts` and `log.ts` need the data directory path.  This module
 * provides a single source of truth so the path logic is not duplicated.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OLD_DIR_NAME = "opencode-lore";
const NEW_DIR_NAME = "lore";

let migrationAttempted = false;

/**
 * Compute the XDG-compliant base directory for lore data.
 * Respects `$XDG_DATA_HOME`, defaults to `~/.local/share`.
 */
function baseDir(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/**
 * Attempt a one-time migration of the legacy data directory.
 *
 * - Old exists, new does not → atomic `renameSync` (same filesystem).
 * - Both exist → keep new (user already migrated or has fresh data).
 * - Neither exists → no-op; callers create the dir via `mkdirSync`.
 *
 * Runs at most once per process.  Errors are swallowed — migration
 * failure is not fatal because callers create the directory anyway.
 */
function migrateDataDir(): void {
  if (migrationAttempted) return;
  migrationAttempted = true;

  // Tests use LORE_DB_PATH pointed at a temp dir; never touch the real
  // data directory.
  if (process.env.NODE_ENV === "test") return;

  const base = baseDir();
  const oldDir = join(base, OLD_DIR_NAME);
  const newDir = join(base, NEW_DIR_NAME);

  try {
    if (existsSync(oldDir) && !existsSync(newDir)) {
      renameSync(oldDir, newDir);
      // Can't use the lore logger here (circular dep), so use stderr.
      console.error(`[lore] migrated data directory: ${oldDir} → ${newDir}`);
    }
  } catch {
    // Permission error, cross-device rename, concurrent process already
    // renamed it, etc.  Not fatal — dataDir() returns the new path and
    // callers create the directory if it doesn't exist yet.
  }
}

/**
 * Return the resolved data directory path (`~/.local/share/lore` by
 * default), running the legacy-directory migration on the first call.
 *
 * **Callers are responsible for creating the directory** — this function
 * does not call `mkdirSync`.
 */
export function dataDir(): string {
  migrateDataDir();
  return join(baseDir(), NEW_DIR_NAME);
}

/** @internal Visible for testing only — resets the one-shot guard. */
export function _resetMigrationFlag(): void {
  migrationAttempted = false;
}
