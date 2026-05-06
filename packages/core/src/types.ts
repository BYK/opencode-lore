/**
 * Host-agnostic message and part types for Lore's core memory engine.
 *
 * These replace the direct dependency on `@opencode-ai/sdk`'s `Message` and
 * `Part` types so the core can run under any host (OpenCode, Pi, future ACP
 * server, etc.). Each host adapter converts between its native types and these
 * Lore-internal types at the hook boundary.
 *
 * The type surface is intentionally minimal — only the fields that Lore's
 * runtime code actually reads/writes are included. Fields that only exist for
 * the host's UI or for features Lore doesn't touch are omitted.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type LoreUserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  /** Agent name (e.g. "build", "plan"). Host-specific; stored as metadata. */
  agent: string;
  /** Model used for this turn. Stored as metadata. */
  model: { providerID: string; modelID: string };
};

export type LoreAssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  /**
   * Set to `true` by the OpenCode compaction agent on the assistant
   * message that holds a `/compact` summary (see upstream
   * `compaction.ts:435`). Lore reads this flag in F1b's
   * `findPreviousCompactSummary` to anchor repeat `/compact`
   * invocations to the prior summary. Always undefined for normal
   * assistant turns.
   */
  summary?: boolean;
  path: { cwd: string; root: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

/** Discriminated union on `.role`. */
export type LoreMessage = LoreUserMessage | LoreAssistantMessage;

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export type LoreTextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  /** Marks Lore-injected synthetic messages (e.g. distilled prefix). */
  synthetic?: boolean;
  /** Optional timing info — present on real messages, faked on synthetics. */
  time?: { start: number; end?: number };
};

export type LoreReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
};

export type LoreToolStatePending = {
  status: "pending";
  input: unknown;
};

export type LoreToolStateRunning = {
  status: "running";
  input: unknown;
  metadata?: unknown;
  time: { start: number };
};

export type LoreToolStateCompleted = {
  status: "completed";
  input: unknown;
  output: string;
  metadata?: unknown;
  time: { start: number; end: number };
};

export type LoreToolStateError = {
  status: "error";
  input: unknown;
  error: string;
  metadata?: unknown;
  time: { start: number; end: number };
};

export type LoreToolState =
  | LoreToolStatePending
  | LoreToolStateRunning
  | LoreToolStateCompleted
  | LoreToolStateError;

export type LoreToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  tool: string;
  callID: string;
  state: LoreToolState;
};

/**
 * Discriminated union on `.type`.
 *
 * Only `text`, `reasoning`, and `tool` are processed by Lore's core logic.
 * All other part types (step-start, snapshot, patch, agent, retry, etc.) flow
 * through untouched — they hit the `else` branch with a flat 20-token estimate
 * in `estimateParts()` and are preserved as-is in the message transform.
 *
 * For type-safe narrowing, use `isToolPart()` / `isTextPart()` helpers below.
 */
export type LorePart = LoreTextPart | LoreReasoningPart | LoreToolPart | LoreGenericPart;

/**
 * Passthrough for host-specific part types that Lore doesn't process.
 * The `type` field is typed as `string` since Lore only cares that it's not
 * one of the three known types.
 */
export type LoreGenericPart = {
  type: string;
  [key: string]: unknown;
};

// Type guard helpers for narrowing LorePart in core logic.
export function isTextPart(p: LorePart): p is LoreTextPart {
  return p.type === "text";
}
export function isReasoningPart(p: LorePart): p is LoreReasoningPart {
  return p.type === "reasoning";
}
export function isToolPart(p: LorePart): p is LoreToolPart {
  return p.type === "tool";
}

// ---------------------------------------------------------------------------
// Message with parts (the unit that hooks operate on)
// ---------------------------------------------------------------------------

export type LoreMessageWithParts = {
  info: LoreMessage;
  parts: LorePart[];
};

// ---------------------------------------------------------------------------
// LLM Client — the only host API Lore's background tasks need
// ---------------------------------------------------------------------------

/**
 * Abstract interface for single-turn LLM prompt→response.
 *
 * All of Lore's background LLM work (distillation, curation, query expansion)
 * is single-turn: one system+user message in, one text response out. No tool
 * calling, no multi-turn. This interface captures that minimal surface.
 *
 * Host adapters implement this:
 * - OpenCode: wraps `client.session.create()` + `client.session.prompt()`
 * - Pi: wraps `complete()` from `@mariozechner/pi-ai`
 * - Standalone: direct `fetch()` to provider APIs
 */
export interface LLMClient {
  /**
   * Send a single prompt and return the text response.
   *
   * @param system  System prompt text
   * @param user    User message text
   * @param opts    Optional model selection, worker identification, and thinking control
   * @returns The assistant's text response, or null on failure
   */
  prompt(
    system: string,
    user: string,
    opts?: {
      /** Override model for this call. */
      model?: { providerID: string; modelID: string };
      /**
       * Opaque worker identifier used by the host to route the request
       * (e.g. OpenCode uses this as the session agent name).
       */
      workerID?: string;
      /**
       * Disable extended thinking/reasoning for this call.
       *
       * Background workers discard thinking tokens — they only extract the
       * text response. Setting `thinking: false` tells the adapter to avoid
       * producing (and billing for) thinking tokens when possible.
       *
       * Adapter behavior:
       * - Gateway: no-op (bare API call never triggers thinking)
       * - Pi: passes `thinkingEnabled: false` to `complete()`
       * - OpenCode: cannot honor — SDK has no thinking toggle on session.prompt();
       *   relies on Part A (non-reasoning model selection) instead
       */
      thinking?: boolean;
    },
  ): Promise<string | null>;
}
