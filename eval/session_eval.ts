/**
 * Self-contained coding session eval harness.
 *
 * Reads session transcripts from JSON files.
 * Default mode: compacts early messages + tail window (simulating OpenCode's behavior).
 * Lore mode: distills on the fly, seeds DB for recall tool access, uses default agent.
 *
 * Usage:
 *   bun eval/session_eval.ts --data eval/data/coding_session_eval.json --mode all --concurrency 3
 */
import { parseArgs } from "util";
import { Database } from "bun:sqlite";
import { DISTILLATION_SYSTEM, distillationUser } from "../src/prompt";

// --- Config ---
const BASE_URL = "http://localhost:4096";
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
const POLL_INTERVAL = 2000;
const MAX_WAIT = 120000;
const TAIL_BUDGET = 80_000; // tokens for default mode tail window
const DISTILL_CHUNK_BUDGET = 20_000; // tokens per distillation segment
const DB_PATH =
  process.env.LORE_DB_PATH ??
  `${process.env.HOME}/.local/share/opencode-lore/lore.db`;

// --- CLI args ---
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string", default: "eval/data/coding_session_eval.json" },
    out: { type: "string", default: "eval/results/session_eval.jsonl" },
    mode: { type: "string", default: "all" }, // "default", "lore", or "all"
    concurrency: { type: "string", default: "3" },
  },
});

const concurrency = parseInt(values.concurrency!, 10);
const targetMode = values.mode!;

// --- Types ---
type SessionMessage = {
  index: number;
  role: string;
  content: string;
  tokens: number;
  timestamp: number;
};

type SessionData = {
  session_id: string;
  label: string;
  project_path: string;
  stats: {
    total_messages: number;
    total_tokens: number;
  };
  messages: SessionMessage[];
};

type Question = {
  session_file: string;
  session_label: string;
  question_type: string;
  question: string;
  answer: string;
  message_index: number;
  cumulative_tokens: number;
};

type TokenInfo = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

type MessageInfo = {
  info: {
    id: string;
    role: string;
    time: { created: number; updated: number };
    cost?: number;
    tokens?: TokenInfo;
  };
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }>;
};

type AggregatedTokens = {
  input: number;
  raw_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  cost: number;
  cache_hit_rate: number;
  api_calls: number;
};

function emptyTokens(): AggregatedTokens {
  return {
    input: 0, raw_input: 0, cache_read: 0, cache_write: 0,
    output: 0, reasoning: 0, cost: 0, cache_hit_rate: 0, api_calls: 0,
  };
}

function aggregateTokens(msgs: MessageInfo[]): AggregatedTokens {
  let rawInput = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, cost = 0;
  for (const msg of msgs) {
    if (msg.info.role !== "assistant" || !msg.info.tokens) continue;
    const t = msg.info.tokens;
    rawInput += t.input;
    cacheRead += t.cache.read;
    cacheWrite += t.cache.write;
    output += t.output;
    reasoning += t.reasoning;
    cost += msg.info.cost ?? 0;
  }
  const totalInput = rawInput + cacheRead + cacheWrite;
  return {
    input: totalInput,
    raw_input: rawInput,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output,
    reasoning,
    cost,
    cache_hit_rate: totalInput > 0 ? cacheRead / totalInput : 0,
    api_calls: 1,
  };
}

function addTokens(a: AggregatedTokens, b: AggregatedTokens): AggregatedTokens {
  const totalInput = a.input + b.input;
  const totalCacheRead = a.cache_read + b.cache_read;
  return {
    input: totalInput,
    raw_input: a.raw_input + b.raw_input,
    cache_read: totalCacheRead,
    cache_write: a.cache_write + b.cache_write,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cost: a.cost + b.cost,
    cache_hit_rate: totalInput > 0 ? totalCacheRead / totalInput : 0,
    api_calls: a.api_calls + b.api_calls,
  };
}

// --- Session management ---
let evalRoot: string;

async function createEvalRoot(): Promise<string> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `session-eval - ${targetMode} - ${new Date().toISOString()}`,
    }),
  }).then((r) => r.json() as Promise<{ id: string }>);
  return res.id;
}

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentID: evalRoot }),
  }).then((r) => r.json() as Promise<{ id: string }>);
  return res.id;
}

