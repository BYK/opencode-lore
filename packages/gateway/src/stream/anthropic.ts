/**
 * Anthropic SSE stream handling.
 *
 * Parses upstream Anthropic streaming responses (named SSE events), accumulates
 * the full response into a `GatewayResponse`, and provides helpers for
 * generating synthetic SSE event sequences (e.g. for compaction interception).
 *
 * Anthropic uses named SSE events with a lifecycle:
 *   message_start -> content_block_start/delta/stop (repeated) -> message_delta -> message_stop
 *
 * All functions are pure (no side effects) except `parseSSEStream` which is
 * an async generator consuming a byte stream.
 */
import type {
  GatewayContentBlock,
  GatewayResponse,
  GatewayUsage,
} from "../translate/types";

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------

/** Format a single named SSE event for sending to the client. */
export function formatSSEEvent(eventType: string, data: string): string {
  return `event: ${eventType}\ndata: ${data}\n\n`;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/**
 * Parse an SSE byte stream into typed events.
 *
 * Handles:
 *  - `event: <type>` followed by `data: <json>`
 *  - Multiple `data:` lines (joined with `\n`)
 *  - Blank lines as event delimiters
 *  - Default event type `"message"` when no `event:` line precedes data
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    // Process complete events (delimited by blank lines: \n\n)
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      // Skip empty blocks
      if (block.trim() === "") continue;

      let eventType = "message";
      const dataLines: string[] = [];

      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        // Lines starting with ':' are comments — ignore
        // Other lines without known prefix — ignore per SSE spec
      }

      if (dataLines.length > 0) {
        yield { event: eventType, data: dataLines.join("\n") };
      }
    }

    if (done) {
      // Flush any remaining partial block (shouldn't happen with well-formed SSE)
      if (buffer.trim()) {
        let eventType = "message";
        const dataLines: string[] = [];
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield { event: eventType, data: dataLines.join("\n") };
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Stream accumulator
// ---------------------------------------------------------------------------

/** Intermediate block state during streaming. */
type AccumulatingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; partialJson: string };

/** State machine that processes Anthropic SSE events and builds a GatewayResponse. */
export interface StreamAccumulator {
  /** Process a single SSE event. Returns the event line(s) to forward to client. */
  processEvent(eventType: string, data: string): string;
  /** Get the accumulated response after stream ends. */
  getResponse(): GatewayResponse;
  /** Whether the stream has completed (message_stop received). */
  isDone(): boolean;
}

export function createStreamAccumulator(): StreamAccumulator {
  let id = "";
  let model = "";
  let stopReason = "";
  let done = false;

  const usage: GatewayUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  /** Blocks indexed by their stream index. */
  const blocks = new Map<number, AccumulatingBlock>();
  /** Finalized content blocks in order. */
  const content: GatewayContentBlock[] = [];
  /** Track which indices have been finalized. */
  const finalized = new Set<number>();

  function processEvent(eventType: string, data: string): string {
    // Forward the event as-is regardless of processing outcome
    const forwarded = formatSSEEvent(eventType, data);

    // Parse the data payload — if it's not valid JSON, just forward
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return forwarded;
    }

    switch (eventType) {
      case "message_start":
        handleMessageStart(parsed);
        break;
      case "content_block_start":
        handleContentBlockStart(parsed);
        break;
      case "content_block_delta":
        handleContentBlockDelta(parsed);
        break;
      case "content_block_stop":
        handleContentBlockStop(parsed);
        break;
      case "message_delta":
        handleMessageDelta(parsed);
        break;
      case "message_stop":
        done = true;
        break;
      // "ping" and unknown events — just forward
    }

    return forwarded;
  }

  function handleMessageStart(parsed: Record<string, unknown>): void {
    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) return;

    if (typeof message.id === "string") id = message.id;
    if (typeof message.model === "string") model = message.model;

    const msgUsage = message.usage as Record<string, number> | undefined;
    if (msgUsage) {
      if (typeof msgUsage.input_tokens === "number") {
        usage.inputTokens = msgUsage.input_tokens;
      }
      if (typeof msgUsage.output_tokens === "number") {
        usage.outputTokens = msgUsage.output_tokens;
      }
      if (typeof msgUsage.cache_read_input_tokens === "number") {
        usage.cacheReadInputTokens = msgUsage.cache_read_input_tokens;
      }
      if (typeof msgUsage.cache_creation_input_tokens === "number") {
        usage.cacheCreationInputTokens = msgUsage.cache_creation_input_tokens;
      }
    }
  }

  function handleContentBlockStart(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const block = parsed.content_block as Record<string, unknown> | undefined;
    if (!block || typeof block.type !== "string") return;

    switch (block.type) {
      case "text":
        blocks.set(index, {
          type: "text",
          text: typeof block.text === "string" ? block.text : "",
        });
        break;
      case "thinking":
        blocks.set(index, {
          type: "thinking",
          thinking:
            typeof block.thinking === "string" ? block.thinking : "",
          signature: "",
        });
        break;
      case "tool_use":
        blocks.set(index, {
          type: "tool_use",
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          partialJson: "",
        });
        break;
    }
  }

  function handleContentBlockDelta(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta.type !== "string") return;

    const block = blocks.get(index);
    if (!block) return;

    switch (delta.type) {
      case "text_delta":
        if (block.type === "text" && typeof delta.text === "string") {
          block.text += delta.text;
        }
        break;
      case "thinking_delta":
        if (
          block.type === "thinking" &&
          typeof delta.thinking === "string"
        ) {
          block.thinking += delta.thinking;
        }
        break;
      case "signature_delta":
        if (
          block.type === "thinking" &&
          typeof delta.signature === "string"
        ) {
          block.signature += delta.signature;
        }
        break;
      case "input_json_delta":
        if (
          block.type === "tool_use" &&
          typeof delta.partial_json === "string"
        ) {
          block.partialJson += delta.partial_json;
        }
        break;
    }
  }

  function handleContentBlockStop(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const block = blocks.get(index);
    if (!block || finalized.has(index)) return;

    finalized.add(index);

    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "thinking": {
        const thinkingBlock: GatewayContentBlock = {
          type: "thinking",
          thinking: block.thinking,
        };
        if (block.signature) {
          (thinkingBlock as { signature?: string }).signature =
            block.signature;
        }
        content.push(thinkingBlock);
        break;
      }
      case "tool_use": {
        let input: unknown = {};
        if (block.partialJson) {
          try {
            input = JSON.parse(block.partialJson);
          } catch {
            // Malformed JSON — store as raw string
            input = block.partialJson;
          }
        }
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input,
        });
        break;
      }
    }
  }

  function handleMessageDelta(parsed: Record<string, unknown>): void {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.stop_reason === "string") {
      stopReason = delta.stop_reason;
    }

    // message_delta usage is cumulative output tokens
    const deltaUsage = parsed.usage as Record<string, number> | undefined;
    if (deltaUsage) {
      if (typeof deltaUsage.output_tokens === "number") {
        usage.outputTokens = deltaUsage.output_tokens;
      }
    }
  }

  function getResponse(): GatewayResponse {
    // Finalize any blocks that weren't explicitly stopped (shouldn't happen
    // with well-formed streams, but be defensive)
    for (const [index, block] of blocks) {
      if (!finalized.has(index)) {
        finalized.add(index);
        switch (block.type) {
          case "text":
            content.push({ type: "text", text: block.text });
            break;
          case "thinking":
            content.push({
              type: "thinking",
              thinking: block.thinking,
              ...(block.signature ? { signature: block.signature } : {}),
            });
            break;
          case "tool_use": {
            let input: unknown = {};
            if (block.partialJson) {
              try {
                input = JSON.parse(block.partialJson);
              } catch {
                input = block.partialJson;
              }
            }
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
            });
            break;
          }
        }
      }
    }

    return {
      id,
      model,
      content,
      stopReason,
      usage: { ...usage },
    };
  }

  return {
    processEvent,
    getResponse,
    isDone: () => done,
  };
}

