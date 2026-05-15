/**
 * hosted.ts — Hosted/remote mode flag for @loreai/core.
 *
 * When the gateway runs remotely (different machine/container from the
 * developer's workspace), filesystem operations that use client-controlled
 * paths are unsafe:
 *
 *  - `git remote -v` subprocess with attacker-controlled cwd
 *  - `.lore.json` config read from attacker-controlled path
 *  - `.lore.md` / AGENTS.md read/write at attacker-controlled path
 *  - `lat.md/` recursive directory scan at attacker-controlled path
 *  - `fs.watch()` on attacker-controlled paths
 *
 * Setting hosted mode causes all these operations to become safe no-ops.
 * The gateway sets this flag during startup when `LORE_HOSTED_MODE=1`.
 *
 * This is a process-wide flag — once set, it cannot be unset (the only
 * consumer is the gateway process, and hosted mode is a startup decision).
 */

let _hostedMode = false;

/**
 * Enable hosted mode. Once enabled, cannot be disabled.
 * All filesystem operations using client-controlled paths become no-ops.
 */
export function enableHostedMode(): void {
  _hostedMode = true;
}

/**
 * Returns true if hosted mode is active — filesystem operations using
 * client-controlled paths should be skipped.
 */
export function isHostedMode(): boolean {
  return _hostedMode;
}

/**
 * Reset hosted mode flag. **Test-only** — production code should never
 * call this. Exported so tests can toggle hosted mode without process
 * restarts.
 */
export function _resetHostedModeForTest(): void {
  _hostedMode = false;
}
