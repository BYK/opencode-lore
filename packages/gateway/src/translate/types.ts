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
// Session state — per-session tracking for Lore pipeline integration
// ---------------------------------------------------------------------------

/** Per-session state tracked by the gateway for Lore pipeline decisions. */
export type SessionState = {
  sessionID: string;
  projectPath: string;
  /** SHA-256 fingerprint of the first user message — used for session correlation. */
  fingerprint: string;
  /** Unix timestamp (ms) of the last request in this session. */
  lastRequestTime: number;
  /** Total user+assistant messages seen in this session. */
  messageCount: number;
  /** Turns since last curation run — triggers background curation. */
  turnsSinceCuration: number;
};
