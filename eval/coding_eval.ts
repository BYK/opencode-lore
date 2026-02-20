import { parseArgs } from "util";
import { Database } from "bun:sqlite";

const BASE_URL = "http://localhost:4096";
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
const POLL_INTERVAL = 2000;
const MAX_WAIT = 120000;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string", default: "eval/data/coding_memory_eval.json" },
    out: { type: "string", default: "eval/results/coding_eval.jsonl" },
    mode: { type: "string", default: "all" }, // "default", "lore", or "all"
    concurrency: { type: "string", default: "3" },
  },
});

const concurrency = parseInt(values.concurrency!, 10);
const targetMode = values.mode!;

type Question = {
  session_id: string;
  session_label: string;
  question: string;
  answer: string;
  question_type: string;
  message_index: number;
};

// --- DB access ---
const DB_PATH =
  process.env.NUUM_DB ??
  `${process.env.HOME}/.local/share/opencode-lore/lore.db`;

function getTemporalMessages(sessionID: string): Array<{
  role: string;
  content: string;
  tokens: number;
  created_at: number;
}> {
  const d = new Database(DB_PATH, { readonly: true });
  const rows = d
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
  return rows;
}

function getDistillations(
  sessionID: string,
): Array<{ observations: string; created_at: number }> {
  const d = new Database(DB_PATH, { readonly: true });
  const projectRow = d
    .query(
      "SELECT DISTINCT project_id FROM temporal_messages WHERE session_id = ? LIMIT 1",
    )
    .get(sessionID) as { project_id: string } | null;
  if (!projectRow) {
    d.close();
    return [];
  }
  const rows = d
    .query(
      "SELECT observations, created_at FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC",
    )
    .all(projectRow.project_id, sessionID) as Array<{
    observations: string;
    created_at: number;
  }>;
  d.close();
  return rows;
}


// Purge temporal messages from eval sessions to prevent recall tool contamination.
// Eval sessions are small (≤5 messages) and not in the test dataset.
function purgeEvalMessages(testSessionIDs: string[]) {
  const d = new Database(DB_PATH);
  const testSet = new Set(testSessionIDs);

  // Find small sessions (≤5 messages) that aren't test sessions
  const sessions = d
    .query(
      'SELECT session_id, count(*) as c FROM temporal_messages GROUP BY session_id HAVING c <= 5',
    )
    .all() as Array<{ session_id: string; c: number }>;
  const toDelete = sessions.filter((s) => !testSet.has(s.session_id));
  if (!toDelete.length) {
    d.close();
    return;
  }

  // Delete content table rows in batches, then rebuild FTS index.
  // FTS5 content-sync tables don't support direct DELETE — must rebuild after content changes.
  const batch = 100;
  let deleted = 0;
  const totalMsgs = toDelete.reduce((s, x) => s + x.c, 0);
  for (let i = 0; i < toDelete.length; i += batch) {
    const chunk = toDelete.slice(i, i + batch).map((s) => s.session_id);
    const placeholders = chunk.map(() => '?').join(',');
    d.query(
      `DELETE FROM temporal_messages WHERE session_id IN (${placeholders})`,
    ).run(...chunk);
    deleted += chunk.length;
  }
  // Rebuild FTS index to reflect deleted rows
  d.query("INSERT INTO temporal_fts(temporal_fts) VALUES('rebuild')").run();
  d.close();
  console.log(`Purged ${deleted} eval sessions (${totalMsgs} messages) from temporal storage`);
}

// --- Eval root session (hidden from UI) ---
let evalRoot: string;

async function createEvalRoot(): Promise<string> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `coding-eval - ${targetMode} - ${new Date().toISOString()}`,
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

type MessageInfo = {
  info: { id: string; role: string; time: { created: number; updated: number } };
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }>;
};

