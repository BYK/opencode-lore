/**
 * Internal representation types for the Lore gateway.
 *
 * The gateway accepts both Anthropic (`/v1/messages`) and OpenAI
 * (`/v1/chat/completions`) protocol requests, normalizes them into these
 * types for Lore pipeline processing, then translates back to the original
 * protocol for the upstream response.
 *
 * Design: types are intentionally minimal — only fields that Lore's context
 * management (gradient, LTM, distillation) actually reads/writes. Protocol-
 * specific fields the gateway doesn't process live in `metadata`.
 */

// ---------------------------------------------------------------------------
// Content blocks — discriminated union on `type`
// ---------------------------------------------------------------------------

export type GatewayTextBlock = {
  type: "text";
  text: string;
};

export type GatewayThinkingBlock = {
  type: "thinking";
  thinking: string;
  /** Anthropic extended thinking signature, opaque bytes. */
  signature?: string;
};

export type GatewayToolUseBlock = {
  type: "tool_use";
  /** Provider-assigned tool call ID (e.g. `toolu_…` for Anthropic). */
  id: string;
  name: string;
  input: unknown;
};

export type GatewayToolResultBlock = {
  type: "tool_result";
  /** ID of the tool_use block this result corresponds to. */
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type GatewayContentBlock =
  | GatewayTextBlock
  | GatewayThinkingBlock
  | GatewayToolUseBlock
  | GatewayToolResultBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Normalized message — system messages are extracted to `GatewayRequest.system`. */
export type GatewayMessage = {
  role: "user" | "assistant";
  content: GatewayContentBlock[];
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Normalized tool definition. Both protocols use JSON Schema for input. */
export type GatewayTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Request — the normalized form after ingress translation
// ---------------------------------------------------------------------------

export type GatewayProtocol = "anthropic" | "openai";

/** Normalized request after ingress translation from either protocol. */
export type GatewayRequest = {
  /** Which protocol the request arrived as — determines egress translation. */
  protocol: GatewayProtocol;
  /** Model identifier (e.g. `claude-sonnet-4-20250514`, `gpt-4o`). */
  model: string;
  /**
   * Extracted system prompt.
   * - Anthropic: top-level `system` field.
   * - OpenAI: first message with `role: "system"`, removed from messages.
   */
  system: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  stream: boolean;
  maxTokens: number;
  /**
   * Protocol-specific parameters the gateway doesn't process but must
   * forward to the upstream provider (e.g. `temperature`, `top_p`,
   * `stop_sequences`, `tool_choice`).
   */
  metadata: Record<string, unknown>;
  /** Original request headers — passed through for auth, tracing, etc. */
  rawHeaders: Record<string, string>;
  /**
   * Additional OpenAI-compatible parameters preserved for upstream forwarding.
   * Populated by `parseOpenAIRequest`.
   */
  extras?: {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    user?: string;
    logprobs?: boolean;
    top_logprobs?: number;
  };
};

// ---------------------------------------------------------------------------
// Response — accumulated from upstream streaming/non-streaming response
// ---------------------------------------------------------------------------

export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt caching — present when cache hits occur. */
  cacheReadInputTokens?: number;
  /** Anthropic prompt caching — tokens written to cache on this request. */
  cacheCreationInputTokens?: number;
};

/** Accumulated response from the upstream provider. */
export type GatewayResponse = {
  id: string;
  model: string;
  content: GatewayContentBlock[];
  /** Provider stop reason (e.g. `end_turn`, `stop`, `tool_use`, `length`). */
  stopReason: string;
  usage: GatewayUsage;
};

// ---------------------------------------------------------------------------
// Recall store (cross-request, gateway recall interception)
// ---------------------------------------------------------------------------

/** Stored recall result for marker-based round-trip expansion. */
export type StoredRecall = {
  /** The tool_use ID to reconstruct in the upstream request. */
  toolUseId: string;
  /** Original recall input (query + scope). */
  input: { query: string; scope?: string };
  /** Position (content block index) in the original assistant message. */
  position: number;
  /** Executed recall result (formatted markdown). */
  result: string;
};

/** Map from marker key (`${scope}:${query}`) → stored recall data. */
export type RecallStore = Map<string, StoredRecall>;

// ---------------------------------------------------------------------------
// Session state — per-session tracking for Lore pipeline integration
// ---------------------------------------------------------------------------

/** Per-turn cache analysis emitted as structured log data. */
export type CacheTurnAnalysis = {
  /** Turn number within this session. */
  turn: number;

  // --- Ground truth from API response ---
  /** Tokens served from prompt cache (hit). */
  cacheRead: number;
  /** Tokens written to prompt cache (miss / new). */
  cacheCreation: number;
  /** Uncached input tokens. */
  inputTokens: number;
  /** cacheRead / total input — 0..1. */
  cacheHitRate: number;

  // --- Request body prefix comparison ---
  /** Bytes matching from start of serialized request body vs previous turn. */
  prefixMatchBytes: number;
  /** prefixMatchBytes / min(prev, current) body length — 0..1. */
  prefixMatchPercent: number;
  /** Semantic location of the first divergence (e.g. "messages[3].content[1]"). */
  divergencePoint: string;
  /** Human-readable reason (e.g. "system prompt changed", "new message appended"). */
  divergenceReason: string;

  // --- Forensic snippets for early divergences (< 5% prefix match) ---
  /** Short snippet of previous body around the divergence point. */
  prevSnippet?: string;
  /** Short snippet of current body around the divergence point. */
  currSnippet?: string;
};

/** Per-session cache analytics state. */
export type CacheAnalytics = {
  /** Deflate-compressed serialized request body from the last turn. */
  lastRequestBody: Uint8Array | null;
  /** Uncompressed byte length of lastRequestBody (for prefix match %). */
  lastRequestBodyLength: number;
  /** cache_read_input_tokens from last API response. */
  lastCacheRead: number;
  /** cache_creation_input_tokens from last API response. */
  lastCacheCreation: number;
  /** Total turns observed. */
  turnCount: number;
  /** Confirmed busts (API returned cacheRead=0 with cacheCreation>0). */
  bustCount: number;
};

/** Per-session state tracked by the gateway for Lore pipeline decisions. */
export type SessionState = {
  sessionID: string;
  projectPath: string;
  /** SHA-256 fingerprint of the first user message — used for Tier 3 session correlation. */
  fingerprint: string;
  /** Unix timestamp (ms) of the last request in this session. */
  lastRequestTime: number;
  /** Total user+assistant messages seen in this session. */
  messageCount: number;
  /** Turns since last curation run — triggers background curation. */
  turnsSinceCuration: number;
  /** Stored recall results for marker-based round-trip expansion. */
  recallStore: RecallStore;
  /** Cache analytics — request body prefix comparison + API cache fields. */
  cacheAnalytics: CacheAnalytics;
  /** Set true in handleConversationTurn when an idle resume was detected;
   *  consumed by postResponse for cache-bust cause telemetry. One-shot. */
  lastTurnWasIdle?: boolean;
  /** Rolling window of recent turns' cold-cache status for auto-TTL upgrade.
   *  true = cold cache (full bust), false = cache hit. */
  coldCacheWindow?: boolean[];
  /** Resolved conversation TTL for this session ("5m" | "1h"). Updated by
   *  the auto-upgrade logic each turn. */
  resolvedConversationTTL?: "5m" | "1h";

  // --- Tier 1/2 session header identification ---

  /** Header-based session ID value (Tier 1 known header or Tier 2 promoted learned header). */
  headerSessionId?: string;
  /** Name of the header that provided `headerSessionId`. */
  headerName?: string;
  /** Candidate headers being tracked during the Tier 2 learning phase.
   *  Key: header name. Value: last seen value + consecutive stable turn count. */
  candidateHeaders?: Map<string, { value: string; seenCount: number }>;

  // --- Dynamic max_tokens sizing ---

  /** EMA of output tokens across recent turns (α=0.3). */
  outputTokensEMA?: number;
  /** Stop reason from the last completed turn (e.g. "end_turn", "tool_use", "length"). */
  lastStopReason?: string;
  /** Total input tokens from the last completed turn (for headroom calculation). */
  lastInputTokens?: number;
};
