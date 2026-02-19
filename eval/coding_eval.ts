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
    mode: { type: "string", default: "all" }, // "oracle", "default", "nuum", or "all"
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
  `${process.env.HOME}/.local/share/opencode-nuum/nuum.db`;

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
  // Get the project_id for this session
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

async function promptAndWait(
  sessionID: string,
  text: string,
  system?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: system ? `${system}\n\n${text}` : text }],
    model: MODEL,
    agent: "nuum-distill",
  };
  await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const deadline = Date.now() + MAX_WAIT;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL);
    const msgs = await fetch(`${BASE_URL}/session/${sessionID}/message`).then(
      (r) =>
        r.json() as Promise<
          Array<{
            info: { role: string };
            parts: Array<{ type: string; text?: string }>;
          }>
        >,
    );
    const assistants = msgs.filter((m) => m.info.role === "assistant");
    if (assistants.length > 0) {
      const last = assistants[assistants.length - 1];
      const text = last.parts.find((p) => p.type === "text");
      if (text?.text) return text.text.trim();
    }
  }
  return "[TIMEOUT]";
}

// --- Context builders ---
function buildOracle(msgs: Array<{ role: string; content: string }>): string {
  return msgs.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
}

function buildDefault(
  msgs: Array<{ role: string; content: string; tokens: number }>,
  budget: number = 80000,
): string {
  // Take the last N messages that fit in budget (simulating default OpenCode context window)
  let total = 0;
  let cutoff = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i].tokens;
    if (total > budget) {
      cutoff = i + 1;
      break;
    }
  }
  const kept = msgs.slice(cutoff);
  const dropped = msgs.length - kept.length;
  const prefix =
    dropped > 0
      ? `[Note: ${dropped} earlier messages were compacted/lost from context]\n\n`
      : "";
  return prefix + kept.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
}

function buildNuum(distillations: Array<{ observations: string }>): string {
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

Output ONLY an <observations> block with timestamped observations.`;

async function distillOnDemand(
  msgs: Array<{ role: string; content: string; created_at: number }>,
): Promise<string> {
  // Chunk messages into segments of ~20k tokens to fit observer context
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
    const response = await promptAndWait(sid, userMsg, DISTILL_SYSTEM);
    const match = response.match(/<observations>([\s\S]*?)<\/observations>/i);
    const obs = match ? match[1].trim() : response.trim();
    allObservations += (allObservations ? "\n" : "") + obs;
  }
  return allObservations;
}

// --- QA system prompt ---
const QA_SYSTEM = `You are a helpful coding assistant answering questions about past coding sessions. Answer concisely based on the context provided. If the information is not present in the context, say "I don't know."`;

// --- Process one question ---
async function processQuestion(
  q: Question,
  mode: string,
  msgs: Array<{
    role: string;
    content: string;
    tokens: number;
    created_at: number;
  }>,
  nuumContext: string,
): Promise<{
  question: string;
  answer: string;
  hypothesis: string;
  mode: string;
}> {
  let context: string;
  switch (mode) {
    case "oracle":
      context = buildOracle(msgs);
      break;
    case "default":
      context = buildDefault(msgs);
      break;
    case "nuum":
      context = nuumContext;
      break;
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  const prompt = `Here is context from a previous coding session:\n\n${context}\n\nQuestion: ${q.question}\n\nAnswer concisely:`;
  const sid = await createSession();
  const hypothesis = await promptAndWait(sid, prompt, QA_SYSTEM);
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
  const response = await promptAndWait(sid, prompt, JUDGE_SYSTEM);
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
    nuum: string;
  }
>();

const sessionIDs = [...new Set(questions.map((q) => q.session_id))];
for (const sid of sessionIDs) {
  console.log(`Loading session ${sid.substring(0, 16)}...`);
  const msgs = getTemporalMessages(sid);
  console.log(
    `  ${msgs.length} messages, ${msgs.reduce((s, m) => s + m.tokens, 0)} tokens`,
  );

  // Check for existing distillations
  const distillations = getDistillations(sid);
  let nuum: string;
  if (
    distillations.length > 0 &&
    distillations.some((d) => d.observations?.trim())
  ) {
    console.log(`  Using ${distillations.length} existing distillation(s)`);
    nuum = buildNuum(distillations);
  } else {
    console.log(`  No existing distillations — running on-demand observer...`);
    nuum = await distillOnDemand(msgs);
  }
  console.log(`  Nuum context: ${nuum.length} chars`);
  sessionCache.set(sid, { msgs, nuum });
}

console.log("");

// Build work items
type WorkItem = { q: Question; mode: string };
const work: WorkItem[] = [];
const modes =
  targetMode === "all" ? ["oracle", "default", "nuum"] : [targetMode];
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
    const result = await processQuestion(q, mode, session.msgs, session.nuum);
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
  .map((l) => JSON.parse(l));

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
