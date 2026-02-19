import { parseArgs } from "util";

const BASE_URL = "http://localhost:4096";
const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    hyp: { type: "string" },
    ref: { type: "string", default: "eval/data/longmemeval_oracle.json" },
    out: { type: "string" },
    concurrency: { type: "string", default: "10" },
  },
});

if (!values.hyp) {
  console.error("Usage: bun eval/evaluate.ts --hyp <hypothesis.jsonl> --ref <reference.json> [--out <output.jsonl>]");
  process.exit(1);
}

const outFile = values.out ?? values.hyp + ".eval";
const concurrency = parseInt(values.concurrency!, 10);

const hypotheses = (await Bun.file(values.hyp).text()).trim().split("\n").map((l) => JSON.parse(l));
const references = await Bun.file(values.ref!).json();
const refMap = new Map(references.map((r: any) => [r.question_id, r]));

type EvalEntry = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  hypothesis: string;
  label: boolean;
  judge_response: string;
};

function getPrompt(type: string, question: string, answer: string, hypothesis: string, abstention: boolean): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  const templates: Record<string, string> = {
    "single-session-user": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.",
    "single-session-assistant": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.",
    "multi-session": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.",
    "temporal-reasoning": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days.",
    "knowledge-update": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.",
    "single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.",
  };
  const template = templates[type] ?? templates["single-session-user"];
  return `${template}\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
}

async function judge(prompt: string): Promise<string> {
  const session = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((r) => r.json() as Promise<{ id: string }>);

  await fetch(`${BASE_URL}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: prompt }],
      model: MODEL,
      system: "You are a fair judge evaluating model responses. Answer only 'yes' or 'no'.",
    }),
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    const msgs = await fetch(`${BASE_URL}/session/${session.id}/message`).then(
      (r) => r.json() as Promise<Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>>,
    );
    const assistant = msgs.filter((m) => m.info.role === "assistant").at(-1);
    if (assistant) {
      const text = assistant.parts.find((p) => p.type === "text");
      if (text?.text) return text.text.trim();
    }
  }
  return "[TIMEOUT]";
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, max: number): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
  return results;
}

console.log(`Evaluating: ${values.hyp}`);
console.log(`Reference: ${values.ref}`);
console.log(`Output: ${outFile}`);
console.log(`Questions: ${hypotheses.length}, Concurrency: ${concurrency}`);
console.log("");

let completed = 0;
let correct = 0;
const startTime = Date.now();
const writer = Bun.file(outFile).writer();

const results = await pool(
  hypotheses,
  async (hyp: any) => {
    const ref = refMap.get(hyp.question_id) as any;
    if (!ref) return { ...hyp, label: false, judge_response: "MISSING_REF" } as EvalEntry;

    const abstention = hyp.question_id.endsWith("_abs");
    const prompt = getPrompt(ref.question_type, ref.question, ref.answer, hyp.hypothesis, abstention);
    const response = await judge(prompt);
    const label = response.toLowerCase().includes("yes");

    const entry: EvalEntry = {
      question_id: hyp.question_id,
      question_type: ref.question_type,
      question: ref.question,
      answer: ref.answer,
      hypothesis: hyp.hypothesis,
      label,
      judge_response: response,
    };

    writer.write(JSON.stringify(entry) + "\n");
    writer.flush();
    completed++;
    if (label) correct++;

    if (completed % 20 === 0 || completed === hypotheses.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `[${completed}/${hypotheses.length}] ${correct}/${completed} correct (${((correct / completed) * 100).toFixed(1)}%) - ${elapsed.toFixed(0)}s`,
      );
    }

    return entry;
  },
  concurrency,
);

writer.end();

// Print metrics
const byType = new Map<string, { correct: number; total: number }>();
for (const r of results) {
  if (!r) continue;
  const key = r.question_id.endsWith("_abs") ? "abstention" : r.question_type;
  const entry = byType.get(key) ?? { correct: 0, total: 0 };
  entry.total++;
  if (r.label) entry.correct++;
  byType.set(key, entry);
}

console.log("\n=== Results ===");
let totalCorrect = 0;
let totalCount = 0;
for (const [type, { correct, total }] of [...byType.entries()].sort()) {
  console.log(`${type}: ${correct}/${total} (${((correct / total) * 100).toFixed(1)}%)`);
  totalCorrect += correct;
  totalCount += total;
}
console.log(`\nOverall: ${totalCorrect}/${totalCount} (${((totalCorrect / totalCount) * 100).toFixed(1)}%)`);
