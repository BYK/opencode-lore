/**
 * Extract a session transcript from the lore DB into a self-contained JSON file.
 * Strips Lore-specific artifacts (recall tool results, system-reminder tags)
 * but keeps the core technical content intact.
 *
 * Usage:
 *   bun eval/extract_session.ts --session <id-prefix> --out eval/data/sessions/<label>.json [--label <label>]
 */
import { parseArgs } from "util";
import { Database } from "bun:sqlite";

const DB_PATH =
  process.env.LORE_DB_PATH ??
  `${process.env.HOME}/.local/share/opencode-lore/lore.db`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string" },
    out: { type: "string" },
    label: { type: "string" },
  },
});

if (!values.session) {
  console.log("Usage: extract_session.ts --session <id-prefix> --out <path> [--label <name>]");
  process.exit(1);
}

const d = new Database(DB_PATH, { readonly: true });

// Find the session
const sessions = d
  .query(
    "SELECT DISTINCT session_id FROM temporal_messages WHERE session_id LIKE ?",
  )
  .all(values.session + "%") as Array<{ session_id: string }>;

if (sessions.length === 0) {
  console.error("No session found matching:", values.session);
  process.exit(1);
}
if (sessions.length > 1) {
  console.error("Multiple sessions match:");
  for (const s of sessions) console.error("  " + s.session_id);
  process.exit(1);
}

const sessionID = sessions[0].session_id;
console.log("Extracting session:", sessionID);

// Get project path
const projRow = d
  .query(
    `SELECT p.path FROM projects p
     JOIN temporal_messages t ON t.project_id = p.id
     WHERE t.session_id = ? LIMIT 1`,
  )
  .get(sessionID) as { path: string } | null;

// Get all messages
const messages = d
  .query(
    "SELECT role, content, tokens, created_at FROM temporal_messages WHERE session_id = ? ORDER BY created_at ASC",
  )
  .all(sessionID) as Array<{
  role: string;
  content: string;
  tokens: number;
  created_at: number;
}>;

d.close();

// Clean messages: strip Lore-specific artifacts
function cleanContent(content: string): string {
  let cleaned = content;

  // Strip <system-reminder>...</system-reminder> blocks
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");

  // Strip recall tool results embedded in messages
  // (keep the recall tool invocation itself as it shows intent, but strip the returned data)
  cleaned = cleaned.replace(
    /\[tool:recall\]\s*## Distilled History[\s\S]*?(?=\[tool:|$)/g,
    "[tool:recall] [recall results stripped for eval]\n",
  );

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

const cleanedMessages = messages.map((m, i) => ({
  index: i,
  role: m.role,
  content: cleanContent(m.content),
  tokens: m.tokens,
  timestamp: m.created_at,
}));

// Compute stats
const totalTokens = messages.reduce((s, m) => s + m.tokens, 0);
const userMsgs = messages.filter((m) => m.role === "user").length;
const assistantMsgs = messages.filter((m) => m.role === "assistant").length;
const firstDate = new Date(messages[0].created_at).toISOString();
const lastDate = new Date(messages[messages.length - 1].created_at).toISOString();

const label = values.label ?? sessionID.substring(4, 20);

const output = {
  session_id: sessionID,
  label,
  project_path: projRow?.path ?? "unknown",
  stats: {
    total_messages: messages.length,
    user_messages: userMsgs,
    assistant_messages: assistantMsgs,
    total_tokens: totalTokens,
    first_message: firstDate,
    last_message: lastDate,
  },
  messages: cleanedMessages,
};

const outPath = values.out ?? `eval/data/sessions/${label}.json`;
await Bun.write(outPath, JSON.stringify(output, null, 2));

console.log(`\nExtracted ${messages.length} messages (${Math.round(totalTokens / 1000)}K tokens)`);
console.log(`  User: ${userMsgs}, Assistant: ${assistantMsgs}`);
console.log(`  Period: ${firstDate.substring(0, 16)} → ${lastDate.substring(0, 16)}`);
console.log(`  Project: ${projRow?.path ?? "unknown"}`);
console.log(`  Written to: ${outPath}`);
