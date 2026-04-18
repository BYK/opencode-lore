/**
 * Worker session tracking and the LLMClient contract.
 *
 * All lore background tasks (distillation, curation, query expansion) use
 * the LLMClient interface for single-turn LLM calls. The actual prompting
 * is implemented by the host adapter (OpenCode, Pi, etc.).
 *
 * This module owns the shared workerSessionIDs set — used by host adapters
 * to skip storing/distilling worker session messages.
 */
import type { LLMClient } from "./types";

// Re-export for convenience
export type { LLMClient } from "./types";

// ---------------------------------------------------------------------------
// Shared worker session tracking
// ---------------------------------------------------------------------------

/** Set of ALL worker session IDs across distillation, curator, and query expansion.
 *  Used by shouldSkip() in host adapters to avoid storing/distilling worker messages. */
export const workerSessionIDs = new Set<string>();

export function isWorkerSession(sessionID: string): boolean {
  return workerSessionIDs.has(sessionID);
}
