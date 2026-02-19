import type { Message, Part } from "@opencode-ai/sdk";
import { db, ensureProject } from "./db";
import { config } from "./config";
import { formatDistillations } from "./prompt";
import { normalize } from "./markdown";

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

// Conservative overhead reserve for first-turn (before calibration):
// accounts for provider system prompt + AGENTS.md + tool definitions + env info
const FIRST_TURN_OVERHEAD = 15_000;

// Calibrated overhead: actual tokens used minus our message estimate.
// Null = not yet calibrated (first turn). Updated after every assistant response.
let calibratedOverhead: number | null = null;

export function setModelLimits(limits: { context: number; output: number }) {
  contextLimit = limits.context || 200_000;
  outputReserved = Math.min(limits.output || 32_000, 32_000);
}

// Called after each assistant message completes with real token usage data.
// actualInput = tokens.input + tokens.cache.read (all tokens that went into the model)
// messageEstimate = our chars/4 estimate of the messages we sent
export function calibrate(actualInput: number, messageEstimate: number) {
  const overhead = Math.max(0, actualInput - messageEstimate);
  // Smooth with EMA (alpha=0.3) once calibrated, or set directly on first call
  calibratedOverhead =
    calibratedOverhead === null
      ? overhead
      : Math.round(calibratedOverhead * 0.7 + overhead * 0.3);
}

export function getOverhead(): number {
  return calibratedOverhead ?? FIRST_TURN_OVERHEAD;
}

// For testing only — reset calibration state
export function resetCalibration() {
  calibratedOverhead = null;
}

type Distillation = {
  id: string;
  observations: string;
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
    ? "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC"
    : "SELECT id, observations, generation, token_count, created_at, session_id FROM distillations WHERE project_id = ? ORDER BY created_at ASC";
  const params = sessionID ? [pid, sessionID] : [pid];
  return db()
    .query(query)
    .all(...params) as Distillation[];
}

