import type { createOpencodeClient } from "@opencode-ai/sdk";
import { config } from "./config";
import * as temporal from "./temporal";
import * as ltm from "./ltm";
import { CURATOR_SYSTEM, curatorUser } from "./prompt";

type Client = ReturnType<typeof createOpencodeClient>;

const workerSessions = new Map<string, string>();

async function ensureWorkerSession(
  client: Client,
  parentID: string,
): Promise<string> {
  const existing = workerSessions.get(parentID);
  if (existing) return existing;
  const session = await client.session.create({
    body: { parentID, title: "nuum curator" },
  });
  const id = session.data!.id;
  workerSessions.set(parentID, id);
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
      agent: "nuum-curator",
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
      ltm.create({
        projectPath: op.scope === "project" ? input.projectPath : undefined,
        category: op.category,
        title: op.title,
        content: op.content,
        session: input.sessionID,
        scope: op.scope,
        crossProject: op.crossProject,
      });
      created++;
    } else if (op.op === "update") {
      const entry = ltm.get(op.id);
      if (entry) {
        ltm.update(op.id, { content: op.content, confidence: op.confidence });
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
