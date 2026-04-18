import { db, ensureProject } from "./db";
import { config } from "./config";
import * as temporal from "./temporal";
import * as embedding from "./embedding";
import * as log from "./log";
import {
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
} from "./prompt";
import { needsUrgentDistillation } from "./gradient";
import { workerSessionIDs } from "./worker";
import type { LLMClient } from "./types";

// Re-export for backwards compat — index.ts and others may still import from here.
export { workerSessionIDs };

type TemporalMessage = temporal.TemporalMessage;

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

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function messagesToText(messages: TemporalMessage[]): string {
  return messages
    .map((m) => `[${m.role}] (${formatTime(m.created_at)}) ${m.content}`)
    .join("\n\n");
}

type DistillationResult = {
  observations: string;
};

function parseDistillationResult(text: string): DistillationResult | null {
  // Extract content from <observations>...</observations> block
  const match = text.match(/<observations>([\s\S]*?)<\/observations>/i);
  const observations = match ? match[1].trim() : text.trim();
  if (!observations) return null;
  return { observations };
}

// Get the most recent observations for context
function latestObservations(
  projectPath: string,
  sessionID: string,
): string | undefined {
  const pid = ensureProject(projectPath);
  const row = db()
    .query(
      "SELECT observations FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(pid, sessionID) as { observations: string } | null;
  return row?.observations || undefined;
}

/** Safely parse the source_ids JSON column. Defaults to [] on corrupt data. */
export function parseSourceIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    log.warn("corrupt source_ids in distillation, defaulting to []");
    return [];
  }
}

export type Distillation = {
  id: string;
  project_id: string;
  session_id: string;
  observations: string;
  source_ids: string[];
  generation: number;
  token_count: number;
  created_at: number;
};

/** Load all distillations for a session, oldest first. */
export function loadForSession(
  projectPath: string,
  sessionID: string,
): Distillation[] {
  const pid = ensureProject(projectPath);
  const rows = db()
    .query(
      "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC",
    )
    .all(pid, sessionID) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    observations: string;
    source_ids: string;
    generation: number;
    token_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    ...r,
    source_ids: parseSourceIds(r.source_ids),
  }));
}

function storeDistillation(input: {
  projectPath: string;
  sessionID: string;
  observations: string;
  sourceIDs: string[];
  generation: number;
}): string {
  const pid = ensureProject(input.projectPath);
  const id = crypto.randomUUID();
  const sourceJson = JSON.stringify(input.sourceIDs);
  const tokens = Math.ceil(input.observations.length / 3);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pid,
      input.sessionID,
      "", // legacy column — kept for schema compat
      "[]", // legacy column — kept for schema compat
      input.observations,
      sourceJson,
      input.generation,
      tokens,
      Date.now(),
    );
  return id;
}

// Count non-archived gen-0 distillations — these are the ones awaiting
// meta-distillation. Archived gen-0 entries have already been consolidated.
function gen0Count(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  return (
    db()
      .query(
        "SELECT COUNT(*) as count FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 AND archived = 0",
      )
      .get(pid, sessionID) as { count: number }
  ).count;
}

// Load non-archived gen-0 distillations for meta-distillation input.
function loadGen0(projectPath: string, sessionID: string): Distillation[] {
  const pid = ensureProject(projectPath);
  const rows = db()
    .query(
      "SELECT id, project_id, session_id, observations, source_ids, generation, token_count, created_at FROM distillations WHERE project_id = ? AND session_id = ? AND generation = 0 AND archived = 0 ORDER BY created_at ASC",
    )
    .all(pid, sessionID) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    observations: string;
    source_ids: string;
    generation: number;
    token_count: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    ...r,
    source_ids: parseSourceIds(r.source_ids),
  }));
}

// Archive distillations instead of deleting them. Archived entries are excluded
// from the in-context prefix (loadDistillations filters them out) but remain
// searchable via the recall tool (searchDistillations includes them). This
// preserves a detailed "zoom-in" layer beneath the compressed gen-1 summary.
// Inspired by Cartridges (Eyuboglu et al., 2025): independently compressed
// representations remain composable and queryable after consolidation.
// Reference: https://arxiv.org/abs/2501.17390
function archiveDistillations(ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db()
    .query(
      `UPDATE distillations SET archived = 1 WHERE id IN (${placeholders})`,
    )
    .run(...ids);
}

