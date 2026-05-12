/**
 * OpenAI Responses API ↔ Gateway translation layer.
 *
 * Converts between OpenAI's `/v1/responses` API format and the gateway's
 * internal `GatewayRequest`/`GatewayResponse` types.
 *
 * The Responses API uses a different message format than Chat Completions:
 *   - Input is an array of "input items" (message, function_call, function_call_output, etc.)
 *   - Output is an array of "output items" with similar structure
 *   - System prompt is in the `instructions` field
 *   - Tools use `parameters` directly (not wrapped in `function`)
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
} from "./types";
import { extractAuth } from "../auth";

// ---------------------------------------------------------------------------
// OpenAI Responses API → GatewayRequest
// ---------------------------------------------------------------------------

export function parseOpenAIResponsesRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  const model = String(raw.model ?? "");
  const stream = raw.stream === true;

  // max_output_tokens defaults to 4096 if not specified
  const maxTokens =
    typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 4096;

  // System prompt comes from `instructions`
  const system = typeof raw.instructions === "string" ? raw.instructions : "";

  // Parse input items into normalized messages
  const messages = parseInputItems(raw.input);

  // Parse tools
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools
    .filter((t: Record<string, unknown>) => t.type === "function")
    .map((t: Record<string, unknown>) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema: (t.parameters as Record<string, unknown>) ?? {},
    }));

  // Extract extras for passthrough
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
  // Responses API-specific extras
  if (raw.previous_response_id !== undefined) {
    extras.previous_response_id = raw.previous_response_id as string;
  }
  if (raw.reasoning !== undefined) {
    extras.reasoning = raw.reasoning;
  }
  if (raw.truncation !== undefined) {
    extras.truncation = raw.truncation;
  }

  return {
    protocol: "openai-responses",
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

// ---------------------------------------------------------------------------
// Input item parsing
// ---------------------------------------------------------------------------

function parseInputItems(input: unknown): GatewayMessage[] {
  // String shorthand: single user message
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }

  if (!Array.isArray(input)) return [];

  const messages: GatewayMessage[] = [];

  for (const item of input as Array<Record<string, unknown>>) {
    const itemType = item.type as string | undefined;
    const role = item.role as string | undefined;

    if (itemType === "message" || (!itemType && role)) {
      // Message item — has role + content
      const msgRole = (role === "assistant" || role === "developer" || role === "system")
        ? role
        : "user";

      const content = parseMessageContent(item.content);

      if (msgRole === "developer" || msgRole === "system") {
        // developer/system messages in input array are treated as user messages
        // with the system content (the real system prompt is in `instructions`)
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      } else if (msgRole === "assistant") {
        messages.push({ role: "assistant", content });
      } else {
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      }
      continue;
    }

    if (itemType === "function_call") {
      // Function call from assistant — maps to tool_use
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: String(item.call_id ?? item.id ?? ""),
            name: String(item.name ?? ""),
            input: parseArguments(item.arguments),
          },
        ],
      });
      continue;
    }

    if (itemType === "function_call_output") {
      // Function output — maps to tool_result
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: String(item.call_id ?? ""),
            content: String(item.output ?? ""),
          },
        ],
      });
      continue;
    }

    // Other item types (reasoning, item_reference, etc.) — skip
  }

  return messages;
}

function parseMessageContent(content: unknown): GatewayContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const blocks: GatewayContentBlock[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      const text = String(part.text ?? "");
      if (text) blocks.push({ type: "text", text });
    }
  }
  return blocks;
}

function parseArguments(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args ?? {};
}

// ---------------------------------------------------------------------------
// GatewayRequest → OpenAI Responses API upstream request
// ---------------------------------------------------------------------------

export function buildOpenAIResponsesUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  // Forward auth — Responses API uses Bearer
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    headers["Authorization"] = `Bearer ${cred.value}`;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    stream: req.stream,
  };

  if (req.maxTokens) {
    body.max_output_tokens = req.maxTokens;
  }

  // System prompt → instructions
  if (req.system) {
    body.instructions = req.system;
  }

  // Build input items from normalized messages
  body.input = buildResponsesInput(req.messages);

  // Add tools in Responses API format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
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
    if (req.extras.previous_response_id !== undefined) {
      body.previous_response_id = req.extras.previous_response_id;
    }
    if (req.extras.reasoning !== undefined) {
      body.reasoning = req.extras.reasoning;
    }
    if (req.extras.truncation !== undefined) {
      body.truncation = req.extras.truncation;
    }
  }

  return {
    url: `${upstreamBase}/v1/responses`,
    headers,
    body,
  };
}

function buildResponsesInput(
  messages: GatewayMessage[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        items.push({
          type: "message",
          role: msg.role === "assistant" ? "assistant" : "user",
          content: [{ type: msg.role === "assistant" ? "output_text" : "input_text", text: block.text }],
        });
      } else if (block.type === "tool_use") {
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        items.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// GatewayResponse → OpenAI Responses API response
// ---------------------------------------------------------------------------

export function buildOpenAIResponsesResponse(
  resp: GatewayResponse,
  wasStreaming: boolean,
): Response {
  if (wasStreaming) {
    return buildOpenAIResponsesStreamResponse(resp);
  }
  return buildOpenAIResponsesNonStreamResponse(resp);
}

function buildOpenAIResponsesNonStreamResponse(resp: GatewayResponse): Response {
  const output: Array<Record<string, unknown>> = [];
  let textContent = "";
  const functionCalls: Array<Record<string, unknown>> = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      functionCalls.push({
        type: "function_call",
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      });
    }
  }

  if (textContent) {
    output.push({
      type: "message",
      id: `msg_${resp.id}`,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: textContent,
          annotations: [],
        },
      ],
    });
  }

  output.push(...functionCalls);

  const response = {
    id: resp.id.startsWith("resp_") ? resp.id : `resp_${resp.id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: resp.model,
    status: mapStopReasonToStatus(resp.stopReason),
    output,
    usage: {
      input_tokens: resp.usage.inputTokens,
      output_tokens: resp.usage.outputTokens,
      total_tokens: resp.usage.inputTokens + resp.usage.outputTokens,
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mapStopReasonToStatus(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "completed";
    case "max_tokens":
    case "length":
      return "incomplete";
    case "tool_use":
      return "completed";
    default:
      return "completed";
  }
}

function buildOpenAIResponsesStreamResponse(resp: GatewayResponse): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const respId = resp.id.startsWith("resp_") ? resp.id : `resp_${resp.id}`;
      const created = Math.floor(Date.now() / 1000);

      function emit(eventType: string, data: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }

      // response.created
      emit("response.created", {
        type: "response.created",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      });

      // response.in_progress
      emit("response.in_progress", {
        type: "response.in_progress",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      });

      let outputIndex = 0;

      // Process content blocks
      for (const block of resp.content) {
        if (block.type === "text") {
          const itemId = `msg_${respId}_${outputIndex}`;

          // output_item.added
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
              type: "message",
              id: itemId,
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          });

          // content_part.added
          emit("response.content_part.added", {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });

          // output_text.delta — emit text in chunks
          const text = block.text;
          let pos = 0;
          while (pos < text.length) {
            const chunk = text.slice(pos, pos + 50);
            emit("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              delta: chunk,
            });
            pos += 50;
          }

          // output_text.done
          emit("response.output_text.done", {
            type: "response.output_text.done",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            text: block.text,
          });

          // content_part.done
          emit("response.content_part.done", {
            type: "response.content_part.done",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: {
              type: "output_text",
              text: block.text,
              annotations: [],
            },
          });

          // output_item.done
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: {
              type: "message",
              id: itemId,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: block.text,
                  annotations: [],
                },
              ],
            },
          });

          outputIndex++;
        } else if (block.type === "tool_use") {
          const callId = block.id;
          const itemId = `fc_${callId}`;
          const args = JSON.stringify(block.input);

          // output_item.added
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: block.name,
              arguments: "",
              status: "in_progress",
            },
          });

          // function_call_arguments.delta
          emit("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: itemId,
            output_index: outputIndex,
            delta: args,
          });

          // function_call_arguments.done
          emit("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: outputIndex,
            arguments: args,
          });

          // output_item.done
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: block.name,
              arguments: args,
              status: "completed",
            },
          });

          outputIndex++;
        }
      }

      // response.completed
      emit("response.completed", {
        type: "response.completed",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status: mapStopReasonToStatus(resp.stopReason),
          output: resp.content
            .map((block, i) => {
              if (block.type === "text") {
                return {
                  type: "message",
                  id: `msg_${respId}_${i}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: block.text, annotations: [] }],
                };
              }
              if (block.type === "tool_use") {
                return {
                  type: "function_call",
                  id: `fc_${block.id}`,
                  call_id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                  status: "completed",
                };
              }
              return null;
            })
            .filter(Boolean),
          usage: {
            input_tokens: resp.usage.inputTokens,
            output_tokens: resp.usage.outputTokens,
            total_tokens: resp.usage.inputTokens + resp.usage.outputTokens,
          },
        },
      });

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