async function promptAndWait(
  sessionID: string,
  text: string,
  options?: { system?: string; agent?: string },
): Promise<{ text: string; tokens: AggregatedTokens }> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: options?.system ? `${options.system}\n\n${text}` : text }],
    model: MODEL,
    // Omit agent field to use default agent (with tools like recall).
    // Explicitly pass "lore-distill" for tool-less tasks (distillation, compaction, judge).
    ...(options?.agent !== undefined ? { agent: options.agent } : {}),
  };
  await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const deadline = Date.now() + MAX_WAIT;
  let stableCount = 0;
  let lastMsgCount = 0;
  let lastMsgs: MessageInfo[] = [];

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL);
    const msgs = await fetch(`${BASE_URL}/session/${sessionID}/message`).then(
      (r) => r.json() as Promise<MessageInfo[]>,
    );

    const assistants = msgs.filter((m) => m.info.role === "assistant");
    if (assistants.length > 0) {
      const last = assistants[assistants.length - 1];
      const hasText = last.parts.some((p) => p.type === "text" && p.text?.trim());
      const hasPendingTool = last.parts.some(
        (p) => p.type === "tool" && p.state?.status !== "completed",
      );
      if (hasText && !hasPendingTool) {
        if (msgs.length === lastMsgCount) stableCount++;
        else stableCount = 0;
        if (stableCount >= 1) {
          const textPart = last.parts.find((p) => p.type === "text" && p.text?.trim());
          if (textPart?.text) {
            return { text: textPart.text.trim(), tokens: aggregateTokens(msgs) };
          }
        }
      }
    }
    lastMsgCount = msgs.length;
    lastMsgs = msgs;
  }
  return { text: "[TIMEOUT]", tokens: aggregateTokens(lastMsgs) };
}

// --- Distillation (for lore mode) ---
async function distillTranscript(
  messages: SessionMessage[],
): Promise<string> {
  const segments: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const m of messages) {
    if (tokens + m.tokens > DISTILL_CHUNK_BUDGET && current.length > 0) {
      segments.push(current.join("\n\n"));
      current = [];
      tokens = 0;
    }
    const time = new Date(m.timestamp);
    const hh = time.getHours().toString().padStart(2, "0");
    const mm = time.getMinutes().toString().padStart(2, "0");
    current.push(`[${m.role}] (${hh}:${mm}) ${m.content}`);
    tokens += m.tokens;
  }
  if (current.length) segments.push(current.join("\n\n"));

  const date = messages[0]
    ? new Date(messages[0].timestamp).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "unknown date";

  console.log(`    Distilling ${messages.length} messages in ${segments.length} segments...`);

  let allObservations = "";
  for (let i = 0; i < segments.length; i++) {
    const userMsg = distillationUser({
      date,
      messages: segments[i],
      priorObservations: allObservations || undefined,
    });

    const sid = await createSession();
    const { text: responseText } = await promptAndWait(sid, userMsg, {
      system: DISTILLATION_SYSTEM,
    });
    const match = responseText.match(/<observations>([\s\S]*?)<\/observations>/i);
    const obs = match ? match[1].trim() : responseText.trim();
    allObservations += (allObservations ? "\n" : "") + obs;
    console.log(`    Segment ${i + 1}/${segments.length}: ${obs.length} chars`);
  }
  return allObservations;
}

// --- DB seeding for recall tool access ---
// Seeds temporal messages and distillations into the lore DB so the recall tool
// can find them during lore-mode QA. Uses the current project's ID with eval-
// prefixed session IDs. Cleaned up after the eval completes.
const seededSessionIds: string[] = [];

function getProjectId(): string {
  const d = new Database(DB_PATH, { readonly: true });
  const cwd = process.cwd();
  const row = d.query("SELECT id FROM projects WHERE path = ?").get(cwd) as { id: string } | null;
  d.close();
  if (!row) throw new Error(`No project found for path ${cwd} in lore DB`);
  return row.id;
}

