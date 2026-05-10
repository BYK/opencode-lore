import type { Plugin, Hooks } from "@opencode-ai/plugin";
import type { LoreMessageWithParts } from "@loreai/core";
import { join } from "path";
import {
  load,
  config,
  ensureProject,
  isFirstRun,
  temporal,
  ltm,
  distillation,
  curator,
  transform,
  setModelLimits,
  setMaxLayer0Tokens,
  computeLayer0Cap,
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
  onIdleResume,
  getLastTurnAt,
  consumeCameOutOfIdle,
  formatKnowledge,
  formatDistillations,
  buildCompactPrompt,
  shouldImport,
  importFromFile,
  exportToFile,
  exportLoreFile,
  importLoreFile,
  shouldImportLoreFile,
  loreFileExists,
  latReader,
  embedding,
  log,
  isWorkerSession,
  workerModel,
} from "@loreai/core";
// Recall tool registration moved to gateway layer — see packages/gateway/src/recall.ts
// import { createRecallTool } from "./reflect";
import { createOpenCodeLLMClient } from "./llm-adapter";

// Mirrors upstream OpenCode's OVERFLOW_PATTERNS at
// packages/opencode/src/provider/error.ts (commit be20f865a added the HTTP 413
// regex; list otherwise tracks upstream's provider coverage). Keep this list
// aligned with upstream when they add / change patterns — diff the arrays to
// catch drift.
// Drift detection: packages/opencode/test/upstream-contract.test.ts reads
// upstream's source file (when present) and asserts OVERFLOW_PATTERNS is
// still consistent. Fails loudly on the dev machine during dep bumps.
const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /input token count.*exceeds the maximum/i, // Google Gemini
  /maximum prompt length is \d+/i, // xAI Grok
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi / Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413 (added upstream be20f865a)
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai
  /^4(00|13)\s*(status code)?\s*\(no body\)/i, // Cerebras, Mistral no-body responses
];

// Patterns retained from Lore's historic detector that upstream doesn't
// include. Kept for safety since the previous substring-based detector used
// them. Remove only after (a) a user-report window goes quiet and (b) we've
// confirmed the specific provider wordings they catch are covered by
// OVERFLOW_PATTERNS above. Lore has no hit telemetry for these today.
const LORE_LEGACY_PATTERNS: RegExp[] = [
  /ContextWindowExceededError/i, // surfaces in some wrapped error messages
  /too many tokens/i, // broad; catches non-standard wordings
];

/**
 * Detect context overflow from session.error payloads.
 *
 * Upstream ships errors to plugins via `namedSchemaError(...).toObject()`, so
 * we receive one of these wire shapes:
 *   - ContextOverflowError: { name: "ContextOverflowError", data: { message, responseBody? } }
 *   - APIError:             { name: "APIError", data: { message, statusCode?, isRetryable?, ... } }
 *   - Unknown:              { name: "Unknown", data: { message? } }
 *
 * Detection strategy (ordered, fail-open):
 *   1. Structural tag: `error.name === "ContextOverflowError"` — upstream already
 *      classified it as overflow.
 *   2. HTTP 413 on APIError: `data.statusCode === 413` — belt-and-suspenders for
 *      cases where upstream's `parseAPICallError` didn't fire (e.g. if the error
 *      reached Lore before passing through `provider/error.ts`).
 *   3. Regex match on `data.message` / `message` — mirrors upstream's
 *      OVERFLOW_PATTERNS list for all provider wordings + legacy Lore patterns
 *      for defensive coverage.
 *
 * When upstream revises OVERFLOW_PATTERNS, re-sync here. See
 * `.opencode/plans/f8-context-overflow-detection-audit.md` for rationale and
 * the ground-truth reference report.
 */
export function isContextOverflow(rawError: unknown): boolean {
  if (!rawError || typeof rawError !== "object") return false;

  const error = rawError as {
    name?: string;
    message?: string;
    data?: {
      message?: string;
      statusCode?: number;
    };
  };

  // 1. Structural tag — upstream's already-classified overflow. Covers both
  //    API-level overflow and OpenCode's compaction overflow ("Conversation
  //    history too large to compact...").
  if (error.name === "ContextOverflowError") return true;

  // 2. HTTP 413 on APIError-shaped payloads. ContextOverflowError strips
  //    statusCode in .toObject(), so this only matches non-classified leaks.
  if (error.data?.statusCode === 413) return true;

  // 3. Regex against message text (data.message preferred, top-level message
  //    as fallback — the latter is dropped for named errors but may be
  //    present for raw Error instances that somehow reach us).
  const text = error.data?.message ?? error.message ?? "";
  if (typeof text !== "string" || text.length === 0) return false;

  if (OVERFLOW_PATTERNS.some((re) => re.test(text))) return true;
  if (LORE_LEGACY_PATTERNS.some((re) => re.test(text))) return true;

  return false;
}

/**
 * Build the synthetic recovery message injected after a context overflow.
 * Contains the distilled session history so the model can continue.
 *
 * For overflow paths where the failing user message contained media
 * attachments (image/PDF), prefer `buildMediaAwareRecoveryMessage` —
 * it preserves the user's text question and lists the dropped
 * attachments so the model can acknowledge them.
 */
