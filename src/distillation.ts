import type { createOpencodeClient } from "@opencode-ai/sdk";
import { db, ensureProject } from "./db";
import { config } from "./config";
import * as temporal from "./temporal";
import {
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
} from "./prompt";
import { needsUrgentDistillation } from "./gradient";

type Client = ReturnType<typeof createOpencodeClient>;
type TemporalMessage = temporal.TemporalMessage;

// Worker sessions keyed by parent session ID — hidden children, one per source session
const workerSessions = new Map<string, string>();

async function ensureWorkerSession(
  client: Client,
  parentID: string,
): Promise<string> {
  const existing = workerSessions.get(parentID);
  if (existing) return existing;
  const session = await client.session.create({
    body: { parentID, title: "nuum distillation" },
  });
  const id = session.data!.id;
  workerSessions.set(parentID, id);
  return id;
}

// Segment detection: group related messages together
function detectSegments(
  messages: TemporalMessage[],
  maxSegment: number,
): TemporalMessage[][] {
  if (messages.length <= maxSegment) return [messages];
  const segments: TemporalMessage[][] = [];
  let current: TemporalMessage[] = [];

  for (const msg of messages) {
    current.push(msg);
    // Split on segment size limit
    if (current.length >= maxSegment) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    // Merge small trailing segment with previous if too small
    if (current.length < 3 && segments.length > 0) {
      segments[segments.length - 1].push(...current);
    } else {
      segments.push(current);
    }
  }
  return segments;
}

function messagesToText(messages: TemporalMessage[]): string {
  return messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
}

type DistillationResult = {
  narrative: string;
  facts: string[];
};

function parseDistillationResult(text: string): DistillationResult | null {
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.narrative !== "string" || !Array.isArray(parsed.facts))
      return null;
    return {
      narrative: parsed.narrative,
      facts: parsed.facts.filter((f: unknown) => typeof f === "string"),
    };
  } catch {
    return null;
  }
}

// Get the most recent narrative for context
function latestNarrative(
  projectPath: string,
  sessionID: string,
): string | undefined {
  const pid = ensureProject(projectPath);
  const row = db()
    .query(
      "SELECT narrative FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(pid, sessionID) as { narrative: string } | null;
  return row?.narrative;
}

export type Distillation = {
  id: string;
  project_id: string;
  session_id: string;
  narrative: string;
  facts: string[];
  source_ids: string[];
  generation: number;
  token_count: number;
  created_at: number;
};

function storeDistillation(input: {
  projectPath: string;
  sessionID: string;
  narrative: string;
  facts: string[];
  sourceIDs: string[];
  generation: number;
}): string {
  const pid = ensureProject(input.projectPath);
  const id = crypto.randomUUID();
  const factsJson = JSON.stringify(input.facts);
  const sourceJson = JSON.stringify(input.sourceIDs);
  const tokens = Math.ceil((input.narrative.length + factsJson.length) / 4);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, generation, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pid,
      input.sessionID,
      input.narrative,
      factsJson,
      sourceJson,
      input.generation,
      tokens,
      Date.now(),
    );
  return id;
}

function gen0Count(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  return (
    db()
      .query(
        "SELECT COUNT(*) as count FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0",
      )
      .get(pid, sessionID) as { count: number }
  ).count;
}

function loadGen0(projectPath: string, sessionID: string): Distillation[] {
  const pid = ensureProject(projectPath);
  const rows = db()
    .query(
      "SELECT * FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 ORDER BY created_at ASC",
    )
    .all(pid, sessionID) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    narrative: string;
    facts: string;
    source_ids: string;
    generation: number;
    token_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    ...r,
    facts: JSON.parse(r.facts) as string[],
    source_ids: JSON.parse(r.source_ids) as string[],
  }));
}

function removeDistillations(ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db()
    .query(`DELETE FROM distillations WHERE id IN (${placeholders})`)
    .run(...ids);
}

