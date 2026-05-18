/**
 * Eval harness for the Lore eval suite.
 *
 * Manages the lifecycle of eval runs:
 *   1. Start an isolated gateway (fixture mode) or connect to a live one
 *   2. Replay conversation sessions through the gateway
 *   3. Ask eval questions against each baseline
 *   4. Score results with the LLM judge
 *   5. Write JSONL results
 *
 * Two execution modes:
 *   - fixture: deterministic replay via UpstreamInterceptor, no real API calls
 *   - live: real API calls through the gateway, LLM-as-judge scoring
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import type { FixtureEntry } from "../../gateway/src/recorder";
import type {
  EvalConfig,
  EvalResult,
  ScenarioDefinition,
  SessionTranscript,
  ConversationTurn,
  ReplayResult,
  TurnSnapshot,
  BaselineMode,
  TokenUsage,
} from "./types";
import {
  tailWindowBaseline,
  compactionBaseline,
  rawBaseline,
  buildQAPrompt,
  QA_SYSTEM,
  renderConversation,
  estimateTokens,
} from "./baselines";
import { judge } from "./judge";
import type { EvalLLMClient } from "./llm-backend";
import { createEvalLLMClient, resolveBackend } from "./llm-backend";

// ---------------------------------------------------------------------------
// Gateway connection
// ---------------------------------------------------------------------------

export interface GatewayHandle {
  baseURL: string;
  /** Send a conversation turn and return the raw response. */
  chat(
    requestBody: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** Stop the gateway (fixture mode only). */
  teardown?(): Promise<void>;
  /** True if this is a real gateway (not a stub). */
  isReal?: boolean;
}

/**
 * Connect to a running gateway or start an isolated one.
 *
 * In fixture mode, always starts an isolated gateway with replay interceptor.
 * In live mode:
 *   - If --gateway is specified, connect to the external gateway
 *   - Otherwise, auto-start an isolated gateway that forwards to real upstream
 */
export async function connectGateway(
  config: EvalConfig,
): Promise<GatewayHandle> {
  if (config.mode === "fixture") {
    return startFixtureGateway();
  }

  // Live mode with explicit gateway: connect to it
  if (config.gateway) {
    const host = config.gateway.host;
    const port = config.gateway.port;
    const baseURL = `http://${host}:${port}`;

    // Verify the gateway is running
    try {
      const resp = await fetch(`${baseURL}/health`);
      if (!resp.ok) {
        throw new Error(`Gateway health check failed: ${resp.status}`);
      }
    } catch (err) {
      throw new Error(
        `Cannot connect to gateway at ${baseURL}. ` +
          `Start one with 'lore start' or use --mode fixture. ` +
          `Error: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      baseURL,
      async chat(requestBody, headers) {
        return fetch(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY ?? "eval-key",
            "anthropic-version": "2023-06-01",
            ...headers,
          },
          body: JSON.stringify(requestBody),
        });
      },
    };
  }

  // Live mode without explicit gateway: if we have an Anthropic key,
  // start an isolated gateway. Otherwise, skip the gateway entirely —
  // questions will be answered via direct LLM calls without Lore processing.
  if (process.env.ANTHROPIC_API_KEY) {
    return startLiveGateway();
  }

  // No gateway available — return a stub that logs warnings
  console.log(
    "  No ANTHROPIC_API_KEY — skipping gateway (direct LLM evaluation only)",
  );
  return {
    baseURL: "",
    isReal: false,
    async chat() {
      return new Response(
        JSON.stringify({ error: "No gateway available" }),
        { status: 503 },
      );
    },
  };
}

/**
 * Start an isolated gateway with a temp DB for fixture mode.
 * Uses the same infrastructure as gateway integration tests.
 */
async function startFixtureGateway(): Promise<GatewayHandle> {
  // Dynamic import so fixture infra is only loaded when needed
  const { createHarness } = await import(
    "../../gateway/test/helpers/harness"
  );
  const { makeConversationFixtures } = await import(
    "../../gateway/test/helpers/fixtures"
  );

  // Create a minimal fixture set — the replay engine will add its own
  // interceptor per scenario
  const harness = await createHarness({
    fixtures: makeConversationFixtures([
      {
        userMessage: "Hello",
        assistantText: "Hi there! How can I help you?",
      },
    ]),
  });

  return {
    baseURL: harness.baseURL,
    async chat(requestBody, headers) {
      return fetch(`${harness.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "eval-key",
          "anthropic-version": "2023-06-01",
          ...headers,
        },
        body: JSON.stringify(requestBody),
      });
    },
    async teardown() {
      harness.teardown();
    },
  };
}

