/**
 * List sessions in lore's temporal storage with distillation status.
 *
 * Usage:
 *   bun run scripts/list-sessions.ts [--project <path>] [--all]
 *
 * Options:
 *   --project <path>  Filter to a specific project path (substring match).
 *   --all             Show sessions from all projects (default if no --project given).
 */

import { parseArgs } from "util";
import { load } from "../src/config";
import { db } from "../src/db";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string" },
    all: { type: "boolean", default: false },
  },
});

// Load config to init DB
await load(process.cwd());

type SessionRow = {
  project_path: string;
  session_id: string;
  total: number;
  distilled: number;
  distillations: number;
  last_msg: number;
};

const projectFilter = values.project;

const rows = db()
  .query<SessionRow, []>(
    `SELECT
       p.path AS project_path,
       t.session_id,
       COUNT(t.id) AS total,
       SUM(t.distilled) AS distilled,
       (SELECT COUNT(*) FROM distillations d WHERE d.session_id = t.session_id AND d.project_id = t.project_id) AS distillations,
       MAX(t.created_at) AS last_msg
     FROM temporal_messages t
     JOIN projects p ON p.id = t.project_id
     GROUP BY t.project_id, t.session_id
     ORDER BY last_msg DESC`,
  )
  .all();

const filtered = projectFilter
  ? rows.filter((r) => r.project_path.includes(projectFilter))
  : rows;

if (!filtered.length) {
  console.log("No sessions found in temporal storage.");
  process.exit(0);
}

console.log(
  `${"PROJECT".padEnd(30)} ${"SESSION ID".padEnd(38)} ${"MSGS".padStart(4)} ${"PEND".padStart(4)} ${"DISTLS".padStart(6)}  LAST ACTIVE`,
);
console.log("-".repeat(100));

for (const row of filtered) {
  const pending = row.total - row.distilled;
  const lastActive = new Date(row.last_msg).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const proj = row.project_path.replace("/home/byk/", "~/").padEnd(30);
  console.log(
    `${proj} ${row.session_id.padEnd(38)} ${String(row.total).padStart(4)} ${String(pending).padStart(4)} ${String(row.distillations).padStart(6)}  ${lastActive}`,
  );
}