// Main distillation entry point — called on session.idle or when urgent
export async function run(input: {
  client: Client;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<{ rounds: number; distilled: number }> {
  const cfg = config();
  const maxRounds = 3;
  let rounds = 0;
  let distilled = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Check if there are enough undistilled messages
    const pending = temporal.undistilled(input.projectPath, input.sessionID);
    if (pending.length < cfg.distillation.minMessages && round === 0) break;

    if (pending.length > 0) {
      const segments = detectSegments(pending, cfg.distillation.maxSegment);
      for (const segment of segments) {
        const result = await distillSegment({
          client: input.client,
          projectPath: input.projectPath,
          sessionID: input.sessionID,
          messages: segment,
          model: input.model,
        });
        if (result) {
          distilled += segment.length;
          rounds++;
        }
      }
    }

    // Check if meta-distillation is needed
    if (
      gen0Count(input.projectPath, input.sessionID) >=
      cfg.distillation.metaThreshold
    ) {
      await metaDistill({
        client: input.client,
        projectPath: input.projectPath,
        sessionID: input.sessionID,
        model: input.model,
      });
      rounds++;
    }

    // Check if we still need urgent distillation
    if (!needsUrgentDistillation()) break;
  }

  return { rounds, distilled };
}

async function distillSegment(input: {
  client: Client;
  projectPath: string;
  sessionID: string;
  messages: TemporalMessage[];
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const prior = latestNarrative(input.projectPath, input.sessionID);
  const text = messagesToText(input.messages);
  const userContent = distillationUser({
    priorNarrative: prior,
    messages: text,
  });

  const workerID = await ensureWorkerSession(input.client, input.sessionID);
  const model = input.model ?? config().model;
  const parts = [
    { type: "text" as const, text: `${DISTILLATION_SYSTEM}\n\n${userContent}` },
  ];

  await input.client.session.prompt({
    path: { id: workerID },
    body: {
      parts,
      agent: "nuum-distill",
      ...(model ? { model } : {}),
    },
  });

  // Read the response
  const msgs = await input.client.session.messages({
    path: { id: workerID },
    query: { limit: 2 },
  });
  const last = msgs.data?.at(-1);
  if (!last || last.info.role !== "assistant") return null;

  const responsePart = last.parts.find((p) => p.type === "text");
  if (!responsePart || responsePart.type !== "text") return null;

  const result = parseDistillationResult(responsePart.text);
  if (!result) return null;

  storeDistillation({
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    narrative: result.narrative,
    facts: result.facts,
    sourceIDs: input.messages.map((m) => m.id),
    generation: 0,
  });
  temporal.markDistilled(input.messages.map((m) => m.id));
  return result;
}

async function metaDistill(input: {
  client: Client;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const existing = loadGen0(input.projectPath, input.sessionID);
  if (existing.length < 3) return null;

  const userContent = recursiveUser(existing);

  const workerID = await ensureWorkerSession(input.client, input.sessionID);
  const model = input.model ?? config().model;
  const parts = [
    { type: "text" as const, text: `${RECURSIVE_SYSTEM}\n\n${userContent}` },
  ];

  await input.client.session.prompt({
    path: { id: workerID },
    body: {
      parts,
      agent: "nuum-distill",
      ...(model ? { model } : {}),
    },
  });

  const msgs = await input.client.session.messages({
    path: { id: workerID },
    query: { limit: 2 },
  });
  const last = msgs.data?.at(-1);
  if (!last || last.info.role !== "assistant") return null;

  const responsePart = last.parts.find((p) => p.type === "text");
  if (!responsePart || responsePart.type !== "text") return null;

  const result = parseDistillationResult(responsePart.text);
  if (!result) return null;

  // Store the meta-distillation at generation N+1
  const maxGen = Math.max(...existing.map((d) => d.generation));
  const allSourceIDs = existing.flatMap((d) => d.source_ids);
  storeDistillation({
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    narrative: result.narrative,
    facts: result.facts,
    sourceIDs: allSourceIDs,
    generation: maxGen + 1,
  });

  // Remove the gen-0 distillations that were merged
  removeDistillations(existing.map((d) => d.id));

  return result;
}
