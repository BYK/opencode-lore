/**
 * Anthropic ↔ Gateway translation layer.
 *
 * Converts between Anthropic's `/v1/messages` API format and the gateway's
 * internal `GatewayRequest`/`GatewayResponse` types. The parser is lenient —
 * unknown fields pass through in `metadata` rather than causing errors.
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
} from "./types";

// ---------------------------------------------------------------------------
// Anthropic API version — used in all outgoing requests
// ---------------------------------------------------------------------------

const ANTHROPIC_VERSION = "2023-06-01";

// ---------------------------------------------------------------------------
// Fields the gateway reads/writes — everything else goes into `metadata`
// ---------------------------------------------------------------------------

/** Top-level body fields that are extracted into `GatewayRequest` fields. */
const KNOWN_BODY_FIELDS = new Set([
  "model",
  "system",
  "messages",
  "tools",
  "max_tokens",
  "stream",
]);

// ---------------------------------------------------------------------------
// Helpers — content block translation
// ---------------------------------------------------------------------------

/**
 * Normalize an Anthropic content block (from a message's `content` array)
 * into a `GatewayContentBlock`. Unknown block types are preserved as text
 * blocks with a JSON dump so no information is lost.
 */
function toGatewayBlock(block: Record<string, unknown>): GatewayContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };

    case "thinking":
      return {
        type: "thinking",
        thinking: String(block.thinking ?? ""),
        ...(block.signature != null
          ? { signature: String(block.signature) }
          : undefined),
      };

    case "tool_use":
      return {
        type: "tool_use",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: block.input,
      };

    case "tool_result": {
      // Anthropic `tool_result` content can be a string or array of blocks.
      let content = "";
      if (typeof block.content === "string") {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = (block.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n");
      }
      return {
        type: "tool_result",
        toolUseId: String(block.tool_use_id ?? ""),
        content,
        ...(block.is_error ? { isError: true } : undefined),
      };
    }

    default:
      // Unknown block type — preserve as text so nothing is silently dropped
      return { type: "text", text: JSON.stringify(block) };
  }
}

/**
 * Normalize Anthropic message content (string or array of blocks) into
 * a `GatewayContentBlock[]`.
 */
function normalizeContent(content: unknown): GatewayContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content.map((block) =>
      toGatewayBlock(block as Record<string, unknown>),
    );
  }

  // Null / undefined / unexpected → empty
  return [];
}

/**
 * Normalize Anthropic's `system` field. Can be:
 *  - `undefined` / `null`  → `""`
 *  - a plain string         → used directly
 *  - an array of content blocks (e.g. with `cache_control`) → join text blocks
 */
function normalizeSystem(system: unknown): string {
  if (system == null) return "";
  if (typeof system === "string") return system;

  if (Array.isArray(system)) {
    return (system as Array<Record<string, unknown>>)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n");
  }

  return String(system);
}

// ---------------------------------------------------------------------------
// Reverse helpers — gateway blocks → Anthropic format
// ---------------------------------------------------------------------------

/**
 * Convert a `GatewayContentBlock` back to Anthropic's wire format.
 */
function toAnthropicBlock(
  block: GatewayContentBlock,
): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };

    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature != null ? { signature: block.signature } : undefined),
      };

    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };

    case "tool_result": {
      const result: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
      };
      if (block.isError) result.is_error = true;
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// parseAnthropicRequest
// ---------------------------------------------------------------------------

/**
 * Parse a raw Anthropic `/v1/messages` request body into a `GatewayRequest`.
 *
 * Lenient: unknown top-level fields are preserved in `metadata` for
 * faithful upstream forwarding. Content normalization handles both
 * string and array forms.
 */
export function parseAnthropicRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  // --- Extract known fields ---
  const model = String(raw.model ?? "");
  const system = normalizeSystem(raw.system);
  const stream = raw.stream === true;
  const maxTokens =
    typeof raw.max_tokens === "number" ? raw.max_tokens : 4096;

  // --- Messages ---
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages: GatewayMessage[] = rawMessages.map(
    (msg: Record<string, unknown>) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: normalizeContent(msg.content),
    }),
  );

  // --- Tools ---
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools.map(
    (t: Record<string, unknown>) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema: (t.input_schema as Record<string, unknown>) ?? {},
    }),
  );

  // --- Metadata: everything the gateway doesn't explicitly process ---
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_BODY_FIELDS.has(key)) {
      metadata[key] = value;
    }
  }

  return {
    protocol: "anthropic",
    model,
    system,
    messages,
    tools,
    stream,
    maxTokens,
    metadata,
    rawHeaders: headers,
  };
}

// ---------------------------------------------------------------------------
// buildAnthropicRequest
// ---------------------------------------------------------------------------

/**
 * Convert a `GatewayRequest` back to Anthropic API format for upstream
 * forwarding.
 *
 * Returns the relative path, headers, and JSON body. The caller prepends
 * the upstream base URL.
 */
export function buildAnthropicRequest(req: GatewayRequest): {
  url: string;
  headers: Record<string, string>;
  body: unknown;
} {
  // --- Headers ---
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };

  // Forward auth key from the original request
  const apiKey =
    req.rawHeaders["x-api-key"] || req.rawHeaders["X-Api-Key"] || "";
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  // Forward anthropic-beta if present (enables features like extended thinking)
  const beta =
    req.rawHeaders["anthropic-beta"] || req.rawHeaders["Anthropic-Beta"] || "";
  if (beta) {
    headers["anthropic-beta"] = beta;
  }

  // --- Body ---
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: req.stream,
  };

  // System — only include if non-empty
  if (req.system) {
    body.system = req.system;
  }

  // Messages
  body.messages = req.messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  }));

  // Tools — only include if present
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  // Restore all metadata params (temperature, top_p, stop_sequences, etc.)
  for (const [key, value] of Object.entries(req.metadata)) {
    body[key] = value;
  }

  return {
    url: "/v1/messages",
    headers,
    body,
  };
}

// ---------------------------------------------------------------------------
// buildAnthropicNonStreamResponse
// ---------------------------------------------------------------------------

/**
 * Build a non-streaming Anthropic response JSON from a `GatewayResponse`.
 *
 * Produces the standard Anthropic `/v1/messages` response shape with
 * `type: "message"`, `role: "assistant"`, content blocks, and usage.
 */
export function buildAnthropicNonStreamResponse(
  resp: GatewayResponse,
): unknown {
  const usage: Record<string, number> = {
    input_tokens: resp.usage.inputTokens,
    output_tokens: resp.usage.outputTokens,
  };

  if (resp.usage.cacheReadInputTokens != null) {
    usage.cache_read_input_tokens = resp.usage.cacheReadInputTokens;
  }
  if (resp.usage.cacheCreationInputTokens != null) {
    usage.cache_creation_input_tokens = resp.usage.cacheCreationInputTokens;
  }

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    model: resp.model,
    content: resp.content.map(toAnthropicBlock),
    stop_reason: resp.stopReason,
    stop_sequence: null,
    usage,
  };
}
