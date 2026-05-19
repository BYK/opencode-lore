/**
 * Knowledge extraction from imported conversations.
 *
 * Takes conversation chunks and feeds them to the curator LLM to extract
 * knowledge entries directly, without going through the temporal → distill
 * pipeline. This is cheaper and faster than full-pipeline import.
 */
import * as ltm from "../ltm";
import { parseOps, applyOps } from "../curator";
import { CURATOR_SYSTEM, curatorUser } from "../prompt";
import type { LLMClient } from "../types";
import type { ConversationChunk } from "./types";

/**
 * System prompt for import extraction.
 * Extends the standard curator prompt with guidance for historical conversations.
 */
const IMPORT_CURATOR_SYSTEM = `${CURATOR_SYSTEM}

ADDITIONAL CONTEXT: You are extracting knowledge from HISTORICAL conversations with a different AI coding agent. Focus on durable insights that are still relevant:
- Architecture decisions, design patterns, and project conventions
- Gotchas, non-obvious bugs, and their fixes
- Developer preferences and workflow patterns
- Key technical choices and their rationale

Ignore:
- References to the other agent's specific capabilities or limitations
- Task-specific state that is no longer current (e.g. "currently debugging X")
- Debugging steps for issues that were already resolved
- Transient conversation artifacts (greetings, acknowledgments, status updates)`;

export type ExtractionProgress = {
  /** Current chunk being processed (1-based) */
  current: number;
  /** Total chunks to process */
  total: number;
  /** Knowledge entries created so far */
  created: number;
  /** Knowledge entries updated (dedup hit) so far */
  updated: number;
};

export type ExtractionResult = {
  /** Total knowledge entries created */
  created: number;
  /** Total entries that hit dedup (updated existing) */
  updated: number;
  /** Total entries deleted */
  deleted: number;
  /** Chunks processed successfully */
  chunksProcessed: number;
  /** Chunks that failed (LLM error) */
  chunksFailed: number;
};

/**
 * Extract knowledge entries from conversation chunks via the curator LLM.
 *
 * Processes chunks sequentially (not parallel) to avoid rate limits
 * and to let later chunks see entries created by earlier chunks
 * (better dedup via the existing entries list in the prompt).
 */
export async function extractKnowledge(input: {
  llm: LLMClient;
  projectPath: string;
  chunks: ConversationChunk[];
  sessionID?: string;
  model?: { providerID: string; modelID: string };
  onProgress?: (progress: ExtractionProgress) => void;
}): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    chunksProcessed: 0,
    chunksFailed: 0,
  };

  // Sort chunks chronologically so knowledge builds up naturally
  const sorted = [...input.chunks].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i];

    // Get existing entries (refreshed each iteration for dedup)
    const existing = ltm.forProject(input.projectPath, false);
    const existingForPrompt = existing.map((e) => ({
      id: e.id,
      category: e.category,
      title: e.title,
      content: e.content,
    }));

    const userContent = curatorUser({
      messages: chunk.text,
      existing: existingForPrompt,
    });

    try {
      const response = await input.llm.prompt(
        IMPORT_CURATOR_SYSTEM,
        userContent,
        {
          model: input.model,
          workerID: "lore-import",
          thinking: false,
          maxTokens: 4096,
          sessionID: input.sessionID,
          temperature: 0,
        },
      );

      if (response) {
        const ops = parseOps(response);
        const applied = applyOps(ops, {
          projectPath: input.projectPath,
          sessionID: input.sessionID,
        });
        result.created += applied.created;
        result.updated += applied.updated;
        result.deleted += applied.deleted;
      }

      result.chunksProcessed++;
    } catch {
      result.chunksFailed++;
    }

    input.onProgress?.({
      current: i + 1,
      total: sorted.length,
      created: result.created,
      updated: result.updated,
    });
  }

  return result;
}
