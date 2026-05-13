import { config } from "./config";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import * as log from "./log";
import { CURATOR_SYSTEM, curatorUser, CONSOLIDATION_SYSTEM, consolidationUser } from "./prompt";
import { detectAndFormat } from "./instruction-detect";
import type { LLMClient } from "./types";

/**
 * Maximum length (chars) for a single knowledge entry's content.
 * ~400 tokens at chars/3. Entries exceeding this are truncated with a notice.
 * The curator prompt also instructs the model to stay within this limit,
 * so truncation is a last-resort safety net.
 */
export const MAX_ENTRY_CONTENT_LENGTH = 1200;

export type CuratorOp =
  | {
      op: "create";
      category: string;
      title: string;
      content: string;
      scope: "project" | "global";
      crossProject?: boolean;
    }
  | { op: "update"; id: string; content?: string; confidence?: number }
  | { op: "delete"; id: string; reason: string };

/**
 * Parse the LLM's JSON response into typed curator ops.
 * Handles markdown fences and filters invalid entries.
 */
export function parseOps(text: string): CuratorOp[] {
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (op: unknown) =>
        typeof op === "object" &&
        op !== null &&
        "op" in op &&
        typeof (op as Record<string, unknown>).op === "string",
    ) as CuratorOp[];
  } catch {
    return [];
  }
}

/**
 * Apply a list of curator ops (create/update/delete) to the knowledge DB.
 * Shared by both the live curator and the conversation import system.
 *
 * @returns Counts of applied operations.
 */
export function applyOps(
  ops: CuratorOp[],
  input: {
    projectPath?: string;
    sessionID?: string;
    /** If true, skip "create" ops (used by consolidation). */
    skipCreate?: boolean;
  },
): { created: number; updated: number; deleted: number } {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const idsToSync: string[] = [];

  for (const op of ops) {
    if (op.op === "create") {
      if (input.skipCreate) continue;
      const content =
        op.content.length > MAX_ENTRY_CONTENT_LENGTH
          ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
            " [truncated — entry too long]"
          : op.content;
      const id = ltm.create({
        projectPath: op.scope === "project" ? input.projectPath : undefined,
        category: op.category,
        title: op.title,
        content,
        session: input.sessionID,
        scope: op.scope,
        crossProject: op.crossProject ?? true,
      });
      idsToSync.push(id);
      created++;
    } else if (op.op === "update") {
      const entry = ltm.get(op.id);
      if (entry) {
        const content =
          op.content !== undefined && op.content.length > MAX_ENTRY_CONTENT_LENGTH
            ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
              " [truncated — entry too long]"
            : op.content;
        ltm.update(op.id, { content, confidence: op.confidence });
        if (op.content !== undefined) idsToSync.push(op.id);
        updated++;
      }
    } else if (op.op === "delete") {
      const entry = ltm.get(op.id);
      if (entry) {
        ltm.remove(op.id);
        deleted++;
      }
    }
  }

  // Sync cross-references for created/updated entries
  for (const id of idsToSync) {
    ltm.syncRefs(id);
  }

  return { created, updated, deleted };
}

// Track which messages we've already curated — per session to prevent
// cross-session leaking (curation on session A advancing the timestamp
// past session B's messages, causing B's curation to find < 3 recent).
const lastCuratedAt = new Map<string, number>();

export async function run(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<{ created: number; updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { created: 0, updated: 0, deleted: 0 };

  // Get recent messages since last curation
  const all = temporal.bySession(input.projectPath, input.sessionID);
  const sessionCuratedAt = lastCuratedAt.get(input.sessionID) ?? 0;
  const recent = all.filter((m) => m.created_at > sessionCuratedAt);
  if (recent.length < 3) return { created: 0, updated: 0, deleted: 0 };

  const text = recent.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  const existing = ltm.forProject(input.projectPath, false);
  const existingForPrompt = existing.map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
  }));

  const baseUserContent = curatorUser({
    messages: text,
    existing: existingForPrompt,
  });

  // Detect repeated instructions across prior sessions and append as
  // additional context for the curator. This is async (may embed candidates)
  // but fast — typically <250ms for 5 candidates with local embeddings.
  let crossSessionContext = "";
  try {
    crossSessionContext = await detectAndFormat({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
    });
  } catch (err) {
    log.warn("instruction-detect failed (non-fatal):", err);
  }

  const userContent = baseUserContent + crossSessionContext;
  const model = input.model ?? cfg.model;
  const responseText = await input.llm.prompt(
    CURATOR_SYSTEM,
    userContent,
    { model, workerID: "lore-curator", thinking: false, sessionID: input.sessionID, maxTokens: 2048 },
  );
  if (!responseText) return { created: 0, updated: 0, deleted: 0 };

  const ops = parseOps(responseText);
  const result = applyOps(ops, {
    projectPath: input.projectPath,
    sessionID: input.sessionID,
  });

  // Post-curation dedup sweep: if the curator created new entries, check for
  // and auto-merge any semantic duplicates it introduced. Uses embedding-based
  // similarity when available, falls back to word-overlap.
  if (result.created > 0) {
    try {
      const dupes = await ltm.deduplicate(input.projectPath, { dryRun: false });
      if (dupes.totalRemoved > 0) {
        log.info(`post-curation dedup: merged ${dupes.totalRemoved} duplicate entries`);
        result.deleted += dupes.totalRemoved;
      }
    } catch (err) {
      log.warn("post-curation dedup failed (non-fatal):", err);
    }
  }

  lastCuratedAt.set(input.sessionID, Date.now());
  return result;
}

export function resetCurationTracker(sessionID?: string) {
  if (sessionID) {
    lastCuratedAt.delete(sessionID);
  } else {
    lastCuratedAt.clear();
  }
}

/**
 * Consolidation pass: reviews ALL project entries and merges/trims/deletes
 * to reduce entry count to cfg.curator.maxEntries. Only runs when the current
 * entry count exceeds the target. Uses the same worker session as curation.
 *
 * Only "update" and "delete" ops are applied — consolidation never creates entries.
 */
export async function consolidate(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<{ updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { updated: 0, deleted: 0 };

  const entries = ltm.forProject(input.projectPath, false);
  if (entries.length <= cfg.curator.maxEntries) return { updated: 0, deleted: 0 };

  const entriesForPrompt = entries.map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
  }));

  const userContent = consolidationUser({
    entries: entriesForPrompt,
    targetMax: cfg.curator.maxEntries,
  });
  const model = input.model ?? cfg.model;
  const responseText = await input.llm.prompt(
    CONSOLIDATION_SYSTEM,
    userContent,
    { model, workerID: "lore-curator", thinking: false, sessionID: input.sessionID, maxTokens: 4096 },
  );
  if (!responseText) return { updated: 0, deleted: 0 };

  const ops = parseOps(responseText);
  const result = applyOps(ops, {
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    skipCreate: true, // Consolidation must not add entries.
  });

  return { updated: result.updated, deleted: result.deleted };
}