function seedSessionData(
  projectId: string,
  evalSessionId: string,
  messages: SessionMessage[],
  distilled: string,
): void {
  const d = new Database(DB_PATH);

  // Insert temporal messages
  const insertMsg = d.prepare(
    `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const txn = d.transaction(() => {
    for (const m of messages) {
      insertMsg.run(
        `eval_${evalSessionId}_${m.index}`,
        projectId,
        evalSessionId,
        m.role,
        m.content,
        m.tokens,
        m.timestamp,
      );
    }
  });
  txn();

  // Insert distillation
  d.query(
    `INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, observations, generation, token_count, created_at)
     VALUES (?, ?, ?, '', '', '', ?, 0, ?, ?)`,
  ).run(
    `eval_dist_${evalSessionId}`,
    projectId,
    evalSessionId,
    distilled,
    Math.ceil(distilled.length / 4),
    Date.now(),
  );

  // Rebuild FTS index
  d.query("INSERT INTO temporal_fts(temporal_fts) VALUES('rebuild')").run();
  d.close();

  seededSessionIds.push(evalSessionId);
}

function cleanupSeededData(): void {
  if (seededSessionIds.length === 0) return;
  const d = new Database(DB_PATH);
  for (const sid of seededSessionIds) {
    d.query("DELETE FROM temporal_messages WHERE session_id = ?").run(sid);
    d.query("DELETE FROM distillations WHERE session_id = ?").run(sid);
  }
  d.query("INSERT INTO temporal_fts(temporal_fts) VALUES('rebuild')").run();
  d.close();
  console.log(`Cleaned up ${seededSessionIds.length} seeded eval session(s) from DB`);
}

// --- Compaction (for default mode) ---
const COMPACTION_PROMPT =
  "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation.";

const COMPACTION_SYSTEM = `You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation. 
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.`;

async function compactMessages(
  messages: SessionMessage[],
): Promise<string> {
  const CHUNK_TOKEN_LIMIT = 80_000;
  const segments: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const m of messages) {
    const line = `[${m.role}]: ${m.content}`;
    const est = Math.ceil(line.length / 4);
    if (tokens + est > CHUNK_TOKEN_LIMIT && current.length > 0) {
      segments.push(current.join("\n\n"));
      current = [];
      tokens = 0;
    }
    current.push(line);
    tokens += est;
  }
  if (current.length) segments.push(current.join("\n\n"));

  console.log(`    Compacting ${messages.length} dropped messages in ${segments.length} chunk(s)...`);

  let summary = "";
  for (let i = 0; i < segments.length; i++) {
    const prior = summary
      ? `Here is a summary of the conversation so far:\n\n${summary}\n\n---\n\nContinuation of the conversation:\n\n`
      : "";
    const prompt = `${prior}${segments[i]}\n\n${COMPACTION_PROMPT}`;
    const sid = await createSession();
    const { text } = await promptAndWait(sid, prompt, { system: COMPACTION_SYSTEM });
    summary = text;
    console.log(`    Chunk ${i + 1}/${segments.length}: ${summary.length} chars`);
  }
  return summary;
}

function findTailCutoff(messages: SessionMessage[]): number {
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tailTokens += messages[i].tokens;
    if (tailTokens > TAIL_BUDGET) return i + 1;
  }
  return 0;
}

// --- QA prompts ---
const QA_SYSTEM = `You are a helpful coding assistant answering questions about past coding sessions. Answer concisely based on the context provided. If the information is not present in the context, say "I don't know."`;

const QA_SYSTEM_WITH_RECALL = `You are a helpful coding assistant answering questions about past coding sessions. You have distilled observations from the session AND access to a recall tool that can search the raw session messages for specific details. Answer concisely. If the observations don't contain enough detail, use the recall tool to search for it.`;

// --- Process one question ---
async function processQuestion(
  q: Question,
  mode: string,
  context: string,
): Promise<{ hypothesis: string; tokens: AggregatedTokens }> {
  const sid = await createSession();

  if (mode === "lore") {
    // Use the DEFAULT agent (not lore-distill) so the recall tool is available.
    const prompt = `Here are distilled observations from a past coding session:\n\n${context}\n\nQuestion: ${q.question}\n\nAnswer concisely based on the observations. If the observations don't have enough detail, use the recall tool to search for it.`;
    const { text: hypothesis, tokens } = await promptAndWait(sid, prompt, {
      system: QA_SYSTEM_WITH_RECALL,
      // no agent override — uses default agent which has recall tool
    });
    return { hypothesis, tokens };
  }

  // Default mode: compacted summary + tail window (no tools)
  const prompt = `Here is context from a past coding session:\n\n${context}\n\nQuestion: ${q.question}\n\nAnswer concisely:`;
  const { text: hypothesis, tokens } = await promptAndWait(sid, prompt, {
    system: QA_SYSTEM,
    agent: "lore-distill",
  });
  return { hypothesis, tokens };
}

// --- Judge ---
const JUDGE_SYSTEM = `You are evaluating whether a hypothesis correctly answers a question about a coding session. Compare the hypothesis against the reference answer. Say "yes" if the hypothesis contains the key information from the reference (it can have extra detail). Say "no" if critical information is missing or wrong. Respond with ONLY "yes" or "no".`;

async function judge(
  question: string,
  reference: string,
  hypothesis: string,
): Promise<boolean> {
  const prompt = `Question: ${question}\nReference answer: ${reference}\nHypothesis: ${hypothesis}\n\nDoes the hypothesis correctly answer the question?`;
  const sid = await createSession();
  const { text: response } = await promptAndWait(sid, prompt, {
    system: JUDGE_SYSTEM,
  });
  return response.toLowerCase().startsWith("yes");
}

// --- Concurrency pool ---
async function pool<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  max: number,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
  return results;
}

