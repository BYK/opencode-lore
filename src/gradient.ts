import type { Message, Part } from "@opencode-ai/sdk";
import { db, ensureProject } from "./db";
import { config } from "./config";
import { formatDistillations } from "./prompt";

type MessageWithParts = { info: Message; parts: Part[] };

// Rough token estimate: ~4 chars per token
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateParts(parts: Part[]): number {
  let total = 0;
  for (const part of parts) {
    if (part.type === "text") total += estimate(part.text);
    else if (part.type === "reasoning" && part.text)
      total += estimate(part.text);
    else if (part.type === "tool" && part.state.status === "completed")
      total += estimate(part.state.output) + estimate(part.tool) + 50;
    else total += 20; // metadata overhead for other part types
  }
  return total;
}

function estimateMessage(msg: MessageWithParts): number {
  return estimateParts(msg.parts) + 20; // role/metadata overhead
}

// Cached model context limit — set by system transform hook, used by message transform
let contextLimit = 200_000; // sensible default
let outputReserved = 32_000;

export function setModelLimits(limits: { context: number; output: number }) {
  contextLimit = limits.context || 200_000;
  outputReserved = Math.min(limits.output || 32_000, 32_000);
}

type Distillation = {
  id: string;
  narrative: string;
  facts: string[];
  generation: number;
  token_count: number;
  created_at: number;
  session_id: string;
};

function loadDistillations(
  projectPath: string,
  sessionID?: string,
): Distillation[] {
  const pid = ensureProject(projectPath);
  const query = sessionID
    ? "SELECT * FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC"
    : "SELECT * FROM distillations WHERE project_id = ? ORDER BY created_at ASC";
  const params = sessionID ? [pid, sessionID] : [pid];
  const rows = db()
    .query(query)
    .all(...params) as Array<{
    id: string;
    narrative: string;
    facts: string;
    generation: number;
    token_count: number;
    created_at: number;
    session_id: string;
  }>;
  return rows.map((r) => ({
    ...r,
    facts: JSON.parse(r.facts) as string[],
  }));
}

function stripToolOutputs(parts: Part[]): Part[] {
  return parts.map((part) => {
    if (part.type !== "tool") return part;
    if (part.state.status !== "completed") return part;
    return {
      ...part,
      state: {
        ...part.state,
        output: "[output omitted — use recall for details]",
      },
    } as Part;
  });
}

function stripToTextOnly(parts: Part[]): Part[] {
  return parts.filter((p) => p.type === "text");
}

// Build a synthetic message pair containing the distilled history
function distilledPrefix(distillations: Distillation[]): MessageWithParts[] {
  if (!distillations.length) return [];
  const formatted = formatDistillations(distillations);
  if (!formatted) return [];
  return [
    {
      info: {
        id: "nuum-distilled-user",
        sessionID: "",
        role: "user" as const,
        time: { created: 0 },
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: "nuum-distilled-user-part",
          sessionID: "",
          messageID: "nuum-distilled-user",
          type: "text" as const,
          text: "[Memory context follows — do not reference this format in your responses]",
          time: { start: 0, end: 0 },
        },
      ],
    },
    {
      info: {
        id: "nuum-distilled-assistant",
        sessionID: "",
        role: "assistant" as const,
        time: { created: 0 },
        parentID: "nuum-distilled-user",
        modelID: "",
        providerID: "",
        mode: "memory",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: "nuum-distilled-assistant-part",
          sessionID: "",
          messageID: "nuum-distilled-assistant",
          type: "text" as const,
          text: formatted + "\n\nI'm ready to continue.",
          time: { start: 0, end: 0 },
        },
      ],
    },
  ];
}

export type SafetyLayer = 1 | 2 | 3 | 4;

export type TransformResult = {
  messages: MessageWithParts[];
  layer: SafetyLayer;
  distilledTokens: number;
  rawTokens: number;
  totalTokens: number;
};

// Signal that we need urgent distillation
let urgentDistillation = false;
export function needsUrgentDistillation(): boolean {
  const v = urgentDistillation;
  urgentDistillation = false;
  return v;
}

