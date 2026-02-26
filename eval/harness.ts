import { parseArgs } from "util";
import { mkdirSync } from "fs";
import { DISTILLATION_SYSTEM, distillationUser } from "../src/prompt";

// --- Config ---
const BASE_URL = "http://localhost:4096";
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
const POLL_INTERVAL = 2000;
const MAX_WAIT = 120000;

// --- CLI args ---
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string", default: "eval/data/longmemeval_oracle.json" },
    out: { type: "string", default: "eval/results/baseline_oracle.jsonl" },
    limit: { type: "string", default: "0" },
    offset: { type: "string", default: "0" },
    concurrency: { type: "string", default: "5" },
    mode: { type: "string", default: "baseline" }, // "baseline" or "lore"
  },
});

const limit = parseInt(values.limit!, 10);
const offset = parseInt(values.offset!, 10);
const concurrency = parseInt(values.concurrency!, 10);
const mode = values.mode!;

// --- Types ---
type Turn = {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
};
type Question = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
  haystack_dates: string[];
};

// --- Load data ---
const raw = await Bun.file(values.data!).json();
const questions = (
  limit > 0 ? raw.slice(offset, offset + limit) : raw.slice(offset)
) as Question[];

// --- API helpers ---

// All eval sessions are created as children of this root so they don't
// pollute the session history visible in the UI.
let evalRoot: string;

async function createEvalRoot(): Promise<string> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `eval run - ${mode} - ${new Date().toISOString()}`,
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
  await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      model: MODEL,
      ...(system ? { system } : {}),
    }),
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
    // Find assistant messages (there may be multiple from multi-step)
    const assistants = msgs.filter((m) => m.info.role === "assistant");
    if (assistants.length > 0) {
      const last = assistants[assistants.length - 1];
      const text = last.parts.find((p) => p.type === "text");
      if (text?.text) return text.text.trim();
    }
  }
  return "[TIMEOUT]";
}

// --- Format history for baseline ---
function formatHistory(q: Question): string {
  const parts: string[] = [];
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const date = q.haystack_dates?.[i] ?? "unknown date";
    parts.push(`=== Session (${date}) ===`);
    for (const turn of q.haystack_sessions[i]) {
      parts.push(`[${turn.role}]: ${turn.content}`);
    }
  }
  return parts.join("\n");
}

type Distillation = { observations: string };

function parseDistillation(text: string): Distillation | null {
  const match = text.match(/<observations>([\s\S]*?)<\/observations>/i);
  const observations = match ? match[1].trim() : text.trim();
  if (!observations) return null;
  return { observations };
}

function formatDistillations(distillations: Distillation[]): string {
  return distillations
    .map((d, i) => `## Session ${i + 1}\n${d.observations}`)
    .join("\n\n");
}

// Phase 2: Add relative time annotations to date headers at read time
function formatRelativeTime(date: Date, now: Date): string {
  const days = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "1 month ago";
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function addRelativeTime(observations: string, questionDate: string): string {
  const now = new Date(questionDate);
  if (isNaN(now.getTime())) return observations;
  return observations.replace(
    /^(Date:\s*)([A-Z][a-z]+ \d{1,2}, \d{4})$/gm,
    (_, prefix: string, ds: string) => {
      const d = new Date(ds);
      if (isNaN(d.getTime())) return _;
      return `${prefix}${ds} (${formatRelativeTime(d, now)})`;
    },
  );
}

// --- System prompts ---
const BASELINE_SYSTEM = `You are a helpful assistant answering questions about past conversations.
You will be given a chat history from previous sessions, then asked a question about it.
Answer concisely and directly. If the information is not in the history, say "I don't know."
Do NOT use any tools. Just answer the question based on the provided history.`;

const NUUM_QA_SYSTEM = `You are a helpful assistant answering questions about past conversations.
You will be given distilled summaries of previous sessions, then asked a question.
Answer concisely and directly based on the distilled information.
If the information is not available in the summaries, say "I don't know."
Do NOT use any tools. Just answer the question.`;

// --- Process one question (baseline) ---
async function processBaseline(
  q: Question,
): Promise<{ question_id: string; hypothesis: string }> {
  const history = formatHistory(q);
  const prompt = `Here is the chat history from previous conversations:\n\n${history}\n\nToday's date: ${q.question_date}\n\nQuestion: ${q.question}\n\nAnswer concisely:`;

  const sid = await createSession();
  const hypothesis = await promptAndWait(sid, prompt, BASELINE_SYSTEM);
  return { question_id: q.question_id, hypothesis };
}

// --- Process one question (lore observation mode) ---
async function processLore(
  q: Question,
): Promise<{ question_id: string; hypothesis: string }> {
  // Step 1: Observe each session
  const distillations: Distillation[] = [];
  let priorObservations: string | undefined;

  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const session = q.haystack_sessions[i];
    const date = q.haystack_dates?.[i] ?? "unknown date";
    const messages = session.map((t) => `[${t.role}]: ${t.content}`).join("\n\n");
    const prompt = distillationUser({ date, messages, priorObservations });

    const sid = await createSession();
    const response = await promptAndWait(sid, prompt, DISTILLATION_SYSTEM);
    const parsed = parseDistillation(response);

    if (parsed) {
      distillations.push(parsed);
      priorObservations = parsed.observations;
    }
  }

  // Step 2: Ask the question with temporal-annotated observation context
  const rawContext = formatDistillations(distillations);
  const context = addRelativeTime(rawContext, q.question_date);
  const prompt = `Here are memory observations from previous conversations:\n\n${context}\n\nToday's date: ${q.question_date}\n\nQuestion: ${q.question}\n\nAnswer concisely based on the observations. If the information is not present, say "I don't know."`;

  const sid = await createSession();
  const hypothesis = await promptAndWait(sid, prompt, NUUM_QA_SYSTEM);
  return { question_id: q.question_id, hypothesis };
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
const outDir = values.out!.split("/").slice(0, -1).join("/");
if (outDir) mkdirSync(outDir, { recursive: true });

evalRoot = await createEvalRoot();

console.log(`Mode: ${mode}`);
console.log(`Model: ${MODEL.modelID}`);
console.log(`Questions: ${questions.length} (offset=${offset})`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Output: ${values.out}`);
console.log("");

let completed = 0;
const startTime = Date.now();
const writer = Bun.file(values.out!).writer();

const processFn = mode === "lore" ? processLore : processBaseline;

await pool(
  questions,
  async (q) => {
    const result = await processFn(q);
    writer.write(JSON.stringify(result) + "\n");
    writer.flush();
    completed++;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = completed / elapsed;
    const eta = (questions.length - completed) / rate;
    console.log(
      `[${completed}/${questions.length}] ${q.question_id} (${q.question_type}) answer="${result.hypothesis.substring(0, 60)}" - ${elapsed.toFixed(0)}s, ~${eta.toFixed(0)}s left`,
    );

    return result;
  },
  concurrency,
);

writer.end();

const elapsed = (Date.now() - startTime) / 1000;
console.log(`\nDone! ${completed} questions in ${elapsed.toFixed(1)}s`);
console.log(`Output: ${values.out}`);