// ---------------------------------------------------------------------------
// Synthetic SSE builders
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `message_start` SSE event from a GatewayResponse.
 *
 * Used when the gateway generates its own response (e.g. compaction
 * interception) and needs to emit a well-formed Anthropic stream.
 */
export function buildSSEMessageStart(response: GatewayResponse): string {
  const message = {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: response.usage.inputTokens,
        output_tokens: 1,
        ...(response.usage.cacheReadInputTokens != null
          ? { cache_read_input_tokens: response.usage.cacheReadInputTokens }
          : {}),
        ...(response.usage.cacheCreationInputTokens != null
          ? {
              cache_creation_input_tokens:
                response.usage.cacheCreationInputTokens,
            }
          : {}),
      },
    },
  };

  return formatSSEEvent("message_start", JSON.stringify(message));
}

/**
 * Build a complete SSE event sequence for a simple text-only response.
 *
 * Generates the full Anthropic streaming lifecycle:
 *   message_start -> content_block_start -> content_block_delta ->
 *   content_block_stop -> message_delta -> message_stop
 *
 * Used for compaction interception where Lore generates a synthetic
 * response instead of forwarding to upstream.
 */
export function buildSSETextResponse(
  id: string,
  model: string,
  text: string,
  usage: { inputTokens: number; outputTokens: number },
): string {
  const events: string[] = [];

  // message_start
  events.push(
    formatSSEEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: 1,
          },
        },
      }),
    ),
  );

  // content_block_start
  events.push(
    formatSSEEvent(
      "content_block_start",
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    ),
  );

  // content_block_delta — full text in one delta
  events.push(
    formatSSEEvent(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
  );

  // content_block_stop
  events.push(
    formatSSEEvent(
      "content_block_stop",
      JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    ),
  );

  // message_delta
  events.push(
    formatSSEEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.outputTokens },
      }),
    ),
  );

  // message_stop
  events.push(
    formatSSEEvent(
      "message_stop",
      JSON.stringify({ type: "message_stop" }),
    ),
  );

  return events.join("");
}

/**
 * Consume an Anthropic SSE streaming Response and return the accumulated
 * GatewayResponse. Useful when the response needs to be translated to another
 * protocol format (e.g. OpenAI) after the pipeline produces Anthropic SSE.
 */
export async function accumulateSSEResponse(
  response: Response,
): Promise<GatewayResponse> {
  const accumulator = createStreamAccumulator();
  const text = await response.text();

  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let eventType = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      accumulator.processEvent(eventType, dataLines.join("\n"));
    }
  }

  return accumulator.getResponse();
}
