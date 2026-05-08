/**
 * Lightweight logger that suppresses informational messages by default.
 *
 * In TUI mode, all stderr output renders as red "error" text — confusing
 * for routine status messages like "incremental distillation" or "pruned
 * temporal messages". Only actual errors should be visible by default.
 *
 * Set LORE_DEBUG=1 to see informational messages (useful when debugging
 * the plugin itself).
 *
 * ## Sink registration
 *
 * An optional {@link LogSink} can be registered via {@link registerSink}.
 * When registered, every log call (regardless of `isDebug`) also forwards
 * to the sink. This is used by the gateway to bridge logs → Sentry without
 * adding a Sentry dependency to `@loreai/core`.
 */

// ---------------------------------------------------------------------------
// Sink — optional external log consumer (e.g. Sentry)
// ---------------------------------------------------------------------------

/** External log consumer registered by the host (e.g. gateway → Sentry). */
export interface LogSink {
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
  captureException(err: unknown): void;
}

let sink: LogSink | null = null;

/** Register an external log sink. Only one sink is supported at a time. */
export function registerSink(s: LogSink): void {
  sink = s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isDebug = !!process.env.LORE_DEBUG;

/** Format variadic args into a single string for the sink. */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : String(a)))
    .join(" ");
}

/** Extract the first Error instance from the args list, if any. */
function findError(args: unknown[]): Error | undefined {
  for (const a of args) {
    if (a instanceof Error) return a;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args: unknown[]): void {
  if (isDebug) console.error("[lore]", ...args);
  sink?.info(formatArgs(args));
}

/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args: unknown[]): void {
  if (isDebug) console.error("[lore] WARN:", ...args);
  sink?.warn(formatArgs(args));
}

/** Log an error. Always visible — these indicate real failures. */
export function error(...args: unknown[]): void {
  console.error("[lore]", ...args);
  sink?.error(formatArgs(args));

  const err = findError(args);
  if (err) sink?.captureException(err);
}