// Reset messages that were marked distilled by a previous format/run but aren't
// covered by any current distillation. This happens when distillations are deleted
// (e.g., format migration from v1 to v2) but the temporal messages keep distilled=1.
function resetOrphans(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  // Collect all message IDs referenced by existing distillations
  const rows = db()
    .query(
      "SELECT source_ids FROM distillations WHERE project_id = ? AND session_id = ?",
    )
    .all(pid, sessionID) as Array<{ source_ids: string }>;
  const covered = new Set<string>();
  for (const r of rows) {
    for (const id of parseSourceIds(r.source_ids)) covered.add(id);
  }
  if (rows.length === 0) {
    // No distillations at all — reset everything to undistilled
    const result = db()
      .query(
        "UPDATE temporal_messages SET distilled = 0 WHERE project_id = ? AND session_id = ? AND distilled = 1",
      )
      .run(pid, sessionID);
    // node:sqlite returns `changes` as `number | bigint`; bun:sqlite returns `number`.
    // Coerce to number — SQLite will never return a row count > 2^53.
    return Number(result.changes);
  }
  // Find orphans: marked distilled but not in any source_ids
  const distilled = db()
    .query(
      "SELECT id FROM temporal_messages WHERE project_id = ? AND session_id = ? AND distilled = 1",
    )
    .all(pid, sessionID) as Array<{ id: string }>;
  const orphans = distilled.filter((m) => !covered.has(m.id)).map((m) => m.id);
  if (!orphans.length) return 0;
  // Reset in batches to avoid SQLite parameter limit
  const batch = 500;
  for (let i = 0; i < orphans.length; i += batch) {
    const chunk = orphans.slice(i, i + batch);
    const placeholders = chunk.map(() => "?").join(",");
    db()
      .query(
        `UPDATE temporal_messages SET distilled = 0 WHERE id IN (${placeholders})`,
      )
      .run(...chunk);
  }
  return orphans.length;
}

// Main distillation entry point — called on session.idle or when urgent
export async function run(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  /** Skip minMessages threshold check — distill whatever is pending */
  force?: boolean;
}): Promise<{ rounds: number; distilled: number }> {
  // Reset orphaned messages (marked distilled by a deleted/migrated distillation)
  const orphans = resetOrphans(input.projectPath, input.sessionID);
  if (orphans > 0) {
    log.info(
      `Reset ${orphans} orphaned messages for re-observation`,
    );
  }

  const cfg = config();
  const maxRounds = 3;
  let rounds = 0;
  let distilled = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Check if there are enough undistilled messages
    const pending = temporal.undistilled(input.projectPath, input.sessionID);
    if (
      !input.force &&
      pending.length < cfg.distillation.minMessages &&
      round === 0
    )
      break;

    if (pending.length > 0) {
      const segments = detectSegments(pending, cfg.distillation.maxSegment);
      for (const segment of segments) {
        const result = await distillSegment({
          llm: input.llm,
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
        llm: input.llm,
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
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  messages: TemporalMessage[];
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const prior = latestObservations(input.projectPath, input.sessionID);
  const text = messagesToText(input.messages);
  // Derive session date from first message timestamp
  const first = input.messages[0];
  const date = first
    ? new Date(first.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "unknown date";
  const userContent = distillationUser({
    priorObservations: prior,
    date,
    messages: text,
  });

  const model = input.model ?? config().model;
  const responseText = await input.llm.prompt(
    DISTILLATION_SYSTEM,
    userContent,
    { model, workerID: "lore-distill" },
  );
  if (!responseText) return null;

  const result = parseDistillationResult(responseText);
  if (!result) return null;

  const distillId = storeDistillation({
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    observations: result.observations,
    sourceIDs: input.messages.map((m) => m.id),
    generation: 0,
  });
  temporal.markDistilled(input.messages.map((m) => m.id));

  // Fire-and-forget: embed the distillation for vector search
  if (embedding.isAvailable()) {
    embedding.embedDistillation(distillId, result.observations);
  }

  return result;
}

async function metaDistill(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
}): Promise<DistillationResult | null> {
  const existing = loadGen0(input.projectPath, input.sessionID);
  if (existing.length < 3) return null;

  const userContent = recursiveUser(existing);

  const model = input.model ?? config().model;
  const responseText = await input.llm.prompt(
    RECURSIVE_SYSTEM,
    userContent,
    { model, workerID: "lore-distill" },
  );
  if (!responseText) return null;

  const result = parseDistillationResult(responseText);
  if (!result) return null;

  // Store the meta-distillation at generation N+1
  const maxGen = Math.max(...existing.map((d) => d.generation));
  const allSourceIDs = existing.flatMap((d) => d.source_ids);
  const metaId = storeDistillation({
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    observations: result.observations,
    sourceIDs: allSourceIDs,
    generation: maxGen + 1,
  });

  // Fire-and-forget: embed the meta-distillation for vector search
  if (embedding.isAvailable()) {
    embedding.embedDistillation(metaId, result.observations);
  }

  // Archive the gen-0 distillations that were merged into gen-1+.
  // They remain searchable via recall but excluded from the in-context prefix.
  archiveDistillations(existing.map((d) => d.id));

  return result;
}