// Strip all <system-reminder>...</system-reminder> blocks from message text.
// For the user-message wrapper pattern, extracts the actual user text.
// For all other reminders (build-switch, plan reminders, etc.), drops them entirely.
// These tags are added by OpenCode in-memory or persisted as synthetic parts —
// leaving them in the raw window causes the model to echo the format.
function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, (match) => {
      const inner = match.match(
        /The user sent the following message:\n([\s\S]*?)\n\nPlease address/,
      );
      return inner ? inner[1].trim() + "\n" : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanParts(parts: Part[]): Part[] {
  const cleaned = parts.map((part) => {
    if (part.type !== "text") return part;
    const text = stripSystemReminders(part.text);
    if (text === part.text) return part;
    return { ...part, text } as Part;
  });
  // Filter out text parts that became empty after stripping
  const filtered = cleaned.filter(
    (part) =>
      part.type !== "text" ||
      (part as Extract<Part, { type: "text" }>).text.trim().length > 0,
  );
  // If all parts were stripped (e.g. a user message that was purely build-switch synthetic
  // content), keep a minimal placeholder so the message survives toModelMessages.
  // Without this, the message gets dropped and the conversation ends with an assistant message,
  // causing Anthropic's "does not support assistant message prefill" error.
  if (filtered.length === 0 && parts.length > 0) {
    const first = parts[0];
    if (first.type === "text") {
      return [{ ...first, text: "..." } as Part];
    }
  }
  return filtered.length > 0 ? filtered : parts;
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
  const stripped = parts
    .filter((p) => p.type === "text")
    .map((p) => ({
      ...p,
      text: normalize(stripSystemReminders(p.text)),
    }))
    .filter((p) => p.text.trim().length > 0) as Part[];
  // Guard against empty result — keep a placeholder so the message survives
  // toModelMessages and the conversation doesn't end with an assistant message.
  if (stripped.length === 0 && parts.length > 0) {
    const first = parts.find((p) => p.type === "text");
    if (first) return [{ ...first, text: "..." } as Part];
  }
  return stripped;
}

// --- Phase 2: Temporal anchoring at read time ---

function formatRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 60) return "1 month ago";
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`;
}

function parseDateFromContent(s: string): Date | null {
  // "Month Day, Year" e.g. "January 15, 2026"
  const simple = s.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (simple) {
    const d = new Date(`${simple[1]} ${simple[2]}, ${simple[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  // "Month D-D, Year" range — use start
  const range = s.match(/([A-Z][a-z]+)\s+(\d{1,2})-\d{1,2},?\s+(\d{4})/);
  if (range) {
    const d = new Date(`${range[1]} ${range[2]}, ${range[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  // "late/early/mid Month Year"
  const vague = s.match(/(late|early|mid)[- ]?([A-Z][a-z]+)\s+(\d{4})/i);
  if (vague) {
    const day =
      vague[1].toLowerCase() === "early"
        ? 7
        : vague[1].toLowerCase() === "late"
          ? 23
          : 15;
    const d = new Date(`${vague[2]} ${day}, ${vague[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Expand "(meaning DATE)" and "(estimated DATE)" annotations with a relative offset.
// Past future-intent lines get "(likely already happened)" appended.
function expandInlineEstimatedDates(text: string, now: Date): string {
  return text.replace(
    /\(((?:meaning|estimated)\s+)([^)]+\d{4})\)/gi,
    (match, prefix: string, dateContent: string) => {
      const d = parseDateFromContent(dateContent);
      if (!d) return match;
      const rel = formatRelativeTime(d, now);
      // Detect future-intent by looking backwards on the same line
      const matchIdx = text.indexOf(match);
      const lineStart = text.lastIndexOf("\n", matchIdx) + 1;
      const linePrefix = text.slice(lineStart, matchIdx);
      const isFutureIntent =
        /\b(?:will|plans?\s+to|planning\s+to|going\s+to|intends?\s+to)\b/i.test(
          linePrefix,
        );
      if (d < now && isFutureIntent)
        return `(${prefix}${dateContent} — ${rel}, likely already happened)`;
      return `(${prefix}${dateContent} — ${rel})`;
    },
  );
}

// Add relative time annotations to "Date: Month D, Year" section headers
// and gap markers between non-consecutive dates.
function addRelativeTimeToObservations(text: string, now: Date): string {
  // First pass: expand inline "(meaning DATE)" annotations
  const withInline = expandInlineEstimatedDates(text, now);

  // Second pass: annotate date headers and add gap markers
  const dateHeaderRe = /^(Date:\s*)([A-Z][a-z]+ \d{1,2}, \d{4})$/gm;
  const found: Array<{
    index: number;
    date: Date;
    full: string;
    prefix: string;
    ds: string;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = dateHeaderRe.exec(withInline)) !== null) {
    const d = new Date(m[2]);
    if (!isNaN(d.getTime()))
      found.push({
        index: m.index,
        date: d,
        full: m[0],
        prefix: m[1],
        ds: m[2],
      });
  }
  if (!found.length) return withInline;

  let result = "";
  let last = 0;
  for (let i = 0; i < found.length; i++) {
    const curr = found[i];
    const prev = found[i - 1];
    result += withInline.slice(last, curr.index);
    // Gap marker between non-consecutive dates
    if (prev) {
      const gapDays = Math.floor(
        (curr.date.getTime() - prev.date.getTime()) / 86400000,
      );
      if (gapDays > 1) {
        const gap =
          gapDays < 7
            ? `[${gapDays} days later]`
            : gapDays < 14
              ? "[1 week later]"
              : gapDays < 30
                ? `[${Math.floor(gapDays / 7)} weeks later]`
                : gapDays < 60
                  ? "[1 month later]"
                  : `[${Math.floor(gapDays / 30)} months later]`;
        result += `\n${gap}\n\n`;
      }
    }
    result += `${curr.prefix}${curr.ds} (${formatRelativeTime(curr.date, now)})`;
    last = curr.index + curr.full.length;
  }
  result += withInline.slice(last);
  return result;
}

// Build a synthetic message pair containing the distilled history
function distilledPrefix(distillations: Distillation[]): MessageWithParts[] {
  if (!distillations.length) return [];
  const now = new Date();
  const annotated = distillations.map((d) => ({
    ...d,
    observations: addRelativeTimeToObservations(d.observations, now),
  }));
  const formatted = formatDistillations(annotated);
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
  const overhead = getOverhead();
  // Usable = full context minus output reservation minus fixed overhead (system + tools)
  const usable = contextLimit - outputReserved - overhead;
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
    parts: stripToTextOnly(cleanParts(m.parts)),
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

// Compute our message-only estimate for a set of messages (for calibration use)
export function estimateMessages(messages: MessageWithParts[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
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

  // Apply system-reminder stripping + optional tool output stripping
  const processed = raw.map((msg, idx) => {
    const fromEnd = raw.length - idx;
    const isProtected =
      input.strip === "none" ||
      (input.strip === "old-tools" && fromEnd <= protectedTurns * 2);
    const parts = isProtected
      ? cleanParts(msg.parts)
      : cleanParts(
          input.strip === "all-tools"
            ? stripToolOutputs(msg.parts)
            : stripToolOutputs(msg.parts),
        );
    const changed = parts !== msg.parts;
    return changed ? { info: msg.info, parts } : msg;
  });

  const total = input.prefixTokens + rawTokens;
  return {
    messages: [...input.prefix, ...processed],
    distilledTokens: input.prefixTokens,
    rawTokens,
    totalTokens: total,
  };
}