// =========== MAIN ===========

// Load questions
const questions: Question[] = await Bun.file(values.data!).json();
const modes = targetMode === "all" ? ["default", "lore"] : [targetMode];

console.log("Session Memory Eval (self-contained)");
console.log(`Mode: ${targetMode}`);
console.log(`Questions: ${questions.length}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Output: ${values.out}`);
console.log("");

// Load and prepare session data (keyed by session_file)
type SessionCache = {
  data: SessionData;
  defaultContext: string;
  distilled: string;
  evalSessionId: string; // eval-prefixed session ID for DB seeding
};

const sessionCache = new Map<string, SessionCache>();
const sessionFiles = [...new Set(questions.map((q) => q.session_file))];

evalRoot = await createEvalRoot();

// Get project ID for DB seeding
let projectId: string | null = null;
if (modes.includes("lore")) {
  try {
    projectId = getProjectId();
    console.log(`Recall tool: will seed DB under project ${projectId}`);
  } catch (e: any) {
    console.log(`Warning: ${e.message} — recall tool won't work, falling back to distillation-only`);
  }
  console.log("");
}

for (const file of sessionFiles) {
  const data: SessionData = await Bun.file(file).json();
  const totalTokens = data.messages.reduce((s, m) => s + m.tokens, 0);
  console.log(`Loading session: ${data.label} (${data.stats.total_messages} msgs, ${Math.round(totalTokens / 1000)}K tokens)`);

  // Find where the 80K tail cutoff lands
  const cutoffIdx = findTailCutoff(data.messages);
  const droppedMsgs = data.messages.slice(0, cutoffIdx);
  const tailMsgs = data.messages.slice(cutoffIdx);
  const droppedTokens = droppedMsgs.reduce((s, m) => s + m.tokens, 0);
  const tailTokens = tailMsgs.reduce((s, m) => s + m.tokens, 0);

  console.log(`  Tail window: msgs ${cutoffIdx}-${data.messages.length - 1} (${Math.round(tailTokens / 1000)}K tokens, ${tailMsgs.length} msgs)`);
  console.log(`  Dropped: msgs 0-${cutoffIdx - 1} (${Math.round(droppedTokens / 1000)}K tokens, ${droppedMsgs.length} msgs)`);

  // Build default context: compact dropped messages + tail window
  let defaultContext: string;
  if (modes.includes("default") && droppedMsgs.length > 0) {
    console.log(`  Building default context (compaction + tail)...`);
    const compacted = await compactMessages(droppedMsgs);
    const tailText = tailMsgs.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    defaultContext = `Here is a summary of earlier conversation:\n\n${compacted}\n\n---\n\nRecent conversation:\n\n${tailText}`;
    console.log(`  Compacted summary: ${compacted.length} chars (~${Math.round(compacted.length / 4)} tokens)`);
  } else {
    defaultContext = data.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  }

  // Distill and seed DB if needed for lore mode
  let distilled = "";
  const evalSessionId = `eval_${Date.now()}_${data.label}`;
  if (modes.includes("lore")) {
    console.log(`  Distilling for lore mode...`);
    distilled = await distillTranscript(data.messages);
    console.log(`  Distilled: ${distilled.length} chars (~${Math.round(distilled.length / 4)} tokens)`);

    // Seed the DB so the recall tool can find the raw messages
    if (projectId) {
      seedSessionData(projectId, evalSessionId, data.messages, distilled);
      console.log(`  Seeded ${data.messages.length} messages + 1 distillation into DB (session: ${evalSessionId})`);
    }
  }

  sessionCache.set(file, { data, defaultContext, distilled, evalSessionId });
  console.log("");
}

// Build work items
const work: Array<{ q: Question; mode: string }> = [];
for (const mode of modes) {
  for (const q of questions) {
    work.push({ q, mode });
  }
}

const startTime = Date.now();
let completed = 0;
const writer = Bun.file(values.out!).writer();

// Ensure cleanup happens even on error/interrupt
process.on("SIGINT", () => { cleanupSeededData(); process.exit(1); });
process.on("SIGTERM", () => { cleanupSeededData(); process.exit(1); });