// Wait for the model to finish responding. Handles multi-turn tool use by waiting until
// the last assistant message has stabilized (no new messages and has a text part).
async function promptAndWait(
  sessionID: string,
  text: string,
  options?: { system?: string; agent?: string },
): Promise<string> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: options?.system ? `${options.system}\n\n${text}` : text }],
    model: MODEL,
    agent: options?.agent ?? "lore-distill",
  };
  await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const deadline = Date.now() + MAX_WAIT;
  let stableCount = 0;
  let lastMsgCount = 0;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL);
    const msgs = await fetch(`${BASE_URL}/session/${sessionID}/message`).then(
      (r) => r.json() as Promise<MessageInfo[]>,
    );

    // Check if the response has settled: assistant message with text, not followed by more activity
    const assistants = msgs.filter((m) => m.info.role === "assistant");
    if (assistants.length > 0) {
      const last = assistants[assistants.length - 1];
      const hasText = last.parts.some((p) => p.type === "text" && p.text?.trim());
      const hasPendingTool = last.parts.some(
        (p) => p.type === "tool" && p.state?.status !== "completed",
      );

      // If the last assistant has text and no pending tools, and message count is stable, we're done
      if (hasText && !hasPendingTool) {
        if (msgs.length === lastMsgCount) stableCount++;
        else stableCount = 0;
        // Wait for 2 stable polls to be sure tool results aren't still arriving
        if (stableCount >= 1) {
          const text = last.parts.find((p) => p.type === "text" && p.text?.trim());
          if (text?.text) return text.text.trim();
        }
      }
    }
    lastMsgCount = msgs.length;
  }
  return "[TIMEOUT]";
}

// OpenCode's compaction prompt — same wording used in session/compaction.ts
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

async function compactSession(
  msgs: Array<{ role: string; content: string; created_at: number }>,
): Promise<string> {
  // Chunk messages into segments that fit within context (~80K tokens, rough char/4 estimate).
  // Each chunk is compacted with the prior summary carried forward, mimicking iterative compaction.
  const CHUNK_TOKEN_LIMIT = 80_000;
  const segments: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const m of msgs) {
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

  let summary = "";
  for (let i = 0; i < segments.length; i++) {
    const prior = summary
      ? `Here is a summary of the conversation so far:\n\n${summary}\n\n---\n\nContinuation of the conversation:\n\n`
      : "";
    const prompt = `${prior}${segments[i]}\n\n${COMPACTION_PROMPT}`;
    const sid = await createSession();
    console.log(`    Compacting chunk ${i + 1}/${segments.length}...`);
    summary = await promptAndWait(sid, prompt, { system: COMPACTION_SYSTEM });
  }
  return summary;
}

function buildLore(distillations: Array<{ observations: string }>): string {
  if (!distillations.length)
    return "[No distilled observations available for this session]";
  return distillations
    .map((d, i) => `## Session segment ${i + 1}\n${d.observations}`)
    .join("\n\n");
}

// --- Observer prompt for on-demand distillation ---
const DISTILL_SYSTEM = `You are a memory observer. Your observations will be the ONLY information an AI assistant has about past interactions. Produce a dense, dated event log — not a summary.

CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS
- 🔴 High: user assertions, stated facts, preferences, goals
- 🟡 Medium: questions asked, context, assistant-generated content with full detail
- 🟢 Low: minor conversational context

ASSISTANT-GENERATED CONTENT — THIS IS CRITICAL:
Record EVERY item in lists/recommendations with distinguishing details. Preserve file paths, line numbers, error messages, root causes, specific values.

For technical/coding content:
- Preserve file paths with line numbers
- Preserve error messages and root causes
- Preserve architecture decisions and rationale
- Preserve specific values, thresholds, config details
- Preserve approaches that failed and why

EXACT NUMBERS — NEVER APPROXIMATE:
When the conversation states a specific count, record that EXACT number — do not round, estimate, or substitute a count you see later.
BAD: ~130 test failures
GOOD: 131 test failures (1902 pass, 131 fail, 1 error across 100 files)

BUG FIXES — ALWAYS RECORD:
Every bug fix is important regardless of where it appears. Record the specific bug, root cause, fix applied (with file paths), and outcome.
BAD: Fixed an FTS5 search bug
GOOD: FTS5 was doing exact term matching instead of prefix matching in ltm.ts. Fix: added ftsQuery() that appends * to each term for prefix matching.

Output ONLY an <observations> block with timestamped observations.`;