/**
 * Start an isolated gateway for live mode (no replay interceptor).
 * The gateway forwards to real upstream APIs.
 *
 * Uses the same harness infrastructure but does NOT wire in a replay
 * interceptor, so requests go to the real upstream (Anthropic, OpenAI, etc).
 */
async function startLiveGateway(): Promise<GatewayHandle> {
  const { unlinkSync, existsSync } = await import("node:fs");

  // Create an isolated temp DB
  const dbPath = `/tmp/lore-eval-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;

  // Random port
  const port = 20000 + Math.floor(Math.random() * 30000);
  process.env.LORE_LISTEN_PORT = String(port);

  // Short idle timeout so curation/distillation fires quickly after replay.
  process.env.LORE_IDLE_TIMEOUT = process.env.LORE_IDLE_TIMEOUT ?? "5";
  // Disable batch queue — eval needs synchronous LLM calls for /lore:curate.
  process.env.LORE_BATCH_DISABLED = "1";

  if (!process.env.LORE_DEBUG) {
    process.env.LORE_DEBUG = "false";
  }

  // Dynamic imports so env vars take effect
  const { startServer } = await import("../../gateway/src/server");
  const { loadConfig } = await import("../../gateway/src/config");
  const { close: closeDB } = await import("@loreai/core");
  const { resetPipelineState } = await import("../../gateway/src/pipeline");

  closeDB();
  await resetPipelineState();

  // NO replay interceptor — requests go to real upstream
  const config = loadConfig();
  const server = startServer(config);
  const baseURL = `http://127.0.0.1:${server.port}`;

  console.log(`  Live gateway started at ${baseURL} (db: ${dbPath})`);

  return {
    baseURL,
    async chat(requestBody, headers) {
      return fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "eval-key",
          "anthropic-version": "2023-06-01",
          ...headers,
        },
        body: JSON.stringify(requestBody),
      });
    },
    async teardown() {
      server.stop();
      closeDB();
      await resetPipelineState();
      // Clean up DB files
      for (const suffix of ["", "-shm", "-wal"]) {
        const file = `${dbPath}${suffix}`;
        try {
          if (existsSync(file)) unlinkSync(file);
        } catch {
          // best-effort
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Standard tools (ensures requests pass isMetaRequest check)
// ---------------------------------------------------------------------------

const STANDARD_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

const DEFAULT_SYSTEM =
  "You are a helpful coding assistant. " +
  "You have access to tools to read, write and execute code. " +
  "Always think step by step before responding. " +
  "When in doubt, prefer explicit over implicit. " +
  "Keep your responses concise and to the point. " +
  "This system prompt is intentionally longer than 500 characters to ensure " +
  "the gateway pipeline classifies incoming requests as normal conversation " +
  "turns rather than title or summary requests. " +
  "The Lore memory system is active and will accumulate knowledge across sessions.";

// ---------------------------------------------------------------------------
// Session replay
// ---------------------------------------------------------------------------

/**
 * Build the Anthropic message array from conversation turns.
 * Mimics how real coding tools send the growing conversation history.
 */
function buildMessages(turns: ConversationTurn[]): unknown[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            is_error: part.is_error,
          };
      }
    }),
  }));
}

/**
 * Replay a session transcript through the gateway turn by turn.
 *
 * Sends each turn pair (user + assistant) as a POST /v1/messages with
 * the full message history up to that point — mimicking how real AI
 * coding tools work.
 */