export function buildRecoveryMessage(
  summaries: Array<{ observations: string; generation: number }>,
): string {
  const historyText = summaries.length > 0
    ? formatDistillations(summaries)
    : "";

  return [
    "<system-reminder>",
    "The previous turn failed with a context overflow error (prompt too long).",
    "Lore has automatically compressed the conversation history.",
    "Review the session history below and continue where you left off.",
    "",
    historyText || "(No distilled history available — check recent messages for context.)",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Match upstream OpenCode's `isMedia` (`util/media.ts:7-9`) byte-for-byte:
 * `mime.startsWith("image/") || mime === "application/pdf"`. Used to
 * decide whether a file part qualifies as a "stripped attachment" worth
 * surfacing in the media-aware recovery message.
 */
export function isMediaMime(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf";
}

/**
 * Extract a "stripped attachment" descriptor from a `file` part, mirroring
 * upstream OpenCode's replay stub at `compaction.ts:494` byte-for-byte:
 * `[Attached <mime>: <filename or "file">]`. Returns undefined when the
 * part isn't a media file part (so the caller can ignore it).
 *
 * Defensive: tolerates missing or non-string `mime`/`filename` fields
 * since `LoreGenericPart` doesn't constrain shape.
 */
export function stripMediaPart(
  part: { type?: unknown } & Record<string, unknown>,
): string | undefined {
  if (part.type !== "file") return undefined;
  const mime = typeof part.mime === "string" ? part.mime : undefined;
  if (!mime || !isMediaMime(mime)) return undefined;
  const filename = typeof part.filename === "string" ? part.filename : "file";
  return `[Attached ${mime}: ${filename}]`;
}

// Minimal interface of the OpenCode client surface F9 reads. Typed
// loosely so tests can stub it without satisfying the full SDK shape.
// Array elements are `unknown` because the SDK's element type is
// non-null but real-world tests can pass nulls/malformed entries to
// exercise the defensive shape-checks in `getLastRealUserMessage`.
type SessionMessagesClient = {
  session: {
    messages: (opts: { path: { id: string } }) => Promise<{
      data?: ReadonlyArray<unknown>;
    }>;
  };
};

/**
 * Walk session messages newest-first to find the most recent user message
 * that is NOT a Lore-injected synthetic recovery (i.e. its parts do not
 * contain a text part with `synthetic: true`). Returns undefined when no
 * real user message exists or the SDK call fails — the caller falls
 * through to plain `buildRecoveryMessage` in either case.
 *
 * Uses `client.session.messages` (route `/session/{id}/message`,
 * confirmed in `@opencode-ai/sdk` `sdk.gen.d.ts:170`). The endpoint
 * returns all messages by default; F9 doesn't pass `limit` because
 * recovery is not a hot path.
 */
export async function getLastRealUserMessage(
  client: SessionMessagesClient,
  sessionID: string,
): Promise<
  | { info: { role: string } & Record<string, unknown>; parts: Array<Record<string, unknown>> }
  | undefined
> {
  let resp;
  try {
    resp = await client.session.messages({ path: { id: sessionID } });
  } catch (e) {
    log.warn(`getLastRealUserMessage: session.messages failed for ${sessionID.substring(0, 16)}:`, e);
    return undefined;
  }
  const msgs = resp?.data ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const raw = msgs[i];
    if (!raw || typeof raw !== "object") continue;
    const m = raw as { info?: unknown; parts?: unknown };
    const info = m.info;
    if (!info || typeof info !== "object") continue;
    if ((info as { role?: unknown }).role !== "user") continue;
    const partsRaw = m.parts;
    const parts: Array<Record<string, unknown>> = Array.isArray(partsRaw)
      ? (partsRaw as Array<Record<string, unknown>>)
      : [];
    const isSynthetic = parts.some(
      (p) => p && typeof p === "object" && p.type === "text" && p.synthetic === true,
    );
    if (isSynthetic) continue;
    return {
      info: info as { role: string } & Record<string, unknown>,
      parts,
    };
  }
  return undefined;
}

/**
 * Walk session messages newest-first to find the most recent prior `/compact`
 * summary text. The compaction agent (upstream `compaction.ts:410-435`) emits
 * an assistant message in the same session with `info.summary === true` and
 * `info.mode === "compaction"` — this helper recovers the joined text-part
 * content so the next `/compact` can anchor on it.
 *
 * Returns the joined text of the matched assistant message, or `undefined`
 * when no prior summary exists or the SDK call fails. The caller falls
 * through to non-anchored compaction in either case (byte-identical to the
 * pre-F1b behavior).
 *
 * Approximates upstream's `completedCompactions` detection at
 * `compaction.ts:104-118`. Upstream additionally checks `info.finish &&
 * !info.error` and that the parent user message contains a `compaction` part;
 * Lore relies on the upstream invariant that `summary` is only set on
 * successfully completed compaction-agent assistant messages so the simpler
 * `summary` check is sufficient in practice. Text-part assembly mirrors
 * upstream's `summaryText` (`compaction.ts:93-101`): per-part trim, drop
 * empties, join with paragraph breaks.
 */
export async function findPreviousCompactSummary(
  client: SessionMessagesClient,
  sessionID: string,
): Promise<string | undefined> {
  let resp;
  try {
    resp = await client.session.messages({ path: { id: sessionID } });
  } catch (e) {
    log.warn(`findPreviousCompactSummary: session.messages failed for ${sessionID.substring(0, 16)}:`, e);
    return undefined;
  }
  const msgs = resp?.data ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const raw = msgs[i];
    if (!raw || typeof raw !== "object") continue;
    const m = raw as { info?: unknown; parts?: unknown };
    const info = m.info;
    if (!info || typeof info !== "object") continue;
    if ((info as { role?: unknown }).role !== "assistant") continue;
    // Truthy check (matches upstream: `!msg.info.summary` rejects falsy).
    // Production data only ever sets the flag to literal `true`; the looser
    // check still rejects undefined / false / null / 0 / "" without
    // false-positive matching string-typed truthy values from a
    // hypothetical malformed SDK response.
    if (!(info as { summary?: unknown }).summary) continue;
    const partsRaw = m.parts;
    const parts: Array<Record<string, unknown>> = Array.isArray(partsRaw)
      ? (partsRaw as Array<Record<string, unknown>>)
      : [];
    const text = parts
      .filter(
        (p) =>
          p && typeof p === "object" && p.type === "text" && typeof p.text === "string",
      )
      .map((p) => (p.text as string).trim())
      .filter((s) => s.length > 0)
      .join("\n\n");
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Build a media-aware recovery message that extends the plain version with
 * (a) a list of stripped attachments and (b) the user's original text from
 * the failed turn. The plain `buildRecoveryMessage` should be preferred
 * when no attachments were stripped — see the `session.error` handler.
 *
 * Sections (in order, with empty ones omitted):
 *   - opening "previous turn failed" preamble
 *   - stripped-attachments notice (only when present)
 *   - distilled history block (or empty-history fallback)
 *   - user's original text question (only when present)
 *   - closing "review and continue" instruction
 */
export function buildMediaAwareRecoveryMessage(input: {
  summaries: Array<{ observations: string; generation: number }>;
  strippedAttachments: string[];
  userText: string[];
}): string {
  const historyText =
    input.summaries.length > 0 ? formatDistillations(input.summaries) : "";

  const mediaNotice =
    input.strippedAttachments.length > 0
      ? [
          "",
          `The user's previous message included ${input.strippedAttachments.length} attachment(s) that were removed because they exceeded the context limit:`,
          ...input.strippedAttachments.map((s) => `- ${s}`),
          "If the user was asking about the attachments, acknowledge that they were too large to process and suggest smaller or fewer files.",
          "",
        ].join("\n")
      : "";

  const userQuestion =
    input.userText.length > 0
      ? [
          "",
          "The user's original question (with attachments removed):",
          ...input.userText,
          "",
        ].join("\n")
      : "";

  return [
    "<system-reminder>",
    "The previous turn failed with a context overflow error (prompt too long).",
    "Lore has automatically compressed the conversation history.",
    mediaNotice,
    historyText || "(No distilled history available — check recent messages for context.)",
    userQuestion,
    "Review the above and continue where you left off.",
    "</system-reminder>",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Check whether a project path is valid for file operations (e.g. AGENTS.md export/import).
 * Returns false for root ("/"), empty, or falsy paths to prevent writing to the filesystem root.
 */
export function isValidProjectPath(p: string): boolean {
  return !!p && p !== "/";
}

/** Providers the plugin will redirect through the gateway when it's running. */
const GATEWAY_PROVIDERS: string[] = [
  "anthropic",
  "openai",
  "nvidia",
  "xai",
  "mistral",
  "google",
];

/** Absolute path to the gateway entry point (src/index.ts in the workspace). */
const GATEWAY_ENTRY = new URL("../../gateway/src/index.ts", import.meta.url).pathname;

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay OpenCode startup noticeably.
 */
async function probeGateway(baseURL: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the gateway as a background child process and wait for it to be ready.
 * Returns true if the gateway started and is healthy, false otherwise.
 */
async function spawnGateway(gatewayBase: string): Promise<boolean> {
  try {
    const child = Bun.spawn(["bun", "run", GATEWAY_ENTRY], {
      stdout: "ignore",
      stderr: "pipe",
      // Detach from the plugin process group so it keeps running
      // even if the parent signal handler fires.
    });

    // Pipe gateway stderr to our own stderr with a prefix so it's visible.
    if (child.stderr) {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(decoder.decode(value));
        }
      };
      pump().catch(() => {});
    }

    // Poll until healthy or timeout (5s max, 100ms intervals).
    for (let i = 0; i < 50; i += 1) {
      await Bun.sleep(100);
      if (await probeGateway(gatewayBase, 500)) return true;
    }

    log.info("gateway did not become healthy within 5s, falling back to plugin mode");
    child.kill();
    return false;
  } catch (e) {
    log.info("failed to spawn gateway:", e instanceof Error ? e.message : String(e));
    return false;
  }
}


// Process-wide initialization state — shared across all sessions.
// The plugin function is called once per OpenCode session/project, but
// gateway detection, embedding backfill, and verbose startup logs only
// need to run once per process.
let processInitDone = false;
let processGatewayActive = false;
let processGatewayBase = "";

/** Memoized gateway init promise — ensures concurrent plugin calls don't race. */
let gatewayInitPromise: Promise<boolean> | null = null;

export const LorePlugin: Plugin = async (ctx) => {
  // Resolve the gateway base URL — explicit env var or default.
  const gatewayBase =
    (process.env.LORE_GATEWAY_URL ?? "http://127.0.0.1:6969").replace(/\/$/, "");

  // Determine if the gateway is active — only probe once per process.
  let gatewayActive = processGatewayActive;
  if (!processInitDone) {
    const inTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.LORE_GATEWAY_MODE === "test" ||
      process.argv.some((a) => a.includes(".test."));

    if (process.env.LORE_GATEWAY_MODE !== "0" && !inTestEnv) {
      // Memoize so concurrent LorePlugin calls don't race on probe→spawn.
      if (!gatewayInitPromise) {
        gatewayInitPromise = (async () => {
          if (await probeGateway(gatewayBase)) {
            log.info(`gateway detected at ${gatewayBase}`);
            return true;
          }
          log.info(`starting gateway at ${gatewayBase}…`);
          if (await spawnGateway(gatewayBase)) {
            log.info(`gateway started at ${gatewayBase}`);
            return true;
          }
          log.info("gateway unavailable, running in plugin mode");
          return false;
        })();
      }
      gatewayActive = await gatewayInitPromise;
    }
    processGatewayActive = gatewayActive;
    processGatewayBase = gatewayBase;
  }

  const projectPath = ctx.worktree || ctx.directory;

  // Per-session LTM cache — reuse exact formatted bytes across turns to
  // preserve the system prompt prefix for Anthropic's prompt caching.
  // Without this, forSession() re-scores entries every turn (session context
  // changes → different terms → different entries → system prompt bytes change
  // at position 0 → total cache invalidation). Cleared when knowledge
  // mutations occur (curation, consolidation, pruning, import).
  //
  // Declared up-front before any code path that calls invalidateLtmCache()
  // — startup AGENTS.md import, pruneOversized, etc. all fire before the
  // hooks are registered, and a TDZ reference would fail the whole plugin.
  const ltmSessionCache = new Map<string, { formatted: string; tokenCount: number }>();

  /**
   * Pinned LTM text per session — the text currently being injected.
   * When ltmSessionCache is invalidated and recomputed, we compare
   * the new text against the pin. Only update if >5% character
   * difference to avoid cache busts from minor BM25 re-ranking.
   */
  const ltmPinnedText = new Map<string, { formatted: string; tokenCount: number }>();

  /**
   * Measure character-level difference between two strings as a ratio (0..1).
   * Uses a simple common-prefix + common-suffix heuristic.
   */
  function textDiffRatio(a: string, b: string): number {
    if (a === b) return 0;
    if (!a || !b) return 1;
    const minLen = Math.min(a.length, b.length);
    const maxLen = Math.max(a.length, b.length);
    let common = 0;
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) common++;
      else break;
    }
    let suffix = 0;
    for (let i = 0; i < minLen - common; i++) {
      if (a[a.length - 1 - i] === b[b.length - 1 - i]) suffix++;
      else break;
    }
    return 1 - (common + suffix) / maxLen;
  }

  function invalidateLtmCache() {
    // Only clear the computed cache — pins survive to enable content-diff
    // comparison on the next turn's recomputation.
    ltmSessionCache.clear();
  }

  // Sessions where LTM injection failed and the fallback note was pushed.
  // Used to decide whether recovering LTM is worth the prompt cache bust.
  const ltmDegradedSessions = new Set<string>();

  try {
    await load(ctx.directory);
    const firstRun = isFirstRun();
    ensureProject(projectPath);

  if (firstRun) {
    ctx.client.tui.showToast({
      body: {
        message: "Lore is active — your agent will get smarter every session",
        variant: "success",
        duration: 5000,
      },
    }).catch(() => {});
  }

  // Import knowledge at startup — .lore.md takes precedence, falls back
  // to agents file (AGENTS.md/CLAUDE.md) for backward compat / migration.
  {
    const cfg = config();
    if (isValidProjectPath(projectPath) && cfg.knowledge.enabled) {
      try {
        if (loreFileExists(projectPath)) {
          if (shouldImportLoreFile(projectPath)) {
            importLoreFile(projectPath);
            log.info("imported knowledge from .lore.md");
            invalidateLtmCache();
          }
        } else if (cfg.agentsFile.enabled) {
          const filePath = join(projectPath, cfg.agentsFile.path);
          if (shouldImport({ projectPath, filePath })) {
            importFromFile({ projectPath, filePath });
            log.info("imported knowledge from", cfg.agentsFile.path, "(migrating to .lore.md)");
            invalidateLtmCache();
          }
        }
      } catch (e) {
        log.error("knowledge import error:", e);
      }
    }
  }

  // Prune any corrupted/oversized knowledge entries left by the AGENTS.md
  // backslash-escaping bug or curator hallucinations. Sets confidence → 0
  // (below the 0.2 query threshold) so they stop polluting the context.
  if (config().knowledge.enabled) {
    const pruned = ltm.pruneOversized(1200);
    if (pruned > 0) {
      log.info(`pruned ${pruned} oversized knowledge entries (confidence set to 0)`);
      invalidateLtmCache();
    }
  }

  // Index lat.md/ directory sections at startup (if the directory exists).
  // Content-hash-based — skips unchanged files, so this is cheap on repeat runs.
  if (isValidProjectPath(projectPath)) {
    try {
      latReader.refresh(projectPath);
    } catch (e) {
      log.error("lat-reader startup refresh error:", e);
    }
  }

  // Track user turns for periodic curation
  let turnsSinceCuration = 0;

  // Track active sessions for distillation
  const activeSessions = new Set<string>();

  // Per-session idle handler mutex — prevents overlapping idle work when
  // multiple session.idle events fire before the first one completes.
  const idleRunning = new Set<string>();

  // System prompt hash per session — for cache-bust diagnostics (LORE_DEBUG)


  // Sessions currently in auto-recovery — prevents infinite loop when
  // the recovery prompt itself triggers another "prompt too long" error.
  // Without this guard: overflow → recovery prompt → overflow → recovery → ...
  const recoveringSessions = new Set<string>();

  // Sessions to skip for temporal storage and distillation. Includes worker sessions
  // (distillation, curator) and child sessions (eval, any other children).
  // Checked once per session ID and cached to avoid repeated API calls.
  const skipSessions = new Set<string>();

  async function shouldSkip(sessionID: string): Promise<boolean> {
    if (isWorkerSession(sessionID)) return true;
    if (skipSessions.has(sessionID)) return true;
    if (activeSessions.has(sessionID)) return false; // already known good
    // First encounter — check if this is a child session.
    // Only make ONE API call and cache the result either way. The previous
    // implementation fell back to session.list() when session.get() failed
    // (common with short IDs from message events), fetching ALL sessions on
    // every unknown message event. That's too expensive — accept the tradeoff:
    // if a child session has a short ID that fails session.get(), we won't skip
    // it. Worker sessions are already caught by isWorkerSession above, and a few
    // extra temporal messages from eval are harmless.
    try {
      const session = await ctx.client.session.get({ path: { id: sessionID } });
      if (session.data?.parentID) {
        skipSessions.add(sessionID);
        return true;
      }
    } catch {
      // session.get failed (likely short ID or not found) — assume not a child.
    }
    // Cache as known-good so we never re-check this session.
    activeSessions.add(sessionID);
    return false;
  }

  // The active session model — captured from the system transform hook's input.model.
  // Used for cost-aware layer-0 cap calculation.
  let activeSessionModel: { id: string; providerID: string; cost: { input: number; cache: { read: number } } } | undefined;

  /**
   * Resolve the model to use for background worker calls.
   *
   * Priority: explicit config override > session model fallback.
   */
  function getWorkerModel(): { providerID: string; modelID: string } | undefined {
    const cfg = config();
    return workerModel.resolveWorkerModel(
      activeSessionModel?.providerID ?? "",
      cfg.workerModel,
      cfg.model,
    );
  }

  // Background distillation — debounced, non-blocking
  let distilling = false;
  async function backgroundDistill(sessionID: string, force?: boolean) {
    if (distilling) return;
    distilling = true;
    try {
      const cfg = config();
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (
        force ||
        pending >= cfg.distillation.minMessages ||
        needsUrgentDistillation(sessionID)
      ) {
        // Skip meta-distillation when the prompt cache is likely still warm.
        // Meta-distill rewrites row IDs → invalidates distilled prefix cache →
        // cache bust on the next turn. Defer until the cache is cold anyway.
        const cacheTTLMs = cfg.idleResumeMinutes * 60_000;
        const lastTurn = getLastTurnAt(sessionID);
        const cacheWarm = lastTurn > 0 && (Date.now() - lastTurn) < cacheTTLMs;
        await distillation.run({
          llm: createOpenCodeLLMClient(ctx.client, sessionID),
          projectPath,
          sessionID,
          model: getWorkerModel(),
          force,
          skipMeta: cacheWarm && !force,
        });
      }
    } catch (e) {
      log.error("distillation error:", e);
    } finally {
      distilling = false;
    }
  }

  async function backgroundCurate(sessionID: string) {
    try {
      const cfg = config();
      if (!cfg.curator.enabled) return;
      await curator.run({
        llm: createOpenCodeLLMClient(ctx.client, sessionID),
        projectPath,
        sessionID,
        model: getWorkerModel(),
      });
      // Curation may have created/updated/deleted knowledge entries.
      // Invalidate the LTM cache so the next turn picks up the changes.
      invalidateLtmCache();
    } catch (e) {
      log.error("curator error:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // Detached idle handler — runs outside the event hook to prevent re-entrant
  // deadlock. Worker child sessions created by backgroundDistill/backgroundCurate
  // generate events that OpenCode delivers through the same plugin event hook;
  // if the hook is blocked awaiting the worker, events pile up on the internal
  // GlobalBus EventEmitter and the process eventually hangs.
  // ---------------------------------------------------------------------------

  async function handleIdle(sessionID: string) {
    if (idleRunning.has(sessionID)) {
      log.info(`idle handler already running for ${sessionID.substring(0, 16)} — skipping`);
      return;
    }
    idleRunning.add(sessionID);
    try {
      // Force-distill ALL pending messages on idle — even below the normal
      // minMessages threshold. The cache is about to go cold (or already is),
      // so aggressive distillation now means a smaller, cheaper context on the
      // next turn via the post-idle compact layer in gradient.ts.
      await backgroundDistill(sessionID, true);

      // Run curator periodically (only when knowledge system is enabled).
      // onIdle gates whether idle events trigger curation at all; afterTurns
      // is the minimum turn count before curation fires. The previous `||`
      // caused onIdle=true (default) to short-circuit, running the curator
      // on EVERY session.idle — an LLM worker call after every agent turn.
      const cfg = config();
      if (cfg.knowledge.enabled && cfg.curator.onIdle) {
        if (turnsSinceCuration >= cfg.curator.afterTurns) {
          await backgroundCurate(sessionID);
          turnsSinceCuration = 0;
        } else {
          log.info(
            `curation skipped: ${turnsSinceCuration}/${cfg.curator.afterTurns} user turns since last curation`,
          );
        }
      }

      // Consolidate entries if count exceeds cfg.curator.maxEntries.
      // Runs after normal curation so newly created entries are counted.
      // Only triggers when truly over the limit to avoid redundant LLM calls.
      if (cfg.knowledge.enabled) try {
        const allEntries = ltm.forProject(projectPath, false);
        if (allEntries.length > cfg.curator.maxEntries) {
          log.info(
            `entry count ${allEntries.length} exceeds maxEntries ${cfg.curator.maxEntries} — running consolidation`,
          );
          const { updated, deleted } = await curator.consolidate({
            llm: createOpenCodeLLMClient(ctx.client, sessionID),
            projectPath,
            sessionID,
            model: getWorkerModel(),
          });
          if (updated > 0 || deleted > 0) {
            log.info(`consolidation: ${updated} updated, ${deleted} deleted`);
            invalidateLtmCache();
          }
        }
      } catch (e) {
        log.error("consolidation error:", e);
      }

      // Prune temporal messages after distillation and curation have run.
      // Pass 1: TTL — remove distilled messages older than retention period.
      // Pass 2: Size cap — evict oldest distilled messages if over the limit.
      // Undistilled messages are never touched.
      try {
        const { ttlDeleted, capDeleted } = temporal.prune({
          projectPath,
          retentionDays: cfg.pruning.retention,
          maxStorageMB: cfg.pruning.maxStorage,
        });
        if (ttlDeleted > 0 || capDeleted > 0) {
          log.info(
            `pruned temporal messages: ${ttlDeleted} by TTL, ${capDeleted} by size cap`,
          );
        }
      } catch (e) {
        log.error("pruning error:", e);
      }

      // Export curated knowledge to .lore.md (+ pointer in agents file).
      try {
        if (isValidProjectPath(projectPath) && cfg.knowledge.enabled) {
          const entries = ltm.forProject(projectPath, false);
          if (entries.length === 0) {
            log.info("knowledge export: 0 entries for project, skipping write");
          } else if (cfg.agentsFile.enabled) {
            // Writes both .lore.md (entries) and agents file (pointer).
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportToFile({ projectPath, filePath });
          } else {
            // Only write .lore.md (no agents file pointer).
            exportLoreFile(projectPath);
          }
        }
      } catch (e) {
        log.error("knowledge export error:", e);
      }

      // Clean dead knowledge cross-references (entries deleted by curation/consolidation).
      if (cfg.knowledge.enabled) {
        try {
          const cleaned = ltm.cleanDeadRefs();
          if (cleaned > 0) {
            log.info(`cleaned ${cleaned} dead knowledge cross-references`);
            invalidateLtmCache();
          }
        } catch (e) {
          log.error("dead-ref cleanup error:", e);
        }
      }

      // Re-scan lat.md/ directory to pick up changes made by the agent.
      if (isValidProjectPath(projectPath)) {
        try {
          latReader.refresh(projectPath);
        } catch (e) {
          log.error("lat-reader idle refresh error:", e);
        }
      }
    } finally {
      idleRunning.delete(sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // Detached overflow recovery — same fire-and-forget pattern as handleIdle.
  // The recovery path creates child sessions (backgroundDistill, session.prompt)
  // that generate events, causing the same re-entrant deadlock risk.
  // ---------------------------------------------------------------------------

  async function handleOverflowRecovery(errorSessionID: string) {
    log.info(
      `detected context overflow — auto-recovering (session: ${errorSessionID.substring(0, 16)})`,
    );

    // 1. Force layer 2 on next transform (persisted to DB — survives restarts).
    setForceMinLayer(2, errorSessionID);

    // 2. Distill all undistilled messages so nothing is lost.
    await backgroundDistill(errorSessionID, true);

    // 3. Auto-recover: inject a synthetic message that goes through the normal
    //    chat path. The gradient transform fires with forceMinLayer=2, compressing
    //    the context to fit. The model receives the distilled summaries and
    //    continues where it left off — no user intervention needed.
    recoveringSessions.add(errorSessionID);
    try {
      const summaries = distillation
        .loadForSession(projectPath, errorSessionID)
        .map((s) => ({
          observations: s.observations,
          generation: s.generation,
        }));

      // Walk back to the last real user message and check whether it
      // carried media attachments. If yes, route through the
      // media-aware recovery path so the user's text question + a
      // list of dropped attachments survive into the synthetic
      // recovery prompt. Failure of session.messages falls through
      // to plain recovery.
      const lastUser = await getLastRealUserMessage(
        ctx.client,
        errorSessionID,
      );
      const strippedAttachments: string[] = [];
      const userText: string[] = [];
      if (lastUser) {
        for (const part of lastUser.parts) {
          if (part.type === "text" && typeof part.text === "string") {
            userText.push(part.text);
          } else {
            const stub = stripMediaPart(part);
            if (stub) strippedAttachments.push(stub);
          }
        }
      }

      const recoveryText =
        strippedAttachments.length > 0
          ? buildMediaAwareRecoveryMessage({
              summaries,
              strippedAttachments,
              userText,
            })
          : buildRecoveryMessage(summaries);

      log.info(
        `sending auto-recovery message to session ${errorSessionID.substring(0, 16)}${strippedAttachments.length > 0 ? ` (media-aware: ${strippedAttachments.length} attachment(s) stripped)` : ""}`,
      );
      await ctx.client.session.prompt({
        path: { id: errorSessionID },
        body: {
          parts: [{ type: "text", text: recoveryText, synthetic: true }],
        },
      });
      log.info(
        `auto-recovery message sent successfully`,
      );
    } catch (recoveryError) {
      // Recovery is best-effort — don't let it crash the event handler.
      // The persisted forceMinLayer will still help on the user's next message.
      log.error(
        `auto-recovery failed (forceMinLayer still persisted):`,
        recoveryError,
      );
    } finally {
      recoveringSessions.delete(errorSessionID);
    }
  }

  const hooks: Hooks = {
    // Disable built-in compaction and register hidden worker agents.
    // When the gateway is active, also redirect all provider baseURLs through it.
    config: async (input) => {
      const cfg = input as Record<string, unknown>;
      cfg.compaction = { auto: false, prune: false };
      cfg.agent = {
        ...(cfg.agent as Record<string, unknown> | undefined),
        "lore-distill": {
          hidden: true,
          description: "Lore memory distillation worker",
        },
        "lore-curator": {
          hidden: true,
          description: "Lore knowledge curator worker",
        },
        "lore-query-expand": {
          hidden: true,
          description: "Lore query expansion worker",
        },
      };

      if (gatewayActive) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = cfg.provider as Record<string, any> ?? {};
        cfg.provider = p;
        for (const providerID of GATEWAY_PROVIDERS) {
          p[providerID] ??= {};
          p[providerID].options ??= {};
          p[providerID].options!.baseURL = `${gatewayBase}/v1`;
        }
      }
    },

    // Event handling — when the gateway is active, it handles message storage,
    // calibration, incremental distillation, and idle work. The plugin only
    // needs overflow recovery (plugin-only: uses OpenCode SDK for synthetic
    // recovery messages) and active session tracking.
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = event.properties.info;
        if (await shouldSkip(msg.sessionID)) return;

        // Track active sessions — needed by compaction hook even with gateway.
        activeSessions.add(msg.sessionID);

        // When gateway is active, it handles temporal storage, calibration,
        // and incremental distillation.
        if (!gatewayActive) {
          try {
            const full = await ctx.client.session.message({
              path: { id: msg.sessionID, messageID: msg.id },
            });
            if (full.data) {
              temporal.store({
                projectPath,
                info: full.data.info,
                parts: full.data.parts,
              });
              if (msg.role === "user") turnsSinceCuration++;

              if (msg.role === "user") {
                const pending = temporal.undistilledCount(projectPath, msg.sessionID);
                if (pending >= config().distillation.maxSegment) {
                  log.info(
                    `incremental distillation (turn boundary): ${pending} undistilled messages in ${msg.sessionID.substring(0, 16)}`,
                  );
                  backgroundDistill(msg.sessionID);
                }
              }

              if (
                msg.role === "assistant" &&
                msg.tokens &&
                (msg.tokens.input > 0 || msg.tokens.cache.read > 0 || msg.tokens.cache.write > 0)
              ) {
                const actualInput =
                  msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write;
                calibrate(actualInput, msg.sessionID, getLastTransformedCount(msg.sessionID));
              }
            }
          } catch (e) {
            log.warn(`message.updated: failed to fetch message ${msg.id} for session ${msg.sessionID.substring(0, 16)}:`, e);
          }
        }
      }

      if (event.type === "session.error") {
        // Overflow recovery is plugin-only — uses OpenCode SDK for synthetic messages.
        const errorSessionID = (event.properties as Record<string, unknown>).sessionID as
          | string
          | undefined;
        if (errorSessionID && await shouldSkip(errorSessionID)) return;

        const rawError = (event.properties as Record<string, unknown>).error;
        log.info("session.error received:", JSON.stringify(rawError, null, 2));

        if (isContextOverflow(rawError) && errorSessionID) {
          if (recoveringSessions.has(errorSessionID)) {
            log.warn(
              `recovery for ${errorSessionID.substring(0, 16)} also overflowed — giving up (forceMinLayer still persisted)`,
            );
            recoveringSessions.delete(errorSessionID);
            return;
          }

          handleOverflowRecovery(errorSessionID).catch((e) =>
            log.error("overflow recovery error:", e),
          );
        }
      }

      if (event.type === "session.idle") {
        // Gateway handles idle work via its own scheduler.
        if (gatewayActive) return;

        const sessionID = event.properties.sessionID;
        if (await shouldSkip(sessionID)) return;
        if (!activeSessions.has(sessionID)) {
          log.info(`session ${sessionID.substring(0, 16)} idle but not in activeSessions — skipping`);
          return;
        }

        handleIdle(sessionID).catch((e) =>
          log.error("idle handler error:", e),
        );
      }
    },

    // System prompt transform — when the gateway is active, ALL system prompt
    // modifications (LTM injection, model limits, idle-resume, etc.) are
    // handled by the gateway pipeline. The plugin only captures the model info
    // for worker agent selection.
    "experimental.chat.system.transform": async (input, output) => {
      // When the gateway is active, it handles model limits, idle-resume,
      // LTM injection, and gradient configuration. Skip all of that here.
      if (gatewayActive) return;

      // Capture the active session model for worker model selection and cost-aware cap.
      if (input.model) {
        const m = input.model as { id: string; providerID: string; cost?: { input: number; cache?: { read: number } } };
        if (m.cost?.cache?.read) {
          activeSessionModel = {
            id: m.id,
            providerID: m.providerID,
            cost: { input: m.cost.input, cache: { read: m.cost.cache.read } },
          };
        }
      }

      if (input.model?.limit) {
        setModelLimits(input.model.limit);
      }

      const cfg = config();
      if (cfg.budget.maxLayer0Tokens !== undefined) {
        setMaxLayer0Tokens(cfg.budget.maxLayer0Tokens);
      } else if (activeSessionModel && cfg.budget.targetCacheReadCostPerTurn > 0) {
        const cap = computeLayer0Cap(
          cfg.budget.targetCacheReadCostPerTurn,
          activeSessionModel.cost.cache.read,
        );
        setMaxLayer0Tokens(cap);
      }

      // Cold-cache idle-resume: refresh caches when session has been idle
      // longer than the configured threshold.
      if (input.sessionID) {
        const thresholdMs = cfg.idleResumeMinutes * 60_000;
        const result = onIdleResume(input.sessionID, thresholdMs);
        if (result.triggered) {
          ltmSessionCache.delete(input.sessionID);
          log.info(
            `session idle ${Math.round(result.idleMs / 60_000)}min — refreshing caches on cold prompt cache`,
          );
        }
      }

      // Knowledge injection — plugin-only mode (no gateway).
      if (cfg.knowledge.enabled) {
        const sessionID = input.sessionID;
        try {
          let cached = sessionID ? ltmSessionCache.get(sessionID) : undefined;

          if (!cached) {
            const ltmBudget = getLtmBudget(cfg.budget.ltm);
            const entries = ltm.forSession(projectPath, sessionID, ltmBudget);
            if (entries.length) {
              const formatted = formatKnowledge(
                entries.map((e) => ({
                  category: e.category,
                  title: e.title,
                  content: e.content,
                })),
                ltmBudget,
              );

              if (formatted) {
                const tokenCount = Math.ceil(formatted.length / 3);

                if (sessionID && ltmDegradedSessions.has(sessionID)) {
                  const postIdle = consumeCameOutOfIdle(sessionID);
                  if (!postIdle) {
                    const conversationTokens = getLastTransformEstimate(sessionID);
                    if (conversationTokens > tokenCount) {
                      setLtmTokens(0, sessionID);
                      output.system.push(
                        "[Lore plugin] Long-term memory is temporarily unavailable. " +
                          "Use the recall tool to search for project knowledge, " +
                          "past decisions, and prior session context when needed.",
                      );
                      return;
                    }
                  }
                  ltmDegradedSessions.delete(sessionID);
                }

                cached = { formatted, tokenCount };
                if (sessionID) ltmSessionCache.set(sessionID, cached);
              }
            }
          }

          if (cached) {
            const pinned = sessionID ? ltmPinnedText.get(sessionID) : undefined;
            if (pinned && textDiffRatio(pinned.formatted, cached.formatted) < 0.05) {
              setLtmTokens(pinned.tokenCount, sessionID);
              output.system.push(pinned.formatted);
            } else {
              if (sessionID) ltmPinnedText.set(sessionID, cached);
              setLtmTokens(cached.tokenCount, sessionID);
              output.system.push(cached.formatted);
            }
          } else {
            setLtmTokens(0, sessionID);
          }
        } catch (e) {
          log.error("system transform: knowledge injection failed:", e);
          setLtmTokens(0, sessionID);
          if (sessionID) ltmDegradedSessions.add(sessionID);
          output.system.push(
            "[Lore plugin] Long-term memory is temporarily unavailable. " +
              "Use the recall tool to search for project knowledge, " +
              "past decisions, and prior session context when needed.",
          );
        } finally {
          if (sessionID) consumeCameOutOfIdle(sessionID);
        }
      } else {
        setLtmTokens(0, input.sessionID);
        if (input.sessionID) consumeCameOutOfIdle(input.sessionID);
      }
    },

    // Transform message history — gateway handles gradient transform, trailing
    // message cleanup, and distillation triggers when active.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (gatewayActive) return;
      if (!output.messages.length) return;

      const sessionID = output.messages[0]?.info.sessionID;

      try {
        if (sessionID && await shouldSkip(sessionID)) return;

        const result = transform({
          messages: output.messages as unknown as LoreMessageWithParts[],
          projectPath,
          sessionID,
        });

        // Drop trailing pure-text assistant messages to prevent prefill error.
        while (
          result.messages.length > 0 &&
          result.messages.at(-1)!.info.role !== "user"
        ) {
          const last = result.messages.at(-1)!;
          const hasToolParts = last.parts.some((p) => p.type === "tool");
          if (hasToolParts) break;
          const dropped = result.messages.pop()!;
          log.warn(
            "dropping trailing pure-text",
            dropped.info.role,
            "message to prevent prefill error. id:",
            dropped.info.id,
          );
        }

        if (result.layer > 0) {
          output.messages.splice(
            0,
            output.messages.length,
            ...(result.messages as unknown as typeof output.messages),
          );
        }

        if (result.layer >= 1 && sessionID) {
          backgroundDistill(sessionID);
        }
      } catch (e) {
        log.error("messages transform: gradient transform failed:", e);
      }
    },

    // Compaction — gateway handles distillation-aware prompt building when active.
    "experimental.session.compacting": async (input, output) => {
      if (gatewayActive) return;

      if (input.sessionID && activeSessions.has(input.sessionID)) {
        await backgroundDistill(input.sessionID, true);
      }

      const distillations = input.sessionID
        ? distillation.loadForSession(projectPath, input.sessionID)
        : [];

      const previousSummary = input.sessionID
        ? await findPreviousCompactSummary(ctx.client, input.sessionID)
        : undefined;

      const entries = config().knowledge.enabled
        ? ltm.forProject(projectPath, config().crossProject)
        : [];
      const knowledge = entries.length
        ? formatKnowledge(
            entries.map((e) => ({
              category: e.category,
              title: e.title,
              content: e.content,
            })),
          )
        : "";

      if (distillations.length > 0) {
        output.context.push(
          `## Lore Pre-computed Session Summaries\n\nThe following ${distillations.length} summary chunk(s) were pre-computed from the conversation history. Use these as the authoritative source — do not re-summarize the raw messages above if they conflict.\n\n` +
            distillations
              .map(
                (d, i) =>
                  `### Chunk ${i + 1}${d.generation > 0 ? " (consolidated)" : ""}\n${d.observations}`,
              )
              .join("\n\n"),
        );
      }

      output.prompt = buildCompactPrompt({
        hasDistillations: distillations.length > 0,
        knowledge,
        previousSummary,
      });
    },

    // Recall tool is now handled transparently at the gateway layer
    // (packages/gateway/src/recall.ts) — no need to register via plugin.
    // The gateway injects the recall tool into upstream requests and
    // intercepts the response, so it works for ALL clients, not just OpenCode.
    tool: {},
  };

  // Always-on startup confirmation — not gated by LORE_DEBUG — so silent
  // plugin loading failures are immediately visible. If this line never
  // appears for a project, the init failed (see catch block below).
  // Only show the full startup banner on the first session; subsequent
  // sessions just log the project path at debug level to reduce noise.
  if (!processInitDone) {
    process.stderr.write(`[lore] active: ${projectPath}\n`);

    // Startup backfills — run once per process, idempotent.
    try {
      distillation.backfillMetrics();
    } catch (err) {
      log.info("metric backfill failed:", err);
    }

    embedding.runStartupBackfill().catch((err) => {
      log.info("embedding backfill failed:", err);
    });

    if (gatewayActive) {
      process.stderr.write(`[lore] gateway mode active — routing through ${gatewayBase}\n`);
    }

    processInitDone = true;
  } else {
    log.info(`active: ${projectPath}`);
  }

  return hooks;
  } catch (e) {
    // Log the full error before re-throwing so OpenCode's plugin loader
    // (which catches and swallows the error) doesn't hide the root cause.
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(`[lore] init failed: ${detail}\n`);
    throw e;
  }
};

export default LorePlugin;
