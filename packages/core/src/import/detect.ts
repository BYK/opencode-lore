/**
 * Detection orchestrator — scans all registered providers for conversation
 * history matching a given project path.
 */
import type { DetectionResult } from "./types";
import { getProviders } from "./providers";

/**
 * Scan all registered providers for conversation history matching the
 * given project path.
 *
 * @returns Results from all providers that found data, sorted by
 *          total messages descending (richest source first).
 */
export function detectAll(projectPath: string): DetectionResult[] {
  const results: DetectionResult[] = [];

  for (const provider of getProviders()) {
    try {
      const sessions = provider.detect(projectPath);
      if (sessions.length > 0) {
        results.push({
          agentName: provider.name,
          agentDisplayName: provider.displayName,
          sessions,
          totalTokens: sessions.reduce((s, sess) => s + sess.estimatedTokens, 0),
          totalMessages: sessions.reduce((s, sess) => s + sess.messageCount, 0),
        });
      }
    } catch (err) {
      // Provider failed (e.g. corrupt DB, missing directory) — skip silently.
      // Avoid log.warn to not alarm users about agents they don't use.
    }
  }

  return results.sort((a, b) => b.totalMessages - a.totalMessages);
}