async function distillOnDemand(
  msgs: Array<{ role: string; content: string; created_at: number }>,
): Promise<string> {
  const segments: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const m of msgs) {
    const est = Math.ceil(m.content.length / 4);
    if (tokens + est > 20000 && current.length > 0) {
      segments.push(current.join("\n\n"));
      current = [];
      tokens = 0;
    }
    const time = new Date(m.created_at);
    const hh = time.getHours().toString().padStart(2, "0");
    const mm = time.getMinutes().toString().padStart(2, "0");
    current.push(`[${m.role}] (${hh}:${mm}) ${m.content}`);
    tokens += est;
  }
  if (current.length) segments.push(current.join("\n\n"));

  const date = msgs[0]
    ? new Date(msgs[0].created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "unknown date";

  let allObservations = "";
  for (const segment of segments) {
    const prior = allObservations
      ? `Previous observations (do NOT repeat):\n${allObservations}\n\n---\n\n`
      : "This is the beginning of the session.\n\n";
    const userMsg = `${prior}Session date: ${date}\n\nConversation to observe:\n\n${segment}\n\nExtract new observations. Output ONLY an <observations> block.`;

    const sid = await createSession();
    const response = await promptAndWait(sid, userMsg, { system: DISTILL_SYSTEM });
    const match = response.match(/<observations>([\s\S]*?)<\/observations>/i);
    const obs = match ? match[1].trim() : response.trim();
    allObservations += (allObservations ? "\n" : "") + obs;
  }
  return allObservations;
}

// --- QA system prompts ---
const QA_SYSTEM = `You are a helpful coding assistant answering questions about past coding sessions. Answer concisely based on the context provided. If the information is not present in the context, say "I don't know."`;

const QA_SYSTEM_WITH_RECALL = `You are a helpful coding assistant answering questions about past coding sessions.

You have two sources of information:
1. Distilled observations provided in the context below
2. A "recall" tool that searches raw message archives and long-term knowledge

IMPORTANT: If the distilled observations don't contain enough detail to answer the question confidently, USE THE RECALL TOOL to search for the specific information. Try different search queries if the first doesn't return useful results.

Answer concisely. If after checking both observations and recall you still can't find the answer, say "I don't know."`;

