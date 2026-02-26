import { Database } from "bun:sqlite";
import { DISTILLATION_SYSTEM, distillationUser } from "../src/prompt";

const BASE_URL = "http://localhost:4096";
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

const DB_PATH =
  process.env.NUUM_DB ??
  `${process.env.HOME}/.local/share/opencode-lore/lore.db`;

// Find sessions with undistilled messages
function findUndistilledSessions(): Array<{
  session_id: string;
  project_id: string;
  total: number;
  undistilled: number;
  distillations: number;
}> {
  const d = new Database(DB_PATH, { readonly: true });
  const sessions = d
    .query(
      `SELECT session_id, project_id,
              COUNT(*) as total,
              SUM(CASE WHEN distilled = 0 THEN 1 ELSE 0 END) as undistilled
       FROM temporal_messages
       GROUP BY session_id, project_id
       HAVING undistilled > 0
       ORDER BY undistilled DESC`,
    )
    .all() as Array<{
    session_id: string;
    project_id: string;
    total: number;
    undistilled: number;
  }>;

  const result = sessions.map((s) => {
    const dists = (
      d
        .query(
          "SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id = ?",
        )
        .get(s.project_id, s.session_id) as { c: number }
    ).c;
    return { ...s, distillations: dists };
  });
  d.close();
  return result;
}

const sessions = findUndistilledSessions();
console.log("Sessions with undistilled messages:");
for (const s of sessions) {
  console.log(
    `  ${s.session_id.substring(0, 16)} total=${s.total} undistilled=${s.undistilled} distillations=${s.distillations}`,
  );
}

if (!sessions.length) {
  console.log("Nothing to backfill.");
  process.exit(0);
}

// For each session, trigger distillation by sending a dummy prompt to a child session.
// The lore plugin will pick it up on session.idle.
// Actually, we can just call the distillation directly via the API by sending
// a special message that triggers the plugin.

// Simpler approach: the eval already has on-demand distillation. Let's just
// trigger distillation for each session by creating a temporary session and
// using the lore-distill agent directly.

// Actually, the simplest approach: just mark the session as needing distillation
// and let the plugin handle it on next session.idle. But that requires user activity.

// Real approach: use the same on-demand distillation from the eval, but store
// the results in the lore DB.

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string" },
    all: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    wipe: { type: "boolean", default: false },
  },
});

// When --wipe is set, we operate on all sessions that have temporal messages,
// not just those with undistilled messages, since wipe resets distilled=0 first.
function findAllSessions(): Array<{
  session_id: string;
  project_id: string;
  total: number;
  undistilled: number;
  distillations: number;
}> {
  const d = new Database(DB_PATH, { readonly: true });
  const rows = d
    .query(
      `SELECT session_id, project_id, COUNT(*) as total,
              SUM(CASE WHEN distilled = 0 THEN 1 ELSE 0 END) as undistilled
       FROM temporal_messages
       GROUP BY session_id, project_id
       ORDER BY total DESC`,
    )
    .all() as Array<{
    session_id: string;
    project_id: string;
    total: number;
    undistilled: number;
  }>;

  const result = rows.map((s) => {
    const dists = (
      d
        .query(
          "SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id = ?",
        )
        .get(s.project_id, s.session_id) as { c: number }
    ).c;
    return { ...s, distillations: dists };
  });
  d.close();
  return result;
}

const allSessions = values.wipe ? findAllSessions() : sessions;

const targets = values.all
  ? allSessions
  : values.session
    ? allSessions.filter((s) => s.session_id.includes(values.session!))
    : [];

if (!targets.length) {
  console.log("\nUsage: backfill.ts --all  OR  --session <id-prefix>  [--wipe]");
  process.exit(1);
}

if (values["dry-run"]) {
  const action = values.wipe ? "wipe + re-distill" : "backfill";
  console.log(`\nDry run — would ${action}`, targets.length, "sessions");
  process.exit(0);
}

