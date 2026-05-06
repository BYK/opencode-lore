/**
 * OpenAI ↔ Gateway translation layer.
 *
 * Converts between OpenAI's `/v1/chat/completions` API format and the gateway's
 * internal `GatewayRequest`/`GatewayResponse` types.
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
} from "./types";

// ---------------------------------------------------------------------------
// OpenAI → GatewayRequest
// ---------------------------------------------------------------------------

export function parseOpenAIRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  // Extract known fields
  const model = String(raw.model ?? "");
  const stream = raw.stream === true;

  // max_tokens defaults to 4096 if not specified
  const maxTokens =
    typeof raw.max_tokens === "number" ? raw.max_tokens : 4096;

  // Extract extras (temperature, top_p, etc.) for later forwarding
  const extras: GatewayRequest["extras"] = {};
  if (typeof raw.temperature === "number") {
    extras.temperature = raw.temperature;
  }
  if (typeof raw.top_p === "number") {
    extras.top_p = raw.top_p;
  }
  if (typeof raw.frequency_penalty === "number") {
    extras.frequency_penalty = raw.frequency_penalty;
  }
  if (typeof raw.presence_penalty === "number") {
    extras.presence_penalty = raw.presence_penalty;
  }
  if (typeof raw.user === "string") {
    extras.user = raw.user;
  }
  if (raw.logprobs === true || raw.logprobs === false) {
    extras.logprobs = raw.logprobs;
  }
  if (typeof raw.top_logprobs === "number") {
    extras.top_logprobs = raw.top_logprobs;
  }

  // Parse messages and extract system prompt
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  let system = "";
  const messages: GatewayMessage[] = [];

  for (const msg of rawMessages as Array<Record<string, unknown>>) {
    const role = msg.role as string;
    const content = msg.content;

    if (role === "system") {
      // Concatenate multiple system messages with double newline
      const text = typeof content === "string" ? content : "";
      if (system) {
        system += "\n\n" + text;
      } else {
        system = text;
      }
      continue;
    }

    if (role === "user") {
      const blocks = parseUserContent(content, msg.tool_calls as Array<Record<string, unknown>> | undefined);
      messages.push({ role: "user", content: blocks });
      continue;
    }

    if (role === "assistant") {
      const blocks = parseAssistantContent(
        content,
        msg.tool_calls as Array<Record<string, unknown>> | undefined,
      );
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    if (role === "tool") {
      // Tool results are already represented in the content of the user message
      // that follows them in OpenAI. We process them when we encounter the
      // assistant message that generated the tool call.
      const toolResultBlocks = parseToolResult(msg);
      if (toolResultBlocks.length > 0) {
        messages.push({ role: "user", content: toolResultBlocks });
      }
      continue;
    }
  }

  // Parse tools
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools.map(
    (t: Record<string, unknown>) => {
      const func = t.function as Record<string, unknown> | undefined;
      return {
        name: String(func?.name ?? t.name ?? ""),
        description: String(func?.description ?? ""),
        inputSchema: (func?.parameters as Record<string, unknown>) ?? {},
      };
    },
  );

  return {
    protocol: "openai",
    model,
    system,
    messages,
    tools,
    stream,
    maxTokens,
    metadata: {},
    rawHeaders: {
      ...headers,
      "x-api-key": headers["x-api-key"] ?? "",
    },
    extras,
  };
}

function parseUserContent(
  content: unknown,
  toolCalls?: Array<Record<string, unknown>>,
): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];

  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        blocks.push({ type: "text", text: String(item.text ?? "") });
      } else if (item.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: String(item.id ?? ""),
          name: String(item.name ?? ""),
          input: item.input ?? {},
        });
      }
    }
  }

  // Add tool_use blocks from tool_calls field
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      blocks.push({
        type: "tool_use",
        id: String(tc.id ?? ""),
        name: String(fn?.name ?? ""),
        input: fn?.arguments ? JSON.parse(fn.arguments as string) : {},
      });
    }
  }

  return blocks;
}

function parseAssistantContent(
  content: unknown,
  toolCalls?: Array<Record<string, unknown>>,
): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];

  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        blocks.push({ type: "text", text: String(item.text ?? "") });
      } else if (item.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: String(item.id ?? ""),
          name: String(item.name ?? ""),
          input: item.input ?? {},
        });
      }
    }
  }

  // Add tool_use blocks from tool_calls field
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      blocks.push({
        type: "tool_use",
        id: String(tc.id ?? ""),
        name: String(fn?.name ?? ""),
        input: fn?.arguments ? JSON.parse(fn.arguments as string) : {},
      });
    }
  }

  return blocks;
}

function parseToolResult(msg: Record<string, unknown>): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];
  const toolCallId = String(msg.tool_call_id ?? "");
  const content = msg.content;

  if (typeof content === "string" && content) {
    blocks.push({
      type: "tool_result",
      toolUseId: toolCallId,
      content,
    });
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        blocks.push({
          type: "tool_result",
          toolUseId: toolCallId,
          content: String(item.text ?? ""),
        });
      }
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// GatewayResponse → OpenAI response
// ---------------------------------------------------------------------------

export function buildOpenAIResponse(
  resp: GatewayResponse,
  wasStreaming: boolean,
): Response {
  if (wasStreaming) {
    return buildOpenAIStreamResponse(resp);
  }
  return buildOpenAINonStreamResponse(resp);
}

function buildOpenAINonStreamResponse(resp: GatewayResponse): Response {
  const chunks: unknown[] = [];
  let content = "";
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const response = {
    id: resp.id.startsWith("chatcmpl-") ? resp.id : `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(resp.stopReason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: resp.usage.inputTokens,
      completion_tokens: resp.usage.outputTokens,
      total_tokens:
        resp.usage.inputTokens + resp.usage.outputTokens,
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

function buildOpenAIStreamResponse(resp: GatewayResponse): Response {
  const encoder = new TextEncoder();
  let offset = 0;

  const stream = new ReadableStream({
    start(controller) {
      const baseId = resp.id.startsWith("chatcmpl-")
        ? resp.id
        : `chatcmpl-${resp.id}`;
      const created = Math.floor(Date.now() / 1000);

      function emitChunk(
        delta: Record<string, unknown>,
        finishReason: string | null,
      ) {
        const chunk = {
          id: baseId,
          object: "chat.completion.chunk",
          created,
          model: resp.model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }

      // Emit role in first chunk
      emitChunk({ role: "assistant" }, null);

      // Process content blocks
      for (const block of resp.content) {
        if (block.type === "text") {
          // Split text into small chunks to simulate streaming
          const text = block.text;
          let pos = 0;
          while (pos < text.length) {
            const chunk = text.slice(pos, pos + 10);
            emitChunk({ content: chunk }, null);
            pos += 10;
          }
        } else if (block.type === "tool_use") {
          emitChunk(
            {
              tool_calls: [
                {
                  index: offset,
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  },
                },
              ],
            },
            null,
          );
          offset++;
        }
      }

      // Emit final chunk with finish reason
      emitChunk({}, mapStopReason(resp.stopReason));

      // Send [DONE] marker
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// GatewayRequest → OpenAI upstream request
// ---------------------------------------------------------------------------

export function buildOpenAIUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const apiKey = req.rawHeaders["x-api-key"];
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages: buildOpenAIMessages(req.messages, req.system),
    stream: req.stream,
  };

  if (req.maxTokens) {
    body.max_tokens = req.maxTokens;
  }

  // Add tools in OpenAI format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  // Forward extras
  if (req.extras) {
    if (req.extras.temperature !== undefined) {
      body.temperature = req.extras.temperature;
    }
    if (req.extras.top_p !== undefined) {
      body.top_p = req.extras.top_p;
    }
    if (req.extras.frequency_penalty !== undefined) {
      body.frequency_penalty = req.extras.frequency_penalty;
    }
    if (req.extras.presence_penalty !== undefined) {
      body.presence_penalty = req.extras.presence_penalty;
    }
    if (req.extras.user !== undefined) {
      body.user = req.extras.user;
    }
    if (req.extras.logprobs !== undefined) {
      body.logprobs = req.extras.logprobs;
    }
    if (req.extras.top_logprobs !== undefined) {
      body.top_logprobs = req.extras.top_logprobs;
    }
  }

  return {
    url: `${upstreamBase}/v1/chat/completions`,
    headers,
    body,
  };
}

function buildOpenAIMessages(
  messages: GatewayMessage[],
  system: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // Add system prompt if present
  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const blocks = msg.content;
    const role = msg.role;

    // Find text content and tool_use blocks
    const textParts: string[] = [];
    const toolUses: Array<Record<string, unknown>> = [];

    for (const block of blocks) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        // tool_result comes from previous assistant tool_use calls
        // It's typically attached to the user message as a tool result
      }
    }

    const msgRecord: Record<string, unknown> = { role };

    if (textParts.length > 0) {
      msgRecord.content = textParts.join("");
    }

    if (toolUses.length > 0) {
      msgRecord.tool_calls = toolUses;
    }

    result.push(msgRecord);
  }

  return result;
}