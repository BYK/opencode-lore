/**
 * Run nuum distillation on a past (or active) session.
 *
 * Usage:
 *   bun run scripts/distill-session.ts <sessionID> [--project <path>] [--url <server-url>]
 *
 * Options:
 *   <sessionID>         Required. The OpenCode session ID to distill.
 *   --project <path>    Project path for nuum context. Defaults to cwd.
 *   --url <url>         OpenCode server URL. Defaults to http://localhost:4096.
 *   --dry-run           Show pending message count but don't distill.
 *
 * The session must already have messages stored in nuum's temporal DB.
 * If you need to backfill temporal storage first, use backfill-session.ts.
 */

import { parseArgs } from "util";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { load, config } from "../src/config";
import { ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import * as distillation from "../src/distillation";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string" },
    url: { type: "string", default: "http://localhost:4096" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const sessionID = positionals[0];
if (!sessionID) {
  console.error("Usage: bun run scripts/distill-session.ts <sessionID> [--project <path>] [--url <url>] [--dry-run]");
  process.exit(1);
}

const projectPath = values.project ?? process.cwd();
const serverUrl = values.url!;
const dryRun = values["dry-run"];
const force = values.force;

// Load nuum config and init DB
await load(projectPath);
ensureProject(projectPath);

const pending = temporal.undistilledCount(projectPath, sessionID);
const total = temporal.count(projectPath, sessionID);

console.log(`Session:  ${sessionID}`);
console.log(`Project:  ${projectPath}`);
console.log(`Server:   ${serverUrl}`);
console.log(`Messages: ${total} total, ${pending} undistilled`);
console.log("");

if (pending === 0) {
  console.log("Nothing to distill — all messages already distilled.");
  process.exit(0);
}

if (dryRun) {
  console.log("--dry-run: skipping distillation.");
  process.exit(0);
}

const cfg = config();
const minMessages = cfg.distillation.minMessages;

if (pending < minMessages && !force) {
  console.log(`Only ${pending} undistilled messages (min: ${minMessages}). Use --force to distill anyway.`);
  process.exit(0);
}

const client = createOpencodeClient({ baseUrl: serverUrl });

console.log("Running distillation...");
const { rounds, distilled } = await distillation.run({
  client,
  projectPath,
  sessionID,
  model: cfg.model,
  force: force || pending < minMessages,
});

console.log(`Done. ${rounds} round(s), ${distilled} messages distilled.`);