// --wipe: delete existing distillations and reset distilled=0 before backfilling.
if (values.wipe) {
  console.log(`\nWiping distillations for ${targets.length} session(s)...`);
  const d = new Database(DB_PATH);
  for (const session of targets) {
    const { changes: delDist } = d
      .query("DELETE FROM distillations WHERE project_id = ? AND session_id = ?")
      .run(session.project_id, session.session_id);
    const { changes: resetMsgs } = d
      .query("UPDATE temporal_messages SET distilled = 0 WHERE project_id = ? AND session_id = ?")
      .run(session.project_id, session.session_id);
    console.log(
      `  ${session.session_id.substring(0, 16)}: deleted ${delDist} distillation(s), reset ${resetMsgs} message(s)`,
    );
    // Refresh undistilled count after reset
    session.undistilled = session.total;
    session.distillations = 0;
  }
  d.close();
  console.log("");
}

// Create an eval root to hide worker sessions
const evalRoot = await fetch(`${BASE_URL}/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: `backfill - ${new Date().toISOString()}` }),
}).then((r) => r.json() as Promise<{ id: string }>);

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentID: evalRoot.id }),
  }).then((r) => r.json() as Promise<{ id: string }>);
  return res.id;
}

async function promptAndWait(
  sessionID: string,
  text: string,
  system: string,
): Promise<string> {
  await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: `${system}\n\n${text}` }],
      model: MODEL,
      agent: "lore-distill",
    }),
  });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    const msgs = await fetch(
      `${BASE_URL}/session/${sessionID}/message`,
    ).then(
      (r) =>
        r.json() as Promise<
          Array<{
            info: { role: string };
            parts: Array<{ type: string; text?: string }>;
          }>
        >,
    );
    const last = msgs.filter((m) => m.info.role === "assistant").at(-1);
    if (last) {
      const text = last.parts.find((p) => p.type === "text");
      if (text?.text) return text.text.trim();
    }
  }
  return "[TIMEOUT]";
}



for (const session of targets) {
  console.log(
    `\nBackfilling ${session.session_id.substring(0, 16)} (${session.undistilled} undistilled messages)...`,
  );

  // Read undistilled messages
  const d = new Database(DB_PATH);
  const msgs = d
    .query(
      "SELECT id, role, content, created_at FROM temporal_messages WHERE project_id = ? AND session_id = ? AND distilled = 0 ORDER BY created_at ASC",
    )
    .all(session.project_id, session.session_id) as Array<{
    id: string;
    role: string;
    content: string;
    created_at: number;
  }>;

  // Chunk into segments of ~50 messages (matching maxSegment config)
  const maxSegment = 50;
  const segments: typeof msgs[] = [];
  for (let i = 0; i < msgs.length; i += maxSegment) {
    segments.push(msgs.slice(i, i + maxSegment));
  }

  console.log(`  ${segments.length} segments to distill`);

  // Get latest observations for context continuity
  const latestObs = d
    .query(
      "SELECT observations FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(session.project_id, session.session_id) as {
    observations: string;
  } | null;

  let priorObs = latestObs?.observations;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const date = new Date(segment[0].created_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const text = segment
      .map((m) => {
        const t = new Date(m.created_at);
        return `[${m.role}] (${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}) ${m.content}`;
      })
      .join("\n\n");

    const userMsg = distillationUser({
      date,
      messages: text,
      priorObservations: priorObs,
    });

    const sid = await createSession();
    const response = await promptAndWait(sid, userMsg, DISTILLATION_SYSTEM);
    const match = response.match(/<observations>([\s\S]*?)<\/observations>/i);
    const observations = match ? match[1].trim() : response.trim();

    // Store in lore DB
    const distId = crypto.randomUUID();
    const sourceJson = JSON.stringify(segment.map((m) => m.id));
    const tokens = Math.ceil(observations.length / 4);
    d.query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at)
       VALUES (?, ?, ?, '', '[]', ?, ?, 0, ?, ?)`,
    ).run(
      distId,
      session.project_id,
      session.session_id,
      observations,
      sourceJson,
      tokens,
      Date.now(),
    );

    // Mark messages as distilled
    const ids = segment.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    d.query(
      `UPDATE temporal_messages SET distilled = 1 WHERE id IN (${placeholders})`,
    ).run(...ids);

    priorObs = observations;
    console.log(
      `  Segment ${i + 1}/${segments.length}: ${observations.length} chars, ${segment.length} messages`,
    );
  }

  d.close();
}

console.log("\nBackfill complete!");
