/**
 * Upgrade Error Types
 *
 * Slim error hierarchy for the upgrade system. No Sentry SDK dependency,
 * no complex exit code mapping — just typed reasons for programmatic handling.
 */

export type UpgradeErrorReason =
  | "network_error"
  | "execution_failed"
  | "version_not_found"
  | "offline_cache_miss";

/**
 * Upgrade-related errors with typed reasons for programmatic handling.
 */
export class UpgradeError extends Error {
  readonly reason: UpgradeErrorReason;

  constructor(reason: UpgradeErrorReason, message?: string) {
    const defaultMessages: Record<UpgradeErrorReason, string> = {
      network_error: "Failed to fetch version information.",
      execution_failed: "Upgrade command failed.",
      version_not_found: "The specified version was not found.",
      offline_cache_miss:
        "Cannot upgrade offline — no pre-downloaded update is available.",
    };
    super(message ?? defaultMessages[reason]);
    this.name = "UpgradeError";
    this.reason = reason;
  }
}

/**
 * Convert an unknown value to a human-readable string.
 */
export function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
