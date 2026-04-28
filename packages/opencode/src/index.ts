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
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
  onIdleResume,
  consumeCameOutOfIdle,
  formatKnowledge,
  formatDistillations,
  buildCompactPrompt,
  shouldImport,
  importFromFile,
  exportToFile,
  latReader,
  embedding,
  log,
  isWorkerSession,
} from "@loreai/core";
import { createRecallTool } from "./reflect";
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

export const LorePlugin: Plugin = async (ctx) => {
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
  function invalidateLtmCache() {
    ltmSessionCache.clear();
  }

  // Sessions where LTM injection failed and the fallback note was pushed.
  // Used to decide whether recovering LTM is worth the prompt cache bust.
  const ltmDegradedSessions = new Set<string>();

  try {
    await load(ctx.directory);
    let firstRun = isFirstRun();
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

  // Import from AGENTS.md at startup if it has changed since last export
  // (hand-written entries, edits from other machines, or merge conflicts).
  {
    const cfg = config();
    if (isValidProjectPath(projectPath) && cfg.knowledge.enabled && cfg.agentsFile.enabled) {
      const filePath = join(projectPath, cfg.agentsFile.path);
      if (shouldImport({ projectPath, filePath })) {
        try {
          importFromFile({ projectPath, filePath });
          log.info("imported knowledge from", cfg.agentsFile.path);
          invalidateLtmCache();
        } catch (e) {
          log.error("agents-file import error:", e);
        }
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
        needsUrgentDistillation()
      ) {
        await distillation.run({
          llm: createOpenCodeLLMClient(ctx.client, sessionID),
          projectPath,
          sessionID,
          model: cfg.model,
          force,
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
        model: cfg.model,
      });
      // Curation may have created/updated/deleted knowledge entries.
      // Invalidate the LTM cache so the next turn picks up the changes.
      invalidateLtmCache();
    } catch (e) {
      log.error("curator error:", e);
    }
  }

  const hooks: Hooks = {
    // Disable built-in compaction and register hidden worker agents
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
    },

    // Store all messages in temporal DB for full-text search and distillation.
    // Skips child sessions (eval, worker) to prevent pollution.
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = event.properties.info;
        if (await shouldSkip(msg.sessionID)) return;
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
            activeSessions.add(msg.sessionID);
            if (msg.role === "user") turnsSinceCuration++;

            // Incremental distillation: when undistilled messages accumulate past
            // maxSegment, distill immediately instead of waiting for session.idle.
            if (
              msg.role === "assistant" &&
              msg.tokens &&
              // Include cache.write: tokens written to cache were fully sent to the
              // model (they were processed, just not read from a prior cache slot).
              // Omitting cache.write causes a dramatic undercount on cold-cache turns
              // where cache.read=0 but 150K+ tokens were written — leading the gradient
              // to think only 3 tokens went in and passing the full session as layer 0.
              (msg.tokens.input > 0 || msg.tokens.cache.read > 0 || msg.tokens.cache.write > 0)
            ) {
              const pending = temporal.undistilledCount(projectPath, msg.sessionID);
              if (pending >= config().distillation.maxSegment) {
                log.info(
                  `incremental distillation: ${pending} undistilled messages in ${msg.sessionID.substring(0, 16)}`,
                );
                backgroundDistill(msg.sessionID);
              }

              // Calibrate overhead using real token counts from the API response.
              // actualInput = all tokens the model processed (input + cache.read + cache.write).
              // The message estimate comes from the transform's own output (stored in
              // session state as lastTransformEstimate), NOT from re-estimating all session
              // messages. On compressed sessions, all-message estimate >> actualInput, which
              // previously clamped overhead to 0 and broke budget calculations.
              const actualInput =
                msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write;
              calibrate(actualInput, msg.sessionID, getLastTransformedCount(msg.sessionID));
            }
          }
        } catch (e) {
          // Message may not be fetchable yet during streaming
          log.warn(`message.updated: failed to fetch message ${msg.id} for session ${msg.sessionID.substring(0, 16)}:`, e);
        }
      }

      if (event.type === "session.error") {
        // Skip eval/worker child sessions — only handle errors for real user sessions.
        const errorSessionID = (event.properties as Record<string, unknown>).sessionID as
          | string
          | undefined;
        if (errorSessionID && await shouldSkip(errorSessionID)) return;

        // Detect "prompt is too long" API errors and auto-recover.
        const rawError = (event.properties as Record<string, unknown>).error;
        log.info("session.error received:", JSON.stringify(rawError, null, 2));

        if (isContextOverflow(rawError) && errorSessionID) {
          // Prevent infinite loop: if we're already recovering this session,
          // the recovery prompt itself overflowed — don't try again.
          // Without this guard: overflow → distill + prompt → overflow → distill + prompt → ...
          // Each cycle fires 2+ LLM calls, repeating until rate-limited.
          if (recoveringSessions.has(errorSessionID)) {
            log.warn(
              `recovery for ${errorSessionID.substring(0, 16)} also overflowed — giving up (forceMinLayer still persisted)`,
            );
            recoveringSessions.delete(errorSessionID);
            return;
          }

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
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        if (await shouldSkip(sessionID)) return;
        if (!activeSessions.has(sessionID)) {
          log.info(`session ${sessionID.substring(0, 16)} idle but not in activeSessions — skipping`);
          return;
        }

        // Run background distillation for any remaining undistilled messages
        await backgroundDistill(sessionID);

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
              model: cfg.model,
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

        // Export curated knowledge to AGENTS.md after distillation + curation.
        try {
          const agentsCfg = cfg.agentsFile;
          if (isValidProjectPath(projectPath) && cfg.knowledge.enabled && agentsCfg.enabled) {
            const entries = ltm.forProject(projectPath, false);
            if (entries.length === 0) {
              log.info("agents-file export: 0 knowledge entries for project, skipping write");
            } else {
              const filePath = join(projectPath, agentsCfg.path);
              exportToFile({ projectPath, filePath });
            }
          }
        } catch (e) {
          log.error("agents-file export error:", e);
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
      }
    },

    // Inject LTM knowledge into system prompt — relevance-ranked and budget-capped.
    "experimental.chat.system.transform": async (input, output) => {
      // One-time first-run note so the agent acknowledges Lore is active.
      // Cleared after first injection to avoid repeating on subsequent turns.
      if (firstRun) {
        output.system.push(
          "[Lore plugin] This is the first time Lore has been activated. " +
          "Briefly let the user know that Lore is now active and their " +
          "coding agent will get progressively smarter on this codebase " +
          "over time as knowledge accumulates across sessions.",
        );
        firstRun = false;
      }

      if (input.model?.limit) {
        setModelLimits(input.model.limit);
      }

      const cfg = config();

      // Cold-cache idle-resume: when the gap since this session's last turn
      // exceeds the configured threshold, Anthropic's prompt cache has already
      // evicted our prefix bytes. Refresh Lore's byte-identity caches before
      // they're consulted on this turn. Reasoning blocks are NOT touched
      // (Anthropic's April 23 postmortem identifies that as the root cause of
      // forgetfulness/repetition). Wired into the system transform hook
      // because (a) it always fires before the messages transform hook, so
      // gradient.ts caches are reset before transform() consumes them, and
      // (b) ltmSessionCache lives in this closure and is consulted below.
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

      // Knowledge injection — only when the knowledge system is enabled.
      // When disabled, LTM budget is zero and no knowledge is injected.
      //
      // Uses per-session caching to preserve system prompt byte-stability
      // for Anthropic's prompt caching. Without this, forSession() re-scores
      // entries against evolving session context every turn, producing
      // different formatted text → system prompt changes at byte 0 → total
      // cache invalidation on every single turn.
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

                // If this session was previously degraded (fallback note instead of LTM),
                // switching to real LTM changes the system prompt prefix → busts the
                // provider's read-token cache for the entire conversation after this point.
                // Only recover if the cache invalidation cost is small relative to LTM benefit.
                //
                // Exception (F-CACHE-TTL): if onIdleResume() just fired for this session,
                // the provider's prompt cache is already cold from the wall-clock gap, so
                // the "cache bust cost" is effectively zero. Recover LTM unconditionally.
                if (sessionID && ltmDegradedSessions.has(sessionID)) {
                  const postIdle = consumeCameOutOfIdle(sessionID);
                  if (!postIdle) {
                    const conversationTokens = getLastTransformEstimate(sessionID);
                    if (conversationTokens > tokenCount) {
                      // Conversation is larger than LTM — cache bust costs more than
                      // LTM is worth. Keep the fallback note for this session.
                      setLtmTokens(0);
                      output.system.push(
                        "[Lore plugin] Long-term memory is temporarily unavailable. " +
                          "Use the recall tool to search for project knowledge, " +
                          "past decisions, and prior session context when needed.",
                      );
                      return;
                    }
                  }
                  // Conversation is small (or post-idle) — LTM benefit outweighs cache cost. Recover.
                  ltmDegradedSessions.delete(sessionID);
                }

                cached = { formatted, tokenCount };
                if (sessionID) ltmSessionCache.set(sessionID, cached);
              }
            }
          }

          if (cached) {
            setLtmTokens(cached.tokenCount);
            output.system.push(cached.formatted);
          } else {
            setLtmTokens(0);
          }
        } catch (e) {
          log.error("system transform: knowledge injection failed:", e);
          setLtmTokens(0);
          if (sessionID) ltmDegradedSessions.add(sessionID);
          output.system.push(
            "[Lore plugin] Long-term memory is temporarily unavailable. " +
              "Use the recall tool to search for project knowledge, " +
              "past decisions, and prior session context when needed.",
          );
        } finally {
          // Hygiene: ensure cameOutOfIdle never lingers across turns. The flag
          // is meaningful only for the post-idle turn's LTM-recovery decision;
          // clear it unconditionally here so a healthy turn followed later by
          // a degraded turn can't falsely bypass the cache-cost comparison.
          if (sessionID) consumeCameOutOfIdle(sessionID);
        }
      } else {
        setLtmTokens(0);
        if (input.sessionID) consumeCameOutOfIdle(input.sessionID);
      }

      // Remind the agent to include the agents file in commits.
      // It is always modified after the lore export runs (post-session) so it
      // appears as unstaged when the agent goes to commit — the agent must not
      // skip it just because it looks auto-generated.
      if (cfg.knowledge.enabled && cfg.agentsFile.enabled) {
        output.system.push(
          `When making git commits, always check if ${cfg.agentsFile.path} has ` +
          `unstaged changes and include it in the commit. This file contains ` +
          `shared project knowledge managed by lore and must be version-controlled.`,
        );
      }
    },

    // Transform message history: distilled prefix + raw recent.
    // Layer 0 = passthrough (messages fit without compression) — output.messages
    // is left untouched to preserve the append-only pattern for prompt caching.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages.length) return;

      const sessionID = output.messages[0]?.info.sessionID;

      try {
        // Skip gradient transform for lore worker sessions (lore-distill, lore-curator).
        // Worker sessions are small (typically 5-15 messages) and don't need context
        // management. More importantly, allowing them through would overwrite the
        // per-session state for the MAIN session if they happen to share a session ID —
        // and before per-session state was introduced, module-level variables were
        // corrupted this way, causing calibration oscillation and layer 0 passthrough
        // on the main session's next step. Belt-and-suspenders: even with per-session
        // state, worker sessions waste CPU on transform() for no benefit.
        if (sessionID && await shouldSkip(sessionID)) return;

        // OpenCode's Message/Part types are a superset of Lore's internal types.
        // Cast at the boundary — both are structurally compatible at runtime.
        const result = transform({
          messages: output.messages as unknown as LoreMessageWithParts[],
          projectPath,
          sessionID,
        });

        // The API requires the conversation to end with a user message.
        // Drop trailing pure-text assistant messages (no tool parts), which would
        // cause an Anthropic "does not support assistant message prefill" error.
        // This must run at ALL layers, including layer 0 (passthrough) — the error
        // can occur even when messages fit within the context budget.
        //
        // Crucially, assistant messages that contain tool parts must NOT be dropped:
        // - Completed/error tool parts: OpenCode's SDK converts these into tool_result
        //   blocks sent as user-role messages at the API level. The conversation already
        //   ends with a user message — dropping would strip the entire current agentic
        //   turn and cause an infinite tool-call loop (the model restarts from scratch).
        // - Note: pending/running tool parts are converted to error state upstream by
        //   sanitizeToolParts() in gradient.ts, so by this point all tool parts have a
        //   terminal state (completed or error) and will generate tool_result blocks.
        //
        // Note: at layer 0, result.messages === output.messages (same reference), so
        // mutating result.messages here also trims output.messages in place — which is
        // safe for prompt caching since we only ever remove trailing messages, never
        // reorder or insert.
        while (
          result.messages.length > 0 &&
          result.messages.at(-1)!.info.role !== "user"
        ) {
          const last = result.messages.at(-1)!;
          const hasToolParts = last.parts.some((p) => p.type === "tool");
          if (hasToolParts) {
            // Tool parts → tool_result (user-role) at the API level → no prefill error.
            // Stop dropping; the conversation ends correctly as-is.
            break;
          }
          const dropped = result.messages.pop()!;
          log.warn(
            "dropping trailing pure-text",
            dropped.info.role,
            "message to prevent prefill error. id:",
            dropped.info.id,
          );
        }

        // Only restructure messages when the gradient transform is active (layers 1-4).
        // Layer 0 means all messages fit within the context budget — leave them alone
        // so the append-only sequence stays intact for prompt caching.
        if (result.layer > 0) {
          // Cast back to OpenCode's message type — Lore's LoreMessageWithParts
          // is a structural subset, and the gradient transform preserves all
          // host-specific fields via spread operators on the original objects.
          output.messages.splice(
            0,
            output.messages.length,
            ...(result.messages as unknown as typeof output.messages),
          );
        }

        if (result.layer >= 2 && sessionID) {
          backgroundDistill(sessionID);
        }
      } catch (e) {
        log.error("messages transform: gradient transform failed:", e);
        // output.messages untouched — session continues without context management
      }
    },

    // Replace compaction prompt with distillation-aware prompt when /compact is used.
    // Strategy: run chunked distillation first so all messages are captured in segments
    // that each fit within the model's context, then inject the pre-computed summaries
    // as context so the model consolidates them rather than re-reading all raw messages.
    // Output format is the task-oriented SUMMARY_TEMPLATE from @loreai/core's
    // buildCompactPrompt (Goal / Progress / Next Steps / Blocked / etc.), derived from
    // upstream OpenCode's template so the next agent starting from the compacted
    // context has a clear "where am I, what's next" briefing.
    //
    // F1b: when a prior /compact summary exists in the session (assistant
    // message with `info.summary === true`), retrieve it via
    // `findPreviousCompactSummary` and pass as `previousSummary` so the
    // model UPDATES the anchored summary rather than re-deriving from
    // scratch. Mirrors upstream's `<previous-summary>` behavior.
    "experimental.session.compacting": async (input, output) => {
      // Chunked distillation: split all undistilled messages into segments that each
      // fit within the model's context window and distill them independently.
      // This is safe even when the full session exceeds the context limit.
      if (input.sessionID && activeSessions.has(input.sessionID)) {
        await backgroundDistill(input.sessionID, true);
      }

      // Load all distillation summaries produced for this session (oldest first).
      // These are the chunked observations — the model will consolidate them.
      const distillations = input.sessionID
        ? distillation.loadForSession(projectPath, input.sessionID)
        : [];

      // F1b anchor: find the prior /compact assistant summary (if any).
      // SDK failure / no prior summary → undefined → byte-identical to
      // pre-F1b prompt output.
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

      // Inject each distillation chunk as a context string so the model has access
      // to pre-computed summaries. Even if the raw messages overflow context, these
      // summaries are compact and will fit.
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

    // Register the recall tool
    tool: {
      recall: createRecallTool(
        projectPath,
        config().knowledge.enabled,
        (sessionID) => createOpenCodeLLMClient(ctx.client, sessionID),
        config().search,
      ),
    },
  };

  // Always-on startup confirmation — not gated by LORE_DEBUG — so silent
  // plugin loading failures are immediately visible. If this line never
  // appears for a project, the init failed (see catch block below).
  process.stderr.write(`[lore] active: ${projectPath}\n`);

  // Background: backfill embeddings for entries that don't have one yet.
  // Fires once when embeddings are first enabled — subsequent entries
  // get embedded on create/update via ltm.ts and distillation.ts hooks.
  if (embedding.isAvailable()) {
    Promise.all([
      embedding.backfillEmbeddings(),
      embedding.backfillDistillationEmbeddings(),
    ]).catch((err) => {
      log.info("embedding backfill failed:", err);
    });
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