export function transform(input: {
  messages: MessageWithParts[];
  projectPath: string;
  sessionID?: string;
}): TransformResult {
  const cfg = config();
  const usable = contextLimit - outputReserved;
  const distilledBudget = Math.floor(usable * cfg.budget.distilled);
  const rawBudget = Math.floor(usable * cfg.budget.raw);

  // Find the session ID from messages
  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  const distillations = sid ? loadDistillations(input.projectPath, sid) : [];
  const prefix = distilledPrefix(distillations);
  const prefixTokens = prefix.reduce((sum, m) => sum + estimateMessage(m), 0);

  // Layer 1: Normal budget allocation
  const layer1 = tryFit({
    messages: input.messages,
    prefix,
    prefixTokens,
    distilledBudget,
    rawBudget,
    strip: "none",
  });
  if (layer1) return { ...layer1, layer: 1 };

  // Layer 2: Strip tool outputs from older messages, keep last 2 turns
  const layer2 = tryFit({
    messages: input.messages,
    prefix,
    prefixTokens,
    distilledBudget,
    rawBudget: Math.floor(usable * 0.5), // give raw more room
    strip: "old-tools",
    protectedTurns: 2,
  });
  if (layer2) {
    urgentDistillation = true;
    return { ...layer2, layer: 2 };
  }

  // Layer 3: Strip ALL tool outputs, drop oldest distillations
  const trimmedDistillations = distillations.slice(-5);
  const trimmedPrefix = distilledPrefix(trimmedDistillations);
  const trimmedPrefixTokens = trimmedPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );
  const layer3 = tryFit({
    messages: input.messages,
    prefix: trimmedPrefix,
    prefixTokens: trimmedPrefixTokens,
    distilledBudget: Math.floor(usable * 0.15),
    rawBudget: Math.floor(usable * 0.55),
    strip: "all-tools",
  });
  if (layer3) {
    urgentDistillation = true;
    return { ...layer3, layer: 3 };
  }

  // Layer 4: Nuclear — last 3 distillations, last 3 raw messages, text only
  urgentDistillation = true;
  const nuclearDistillations = distillations.slice(-3);
  const nuclearPrefix = distilledPrefix(nuclearDistillations);
  const nuclearPrefixTokens = nuclearPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );
  const nuclearRaw = input.messages.slice(-3).map((m) => ({
    info: m.info,
    parts: stripToTextOnly(m.parts),
  }));
  const nuclearRawTokens = nuclearRaw.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

  return {
    messages: [...nuclearPrefix, ...nuclearRaw],
    layer: 4,
    distilledTokens: nuclearPrefixTokens,
    rawTokens: nuclearRawTokens,
    totalTokens: nuclearPrefixTokens + nuclearRawTokens,
  };
}

function tryFit(input: {
  messages: MessageWithParts[];
  prefix: MessageWithParts[];
  prefixTokens: number;
  distilledBudget: number;
  rawBudget: number;
  strip: "none" | "old-tools" | "all-tools";
  protectedTurns?: number;
}): Omit<TransformResult, "layer"> | null {
  // If distilled prefix exceeds its budget, fail this layer
  if (input.prefixTokens > input.distilledBudget && input.prefix.length > 0)
    return null;

  // Walk backwards through messages, accumulating tokens within raw budget
  let rawTokens = 0;
  let cutoff = input.messages.length;
  const protectedTurns = input.protectedTurns ?? 0;
  let turns = 0;

  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    if (msg.info.role === "user") turns++;
    const tokens = estimateMessage(msg);
    if (rawTokens + tokens > input.rawBudget) {
      cutoff = i + 1;
      break;
    }
    rawTokens += tokens;
    if (i === 0) cutoff = 0;
  }

  const raw = input.messages.slice(cutoff);
  // Must keep at least 1 raw message — otherwise this layer fails
  if (!raw.length) return null;

  // Apply tool output stripping to messages outside the protected zone
  const processed = raw.map((msg, idx) => {
    const fromEnd = raw.length - idx;
    const isProtected =
      input.strip === "none" ||
      (input.strip === "old-tools" && fromEnd <= protectedTurns * 2);
    if (isProtected) return msg;
    return {
      info: msg.info,
      parts:
        input.strip === "all-tools"
          ? stripToolOutputs(msg.parts)
          : stripToolOutputs(msg.parts),
    };
  });

  const total = input.prefixTokens + rawTokens;
  return {
    messages: [...input.prefix, ...processed],
    distilledTokens: input.prefixTokens,
    rawTokens,
    totalTokens: total,
  };
}