export async function replaySession(
  transcript: SessionTranscript,
  gateway: GatewayHandle,
  options?: {
    stopAfterTurn?: number;
    sessionHeaders?: Record<string, string>;
    model?: string;
  },
): Promise<ReplayResult> {
  const turns = transcript.turns;
  const maxTurn = options?.stopAfterTurn ?? turns.length;
  const model = options?.model ?? "claude-sonnet-4-6";
  const snapshots: TurnSnapshot[] = [];
  let sessionID = "";

  // Build the cumulative message history and send after each assistant turn
  const history: ConversationTurn[] = [];

  for (let i = 0; i < maxTurn && i < turns.length; i++) {
    const turn = turns[i];
    history.push(turn);

    // Only send a request on user turns (the gateway returns the assistant response)
    if (turn.role !== "user") continue;

    // For eval replay: we include the assistant turn from the transcript
    // as part of the history to avoid needing real LLM responses.
    // The next user turn then includes all prior messages.
    // But we still send the request to trigger gateway processing
    // (session tracking, distillation, temporal storage, etc.)
    const messages = buildMessages(history);

    const headers: Record<string, string> = {
      ...(options?.sessionHeaders ?? {}),
    };

    const requestBody = {
      model,
      system: DEFAULT_SYSTEM,
      messages,
      tools: STANDARD_TOOLS,
      max_tokens: 4096,
      stream: false,
    };

    const resp = await gateway.chat(requestBody, headers);
    const data = (await resp.json()) as {
      id?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

    if (data.id && !sessionID) {
      sessionID = data.id;
    }

    snapshots.push({
      turnIndex: i,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    });

    // Add the scripted assistant response to history
    const nextTurn = turns[i + 1];
    if (nextTurn && nextTurn.role === "assistant") {
      history.push(nextTurn);
      i++; // skip the assistant turn in the outer loop
    }
  }

  return {
    sessionID,
    turnsReplayed: history.length,
    totalTokens: history.reduce(
      (sum, t) =>
        sum +
        (t.tokens ??
          estimateTokens(
            t.content.map((p) => ("text" in p ? p.text : "")).join(""),
          )),
      0,
    ),
    turnSnapshots: snapshots,
  };
}

// ---------------------------------------------------------------------------
// Baseline context generation
// ---------------------------------------------------------------------------

async function getBaselineContext(
  mode: BaselineMode,
  turns: ConversationTurn[],
  llm?: EvalLLMClient,
): Promise<string> {
  switch (mode) {
    case "tail-window":
      return tailWindowBaseline(turns);
    case "compaction": {
      if (!llm) return tailWindowBaseline(turns); // fallback in fixture mode
      return compactionBaseline(turns, 80_000, llm);
    }
    case "raw":
      return rawBaseline(turns);
    // Gateway-based baselines (lore, context-only, memory-only) use the
    // gateway's own context management — we don't build a context string.
    // Instead, the question is sent through the gateway which applies
    // its transforms. For eval, we ask the question via the gateway and
    // capture the response directly.
    case "lore":
    case "lore-context-only":
    case "lore-memory-only":
    case "auto-mem0":
      return ""; // handled by gateway or external tool
  }
}

// ---------------------------------------------------------------------------
// Question answering
// ---------------------------------------------------------------------------

/**
 * Ask a question through the gateway so it gets Lore's full processing:
 * LTM injection in the system prompt, recall tool availability, and
 * distilled context. This is how the "lore" baseline is actually tested.
 *
 * Includes retry logic for rate limit errors (Anthropic 429s) and
 * inter-call delays to stay under the 30K tokens/min org limit.
 */
async function askQuestionViaGateway(
  question: string,
  gateway: GatewayHandle,
  model: string,
): Promise<{ hypothesis: string; tokens: TokenUsage }> {
  const requestBody = {
    model,
    system: QA_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Answer this question about our previous coding sessions. Be specific and factual. If you don't have enough information, say so.\n\nQuestion: ${question}`,
      },
    ],
    tools: STANDARD_TOOLS,
    max_tokens: 2048,
    stream: false,
  };

  // Retry with backoff for rate limit errors
  for (let attempt = 0; attempt < 3; attempt++) {
    // Delay between calls to stay under token-per-minute limits.
    // Anthropic's org limit is often 30K-80K tokens/min; each QA call
    // with LTM-injected system prompt can be 8K+ tokens.
    if (attempt > 0) {
      const backoff = 30_000 * Math.pow(2, attempt - 1);
      console.warn(`  Gateway rate limited, retrying in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
    }

    const resp = await gateway.chat(requestBody);
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      error?: { type?: string; message?: string };
    };

    // Check for rate limit in response
    const text =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") ?? "";

    if (
      text.includes("rate limit") ||
      text.includes("exceed") ||
      data.error?.type === "rate_limit_error"
    ) {
      if (attempt < 2) continue; // retry
      // Last attempt — return the error as the hypothesis so the judge scores it low
    }

    return {
      hypothesis: text || data.error?.message || "[No response from gateway]",
      tokens: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
        cacheRead: data.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
        totalCost: 0,
      },
    };
  }

  return {
    hypothesis: "[Gateway rate limit exceeded after retries]",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
  };
}



async function askQuestion(
  question: string,
  context: string,
  mode: BaselineMode,
  llm: EvalLLMClient,
): Promise<{ hypothesis: string; tokens: TokenUsage }> {
  const qaMode = mode.startsWith("lore") ? "lore" : "baseline";
  const prompt = buildQAPrompt(context, question, qaMode);

  const result = await llm.prompt(QA_SYSTEM, prompt, {
    maxTokens: 2048,
    temperature: 0,
  });

  return {
    hypothesis: result.text,
    tokens: {
      input: result.inputTokens,
      output: result.outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0, // computed downstream if pricing available
    },
  };
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

async function writeResult(
  outputPath: string,
  result: EvalResult,
): Promise<void> {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await appendFile(outputPath, JSON.stringify(result) + "\n");
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session recording & replay
// ---------------------------------------------------------------------------

/**
 * Replay a session, optionally recording or replaying upstream responses.
 *
 * - record mode: enables the gateway recorder during replay, saves NDJSON after
 * - replay mode: loads NDJSON fixtures, wires replay interceptor during replay
 * - normal mode: passthrough to replaySession()
 *
 * The interceptor is scoped to replaySession() only — /lore:curate and QA
 * calls happen after the interceptor is cleared, so they use real upstream.
 */
async function replaySessionWithFixtures(
  session: SessionTranscript,
  scenario: ScenarioDefinition,
  gateway: GatewayHandle,
  config: EvalConfig,
): Promise<ReplayResult> {
  const { setUpstreamInterceptor } = await import(
    "../../gateway/src/pipeline"
  );

  if (config.recordDir) {
    // --- RECORD MODE ---
    const { startRecording, stopRecording, getRecordedInterceptor } =
      await import("../../gateway/src/recorder");

    const dir = join(config.recordDir, scenario.id);
    mkdirSync(dir, { recursive: true });
    const fixturePath = join(dir, `${session.id}.ndjson`);

    startRecording(fixturePath);
    const interceptor = getRecordedInterceptor();
    if (interceptor) setUpstreamInterceptor(interceptor);

    try {
      return await replaySession(session, gateway);
    } finally {
      stopRecording();
      setUpstreamInterceptor(undefined);
    }
  }

  if (config.replayDir) {
    // --- REPLAY MODE ---
    const { getReplayInterceptor } = await import(
      "../../gateway/src/recorder"
    );

    const fixturePath = join(
      config.replayDir,
      scenario.id,
      `${session.id}.ndjson`,
    );
    if (!existsSync(fixturePath)) {
      throw new Error(
        `Replay fixture not found: ${fixturePath}\n` +
          `Run with --record ${config.replayDir} first to create fixtures.`,
      );
    }

    const lines = readFileSync(fixturePath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    const fixtures: FixtureEntry[] = lines.map((l) => JSON.parse(l));

    setUpstreamInterceptor(getReplayInterceptor(fixtures));

    try {
      return await replaySession(session, gateway);
    } finally {
      setUpstreamInterceptor(undefined);
    }
  }

  // --- NORMAL MODE ---
  return replaySession(session, gateway);
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

export async function runScenario(
  scenario: ScenarioDefinition,
  config: EvalConfig,
  gateway: GatewayHandle,
  llm?: EvalLLMClient,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  const baselines = config.baselines.filter((b) =>
    scenario.applicableBaselines.includes(b),
  );

  // Setup hook (e.g., seeding cross-project knowledge)
  let cleanup: (() => Promise<void>) | undefined;
  if (scenario.setup) {
    cleanup = await scenario.setup(gateway.baseURL);
  }

  try {
    // Replay sessions through the gateway to build up Lore state.
    // Only attempt replay if we have a real gateway (not a stub).
    // After each session, send /lore:curate to force synchronous
    // distillation + curation before the next session starts.
    if (gateway.isReal !== false) {
      for (const session of scenario.sessions) {
        try {
          await replaySessionWithFixtures(session, scenario, gateway, config);

          // Force synchronous curation via slash command.
          // This ensures knowledge entries are created/updated before
          // the next session starts — critical for preference evolution
          // where Session 2's curation must see Session 1's entries.
          const curateResp = await gateway.chat({
            model: config.model,
            system: "",
            messages: [{ role: "user", content: "/lore:curate" }],
            tools: [],
            max_tokens: 256,
            stream: false,
          });
          const curateData = (await curateResp.json()) as {
            content?: Array<{ text?: string }>;
          };
          const curateText = curateData.content?.[0]?.text ?? "";
          if (curateText) console.log(`  ${curateText}`);
        } catch (err) {
          console.warn(
            `  Warning: replay failed for session ${session.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // Collect all turns across sessions for baseline context building
    const allTurns = scenario.sessions.flatMap((s) => s.turns);

    // Run each baseline — skip gateway-dependent baselines when no gateway
    for (const mode of baselines) {
      // Gateway-based baselines require a real gateway with Lore processing.
      // Without it, distillation/LTM/recall haven't run, so testing "lore"
      // mode would just test an empty memory — not useful.
      if (
        gateway.isReal === false &&
        (mode === "lore" ||
          mode === "lore-context-only" ||
          mode === "lore-memory-only")
      ) {
        console.log(
          `  Skipping baseline '${mode}' — requires gateway (no ANTHROPIC_API_KEY)`,
        );
        continue;
      }

      const context = await getBaselineContext(mode, allTurns, llm);

      // Ask each question
      for (const q of scenario.questions) {
        let hypothesis: string;
        let tokens: TokenUsage;

        if (config.mode === "fixture" || !llm) {
          // Fixture mode: produce a placeholder hypothesis
          hypothesis = `[Fixture mode] Context available: ${context.length > 0 ? "yes" : "no"}`;
          tokens = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalCost: 0,
          };
        } else if (
          gateway.isReal !== false &&
          (mode === "lore" ||
            mode === "lore-context-only" ||
            mode === "lore-memory-only")
        ) {
          // Gateway-based baselines: send the question through the gateway
          // so it gets Lore's LTM injection, recall, and distilled context.
          const answer = await askQuestionViaGateway(
            q.question,
            gateway,
            config.model,
          );
          hypothesis = answer.hypothesis;
          tokens = answer.tokens;
        } else {
          // Non-gateway baselines: ask via direct LLM with rendered context
          const answer = await askQuestion(q.question, context, mode, llm);
          hypothesis = answer.hypothesis;
          tokens = answer.tokens;
        }

        // Score with the judge
        const judgeResult = await judge(q, hypothesis, llm);

        const result: EvalResult = {
          timestamp: new Date().toISOString(),
          dimension: scenario.dimension,
          scenario: scenario.id,
          questionId: q.id,
          mode,
          question: q.question,
          referenceAnswer: q.referenceAnswer,
          hypothesis,
          scores: judgeResult.scores,
          compositeScore: judgeResult.compositeScore,
          judgeReasoning: judgeResult.reasoning,
          tokens,
          metadata: {
            difficulty: q.metadata.difficulty,
            tags: q.metadata.tags,
            turnIndex: q.metadata.turnIndex,
            cumulativeTokens: q.metadata.cumulativeTokens,
          },
        };

        results.push(result);

        // Write result immediately (append)
        await writeResult(config.outputPath, result);
      }
    }
  } finally {
    if (cleanup) await cleanup();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Run all scenarios for selected dimensions
// ---------------------------------------------------------------------------

export async function runEval(config: EvalConfig): Promise<EvalResult[]> {
  const llm =
    config.mode === "live"
      ? createEvalLLMClient(resolveBackend())
      : undefined;

  const gateway = await connectGateway(config);
  const allResults: EvalResult[] = [];

  try {
    // Import scenario modules for selected dimensions, filtered by --scenarios
    let scenarioModules = await loadScenarios(config.dimensions);
    if (config.scenarios?.length) {
      scenarioModules = scenarioModules.filter((s) =>
        config.scenarios!.includes(s.id),
      );
    }

    for (const scenario of scenarioModules) {
      console.log(
        `Running scenario: ${scenario.id} (${scenario.dimension})`,
      );
      const results = await runScenario(scenario, config, gateway, llm);
      allResults.push(...results);
      console.log(
        `  ${results.length} results, avg score: ${avgScore(results)}`,
      );
    }
  } finally {
    if (gateway.teardown) await gateway.teardown();
  }

  return allResults;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function avgScore(results: EvalResult[]): string {
  if (results.length === 0) return "N/A";
  const avg =
    results.reduce((sum, r) => sum + r.compositeScore, 0) / results.length;
  return avg.toFixed(2);
}

async function loadScenarios(
  dimensions: string[],
): Promise<ScenarioDefinition[]> {
  const scenarios: ScenarioDefinition[] = [];

  for (const dim of dimensions) {
    switch (dim) {
      case "context": {
        const mod = await import("./scenarios/context-management");
        scenarios.push(...mod.scenarios);
        break;
      }
      case "recall": {
        const mod = await import("./scenarios/multi-session-recall");
        scenarios.push(...mod.scenarios);
        break;
      }
      case "preferences": {
        const mod = await import("./scenarios/preference-recall");
        scenarios.push(...mod.scenarios);
        break;
      }
      case "cross-project": {
        const mod = await import("./scenarios/cross-project");
        scenarios.push(...mod.scenarios);
        break;
      }
      case "cost": {
        const mod = await import("./scenarios/cost");
        scenarios.push(...mod.scenarios);
        break;
      }
    }
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

export function printSummary(results: EvalResult[]): string {
  const lines: string[] = [
    `Lore Eval Suite Results — ${new Date().toISOString().slice(0, 10)}`,
    "=".repeat(60),
    "",
  ];

  // Group by dimension, then scenario, then mode
  const byDimension = new Map<string, EvalResult[]>();
  for (const r of results) {
    const key = r.dimension;
    if (!byDimension.has(key)) byDimension.set(key, []);
    byDimension.get(key)!.push(r);
  }

  const dimensionLabels: Record<string, string> = {
    context: "Dimension 1: Context Management",
    recall: "Dimension 2: Multi-Session Recall",
    preferences: "Dimension 3: Preference Recall",
    "cross-project": "Dimension 4: Cross-Project Learning",
    cost: "Dimension 5: Cost",
  };

  for (const [dim, dimResults] of byDimension) {
    lines.push(dimensionLabels[dim] ?? dim);

    // Group by scenario
    const byScenario = new Map<string, EvalResult[]>();
    for (const r of dimResults) {
      if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
      byScenario.get(r.scenario)!.push(r);
    }

    for (const [scenario, scenResults] of byScenario) {
      // Group by mode
      const byMode = new Map<string, EvalResult[]>();
      for (const r of scenResults) {
        if (!byMode.has(r.mode)) byMode.set(r.mode, []);
        byMode.get(r.mode)!.push(r);
      }

      const parts: string[] = [];
      for (const [mode, modeResults] of byMode) {
        const avg =
          modeResults.reduce((s, r) => s + r.compositeScore, 0) /
          modeResults.length;
        parts.push(`${mode} ${avg.toFixed(1)}`);
      }

      lines.push(`  ${scenario}:  ${parts.join("  |  ")}`);
    }

    lines.push("");
  }

  const summary = lines.join("\n");
  console.log(summary);
  return summary;
}