// --- Process one question ---
async function processQuestion(
  q: Question,
  mode: string,
  loreContext: string,
  msgs: Array<{ role: string; content: string; tokens: number; created_at: number }>
): Promise<{
  question: string;
  answer: string;
  hypothesis: string;
  mode: string;
}> {
  const sid = await createSession();

  if (mode === "lore") {
    // Lore mode: distilled observations as context + recall tool available.
    // Use default agent (not lore-distill) so the recall tool is registered.
    const prompt = `Here are distilled observations from a past coding session:\n\n${loreContext}\n\nQuestion: ${q.question}\n\nAnswer concisely. If the observations don't have enough detail, use the recall tool to search for it.`;
    const hypothesis = await promptAndWait(sid, prompt, {
      system: QA_SYSTEM_WITH_RECALL,
    });
    return { question: q.question, answer: q.answer, hypothesis, mode };
  }

  // Default mode: static tail window of last ~80K tokens (simulating OpenCode's recency-biased context)
  const TAIL_BUDGET = 80_000;
  let tailTokens = 0;
  let cutoff = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    tailTokens += msgs[i].tokens;
    if (tailTokens > TAIL_BUDGET) {
      cutoff = i + 1;
      break;
    }
  }
  const tailContext = msgs.slice(cutoff).map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  const dropped = msgs.length - (msgs.length - cutoff);
  const prefix = dropped > 0 ? `[Note: ${dropped} earlier messages were compacted/lost from context]\n\n` : "";
  const prompt = `Here is context from a past coding session:\n\n${prefix}${tailContext}\n\nQuestion: ${q.question}\n\nAnswer concisely:`;
  const hypothesis = await promptAndWait(sid, prompt, {
    system: QA_SYSTEM,
    agent: "lore-distill",
  });
  return { question: q.question, answer: q.answer, hypothesis, mode };
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
  const response = await promptAndWait(sid, prompt, {
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
  await Promise.all(
    Array.from({ length: Math.min(max, items.length) }, () => worker()),
  );
  return results;
}

// --- Main ---
const questions = (await Bun.file(values.data!).json()) as Question[];
evalRoot = await createEvalRoot();

console.log(`Coding Memory Eval`);
console.log(`Mode: ${targetMode}`);
console.log(`Questions: ${questions.length}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Output: ${values.out}`);
console.log("");

// Pre-load all session data
const sessionCache = new Map<
  string,
  {
    msgs: Array<{
      role: string;
      content: string;
      tokens: number;
      created_at: number;
    }>;
    lore: string;
  }
>();

const sessionIDs = [...new Set(questions.map((q) => q.session_id))];
purgeEvalMessages(sessionIDs);
const needDefault = targetMode === "all" || targetMode === "default";
const needLore = targetMode === "all" || targetMode === "lore";
for (const sid of sessionIDs) {
  console.log(`Loading session ${sid.substring(0, 16)}...`);
  const msgs = getTemporalMessages(sid);
  console.log(
    `  ${msgs.length} messages, ${msgs.reduce((s, m) => s + m.tokens, 0)} tokens`,
  );

  let lore = "";
  if (needLore) {
    const distillations = getDistillations(sid);
    if (
      distillations.length > 0 &&
      distillations.some((d) => d.observations?.trim())
    ) {
      console.log(`  Using ${distillations.length} existing distillation(s)`);
      lore = buildLore(distillations);
    } else {
      console.log(`  No existing distillations — running on-demand observer...`);
      lore = await distillOnDemand(msgs);
    }
    console.log(`  Lore context: ${lore.length} chars`);
  }

  sessionCache.set(sid, { msgs, lore });
}

console.log("");

// Build work items
type WorkItem = { q: Question; mode: string };
const work: WorkItem[] = [];
const modes =
  targetMode === "all" ? ["default", "lore"] : [targetMode];
for (const q of questions) {
  for (const mode of modes) {
    work.push({ q, mode });
  }
}

console.log(
  `Running ${work.length} evaluations (${questions.length} questions × ${modes.length} modes)...`,
);
console.log("");

const startTime = Date.now();
let completed = 0;
const writer = Bun.file(values.out!).writer();

await pool(
  work,
  async ({ q, mode }) => {
    const session = sessionCache.get(q.session_id)!;
    const result = await processQuestion(q, mode, session.lore, session.msgs);
    const label = await judge(q.question, q.answer, result.hypothesis);
    const entry = {
      session_label: q.session_label,
      question_type: q.question_type,
      question: q.question,
      answer: q.answer,
      hypothesis: result.hypothesis,
      mode: result.mode,
      label,
    };
    writer.write(JSON.stringify(entry) + "\n");
    writer.flush();
    completed++;

    const elapsed = (Date.now() - startTime) / 1000;
    const icon = label ? "✓" : "✗";
    console.log(
      `[${completed}/${work.length}] ${icon} ${mode.padEnd(7)} ${q.session_label.padEnd(12)} "${q.question.substring(0, 50)}..."`,
    );
    return entry;
  },
  concurrency,
);

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

if (modes.length > 1) {
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

const elapsed = (Date.now() - startTime) / 1000;
console.log(`\nDone! ${completed} evaluations in ${elapsed.toFixed(1)}s`);
