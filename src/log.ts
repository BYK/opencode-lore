/**
 * Lightweight logger that suppresses informational messages by default.
 *
 * In TUI mode, all stderr output renders as red "error" text — confusing
 * for routine status messages like "incremental distillation" or "pruned
 * temporal messages". Only actual errors should be visible by default.
 *
 * Set LORE_DEBUG=1 to see informational messages (useful when debugging
 * the plugin itself).
 */

const isDebug = !!process.env.LORE_DEBUG;

/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args: unknown[]): void {
  if (isDebug) console.error("[lore]", ...args);
}

/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args: unknown[]): void {
  if (isDebug) console.error("[lore] WARN:", ...args);
}

/** Log an error. Always visible — these indicate real failures. */
export function error(...args: unknown[]): void {
  console.error("[lore]", ...args);
}
