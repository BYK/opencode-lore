import type { createOpencodeClient } from "@opencode-ai/sdk";
import { config } from "./config";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import { CURATOR_SYSTEM, curatorUser, CONSOLIDATION_SYSTEM, consolidationUser } from "./prompt";
import { workerSessionIDs } from "./distillation";

/**
 * Maximum length (chars) for a single knowledge entry's content.
 * ~400 tokens at chars/3. Entries exceeding this are truncated with a notice.
 * The curator prompt also instructs the model to stay within this limit,
 * so truncation is a last-resort safety net.
 */
const MAX_ENTRY_CONTENT_LENGTH = 1200;

type Client = ReturnType<typeof createOpencodeClient>;

const workerSessions = new Map<string, string>();

async function ensureWorkerSession(
  client: Client,
  parentID: string,
): Promise<string> {
  const existing = workerSessions.get(parentID);
  if (existing) return existing;
  const session = await client.session.create({
    body: { parentID, title: "lore curator" },
  });
  const id = session.data!.id;
  workerSessions.set(parentID, id);
  workerSessionIDs.add(id);
  return id;
}

type CuratorOp =
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

function parseOps(text: string): CuratorOp[] {
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

// Track which messages we've already curated
let lastCuratedAt = 0;

export async function run(input: {
  client: Client;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<{ created: number; updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { created: 0, updated: 0, deleted: 0 };

  // Get recent messages since last curation
  const all = temporal.bySession(input.projectPath, input.sessionID);
  const recent = all.filter((m) => m.created_at > lastCuratedAt);
  if (recent.length < 3) return { created: 0, updated: 0, deleted: 0 };

  const text = recent.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  const existing = ltm.forProject(input.projectPath, cfg.crossProject);
  const existingForPrompt = existing.map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
  }));

  const userContent = curatorUser({
    messages: text,
    existing: existingForPrompt,
  });
  const workerID = await ensureWorkerSession(input.client, input.sessionID);
  const model = input.model ?? cfg.model;
  const parts = [
    { type: "text" as const, text: `${CURATOR_SYSTEM}\n\n${userContent}` },
  ];

  await input.client.session.prompt({
    path: { id: workerID },
    body: {
      parts,
      agent: "lore-curator",
      ...(model ? { model } : {}),
    },
  });

  const msgs = await input.client.session.messages({
    path: { id: workerID },
    query: { limit: 2 },
  });
  const last = msgs.data?.at(-1);
  if (!last || last.info.role !== "assistant")
    return { created: 0, updated: 0, deleted: 0 };

  const responsePart = last.parts.find((p) => p.type === "text");
  if (!responsePart || responsePart.type !== "text")
    return { created: 0, updated: 0, deleted: 0 };

  const ops = parseOps(responsePart.text);
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const op of ops) {
    if (op.op === "create") {
      // Truncate oversized content — the model should stay within the prompt's
      // 500-word limit, but enforce it here as a hard safety net.
      const content =
        op.content.length > MAX_ENTRY_CONTENT_LENGTH
          ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
            " [truncated — entry too long]"
          : op.content;
      ltm.create({
        projectPath: op.scope === "project" ? input.projectPath : undefined,
        category: op.category,
        title: op.title,
        content,
        session: input.sessionID,
        scope: op.scope,
        crossProject: op.crossProject ?? true,
      });
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

  lastCuratedAt = Date.now();
  return { created, updated, deleted };
}

export function resetCurationTracker() {
  lastCuratedAt = 0;
}

/**
 * Consolidation pass: reviews ALL project entries and merges/trims/deletes
 * to reduce entry count to cfg.curator.maxEntries. Only runs when the current
 * entry count exceeds the target. Uses the same worker session as curation.
 *
 * Only "update" and "delete" ops are applied — consolidation never creates entries.
 */
export async function consolidate(input: {
  client: Client;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<{ updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { updated: 0, deleted: 0 };

  const entries = ltm.forProject(input.projectPath, cfg.crossProject);
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
  const workerID = await ensureWorkerSession(input.client, input.sessionID);
  const model = input.model ?? cfg.model;
  const parts = [
    { type: "text" as const, text: `${CONSOLIDATION_SYSTEM}\n\n${userContent}` },
  ];

  await input.client.session.prompt({
    path: { id: workerID },
    body: {
      parts,
      agent: "lore-curator",
      ...(model ? { model } : {}),
    },
  });

  const msgs = await input.client.session.messages({
    path: { id: workerID },
    query: { limit: 2 },
  });
  const last = msgs.data?.at(-1);
  if (!last || last.info.role !== "assistant") return { updated: 0, deleted: 0 };

  const responsePart = last.parts.find((p) => p.type === "text");
  if (!responsePart || responsePart.type !== "text") return { updated: 0, deleted: 0 };

  const ops = parseOps(responsePart.text);
  let updated = 0;
  let deleted = 0;

  for (const op of ops) {
    // Consolidation only applies update and delete — never create.
    if (op.op === "update") {
      const entry = ltm.get(op.id);
      if (entry) {
        const content =
          op.content !== undefined && op.content.length > MAX_ENTRY_CONTENT_LENGTH
            ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
              " [truncated — entry too long]"
            : op.content;
        ltm.update(op.id, { content, confidence: op.confidence });
        updated++;
      }
    } else if (op.op === "delete") {
      const entry = ltm.get(op.id);
      if (entry) {
        ltm.remove(op.id);
        deleted++;
      }
    }
    // "create" ops are silently ignored — consolidation must not add entries.
  }

  return { updated, deleted };
}