try {
  await pool(
    work,
    async ({ q, mode }) => {
      const session = sessionCache.get(q.session_file)!;
      const context = mode === "lore" ? session.distilled : session.defaultContext;
      const result = await processQuestion(q, mode, context);
      const label = await judge(q.question, q.answer, result.hypothesis);
      const entry = {
        session_label: q.session_label,
        question_type: q.question_type,
        question: q.question,
        answer: q.answer,
        hypothesis: result.hypothesis,
        mode,
        label,
        tokens: result.tokens,
        cumulative_tokens: q.cumulative_tokens,
      };
      writer.write(JSON.stringify(entry) + "\n");
      writer.flush();
      completed++;

      const t = result.tokens;
      const cacheStr = t.input > 0
        ? ` [${(t.cache_hit_rate * 100).toFixed(0)}% cache, ${(t.input / 1000).toFixed(1)}K in, $${t.cost.toFixed(4)}]`
        : "";
      const icon = label ? "✓" : "✗";
      console.log(
        `[${completed}/${work.length}] ${icon} ${mode.padEnd(7)} ${q.session_label.padEnd(20)} ${q.question_type.padEnd(14)} "${q.question.substring(0, 45)}"${cacheStr}`,
      );
      return entry;
    },
    concurrency,
  );
} finally {
  cleanupSeededData();
}

writer.end();

// --- Summary ---
const results = (await Bun.file(values.out!).text())
  .trim()
  .split("\n")
  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

console.log("\n=== Results ===");
for (const mode of modes) {
  const modeResults = results.filter((r: any) => r.mode === mode);
  const correct = modeResults.filter((r: any) => r.label).length;
  console.log(
    `${mode.padEnd(10)} ${correct}/${modeResults.length} (${((correct / modeResults.length) * 100).toFixed(1)}%)`,
  );
}

// By session
if (modes.length > 0) {
  console.log("\n--- By session ---");
  for (const label of [...new Set(results.map((r: any) => r.session_label))]) {
    console.log(`\n${label}:`);
    for (const mode of modes) {
      const subset = results.filter(
        (r: any) => r.mode === mode && r.session_label === label,
      );
      const correct = subset.filter((r: any) => r.label).length;
      console.log(
        `  ${mode.padEnd(10)} ${correct}/${subset.length} (${((correct / subset.length) * 100).toFixed(1)}%)`,
      );
    }
  }
}

// By question type
console.log("\n--- By question type ---");
for (const qtype of [...new Set(results.map((r: any) => r.question_type))]) {
  console.log(`\n${qtype}:`);
  for (const mode of modes) {
    const subset = results.filter(
      (r: any) => r.mode === mode && r.question_type === qtype,
    );
    if (!subset.length) continue;
    const correct = subset.filter((r: any) => r.label).length;
    console.log(
      `  ${mode.padEnd(10)} ${correct}/${subset.length} (${((correct / subset.length) * 100).toFixed(1)}%)`,
    );
  }
}

// Token usage
console.log("\n=== Token Usage ===");
for (const mode of modes) {
  const modeResults = results.filter((r: any) => r.mode === mode && r.tokens);
  if (!modeResults.length) continue;

  const totals = modeResults.reduce(
    (acc: AggregatedTokens, r: any) => addTokens(acc, r.tokens as AggregatedTokens),
    emptyTokens(),
  );
  const n = modeResults.length;
  const correct = modeResults.filter((r: any) => r.label).length;

  console.log(`\n${mode}:`);
  console.log(`  Avg input/question : ${(totals.input / n / 1000).toFixed(1)}K tokens`);
  console.log(`  Avg output/question: ${(totals.output / n).toFixed(0)} tokens`);
  console.log(`  Cache hit rate     : ${(totals.cache_hit_rate * 100).toFixed(1)}%`);
  console.log(`    cache_read total : ${(totals.cache_read / 1000).toFixed(1)}K`);
  console.log(`    cache_write total: ${(totals.cache_write / 1000).toFixed(1)}K`);
  console.log(`    raw_input total  : ${(totals.raw_input / 1000).toFixed(1)}K`);
  console.log(`  Total cost         : $${totals.cost.toFixed(4)}`);
  console.log(`  Cost/correct answer: $${correct > 0 ? (totals.cost / correct).toFixed(4) : "N/A"}`);
  console.log(`  Total API calls    : ${totals.api_calls}`);
}

const elapsed = (Date.now() - startTime) / 1000;
console.log(`\nDone! ${completed} evaluations in ${elapsed.toFixed(1)}s`);
