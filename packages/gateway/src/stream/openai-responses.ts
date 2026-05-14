/**
 * OpenAI Responses API SSE stream accumulator.
 *
 * Parses upstream Responses API streaming events and accumulates the full
 * response into a `GatewayResponse`. The Responses API uses a different
 * SSE event lifecycle than Anthropic:
 *
 *   response.created → response.in_progress →
 *   response.output_item.added → response.output_text.delta (repeated) →
 *   response.output_item.done → response.function_call_arguments.delta →
 *   response.function_call_arguments.done →
 *   response.completed
 *
 * Reuses `parseSSEStream` from the Anthropic stream module since the
 * underlying SSE wire format is the same.
 */
import type {
  GatewayContentBlock,
  GatewayResponse,
  GatewayUsage,
} from "../translate/types";
import { parseSSEStream, createStreamAccumulator } from "./anthropic";

// ---------------------------------------------------------------------------
// Stream accumulator
// ---------------------------------------------------------------------------

/**
 * Accumulate an OpenAI Responses API SSE stream into a GatewayResponse.
 *
 * Consumes the upstream Response body and returns the accumulated result.
 */
export async function accumulateResponsesSSEStream(
  response: Response,
): Promise<GatewayResponse> {
  let id = "";
  let model = "";
  let stopReason = "end_turn";

  const usage: GatewayUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  /** Accumulating output items indexed by output_index. */
  const items = new Map<
    number,
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; callId: string; name: string; args: string }
  >();

  const reader = response.body!.getReader();

  for await (const { event, data } of parseSSEStream(reader)) {
    // Some Responses API implementations send untyped `data:` lines
    // without `event:` — skip those.
    if (!data || data === "[DONE]") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (event) {
      case "response.created":
      case "response.in_progress": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp) {
          if (typeof resp.id === "string") id = resp.id;
          if (typeof resp.model === "string") model = resp.model;
        }
        break;
      }

      case "response.output_item.added": {
        const outputIndex = parsed.output_index as number;
        const item = parsed.item as Record<string, unknown> | undefined;
        if (typeof outputIndex !== "number" || !item) break;

        if (item.type === "message") {
          items.set(outputIndex, { type: "text", text: "" });
        } else if (item.type === "function_call") {
          items.set(outputIndex, {
            type: "tool_use",
            id: String(item.id ?? ""),
            callId: String(item.call_id ?? ""),
            name: String(item.name ?? ""),
            args: "",
          });
        }
        break;
      }

      case "response.output_text.delta": {
        const outputIndex = parsed.output_index as number;
        const delta = parsed.delta as string | undefined;
        if (typeof outputIndex !== "number" || typeof delta !== "string") break;

        const item = items.get(outputIndex);
        if (item?.type === "text") {
          item.text += delta;
        }
        break;
      }

      case "response.output_text.done": {
        const outputIndex = parsed.output_index as number;
        const text = parsed.text as string | undefined;
        if (typeof outputIndex !== "number") break;

        const item = items.get(outputIndex);
        if (item?.type === "text" && typeof text === "string") {
          // Replace accumulated text with the final version (more reliable)
          item.text = text;
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const outputIndex = parsed.output_index as number;
        const delta = parsed.delta as string | undefined;
        if (typeof outputIndex !== "number" || typeof delta !== "string") break;

        const item = items.get(outputIndex);
        if (item?.type === "tool_use") {
          item.args += delta;
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const outputIndex = parsed.output_index as number;
        const args = parsed.arguments as string | undefined;
        if (typeof outputIndex !== "number") break;

        const item = items.get(outputIndex);
        if (item?.type === "tool_use" && typeof args === "string") {
          item.args = args;
        }
        break;
      }

      case "response.completed": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp) {
          if (typeof resp.id === "string") id = resp.id;
          if (typeof resp.model === "string") model = resp.model;
          if (typeof resp.status === "string") {
            stopReason = mapStatusToStopReason(resp.status);
          }

          const respUsage = resp.usage as Record<string, unknown> | undefined;
          if (respUsage) {
            if (typeof respUsage.input_tokens === "number") {
              usage.inputTokens = respUsage.input_tokens;
            }
            if (typeof respUsage.output_tokens === "number") {
              usage.outputTokens = respUsage.output_tokens as number;
            }
            const promptDetails = respUsage.prompt_tokens_details as Record<string, number> | undefined;
            if (promptDetails?.cached_tokens !== undefined) {
              usage.cacheReadInputTokens = promptDetails.cached_tokens;
            }
          }
        }
        break;
      }

      // Other events (response.output_item.done, response.content_part.*,
      // response.reasoning_summary_*, etc.) — ignored for accumulation
    }
  }

  // Build content blocks from accumulated items, sorted by output_index
  const content: GatewayContentBlock[] = [];
  const sortedIndices = Array.from(items.keys()).sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const item = items.get(index)!;
    if (item.type === "text") {
      if (item.text) {
        content.push({ type: "text", text: item.text });
      }
    } else if (item.type === "tool_use") {
      let input: unknown = {};
      if (item.args) {
        try {
          input = JSON.parse(item.args);
        } catch {
          input = item.args;
        }
      }
      content.push({
        type: "tool_use",
        id: item.callId || item.id,
        name: item.name,
        input,
      });
    }
  }

  // If we saw tool_use, map stop reason accordingly
  if (content.some((b) => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  return { id, model, content, stopReason, usage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStatusToStopReason(status: string): string {
  switch (status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return "max_tokens";
    case "cancelled":
      return "stop";
    case "failed":
      return "stop";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Anthropic SSE → OpenAI Responses API SSE streaming translator
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic SSE streaming Response into an OpenAI Responses API
 * SSE streaming Response.
 *
 * Anthropic lifecycle:
 *   message_start → content_block_start → content_block_delta (repeated)
 *   → content_block_stop → message_delta → message_stop
 *
 * Responses API lifecycle:
 *   response.created → response.in_progress →
 *   response.output_item.added → response.content_part.added →
 *   response.output_text.delta (repeated) → response.output_text.done →
 *   response.content_part.done → response.output_item.done →
 *   response.completed
 *
 * The returned Response streams Responses API named SSE events incrementally
 * as upstream Anthropic events arrive.
 */
export function translateAnthropicStreamToResponses(
  anthropicResponse: Response,
): Response {
  const encoder = new TextEncoder();
  // Reuse the Anthropic accumulator internally so we get a complete
  // GatewayResponse for the final `response.completed` event.
  const accumulator = createStreamAccumulator();

  // State extracted from message_start
  let respId = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);

  // Output item tracking
  let outputIndex = 0;

  /** Maps Anthropic block index → output-level tracking info. */
  type OutputItem =
    | { kind: "text"; itemId: string; outputIndex: number; text: string }
    | {
        kind: "tool_use";
        itemId: string;
        outputIndex: number;
        callId: string;
        name: string;
        args: string;
      };

  const outputItems = new Map<number, OutputItem>();
  let cancelled = false;

  function emit(eventType: string, data: Record<string, unknown>): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function safeEnqueue(chunk: Uint8Array): boolean {
        if (cancelled) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      }

      try {
        const reader = anthropicResponse.body!.getReader();

        for await (const { event, data } of parseSSEStream(reader)) {
          if (cancelled) break;

          // Always feed the accumulator
          accumulator.processEvent(event, data);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (event) {
            case "message_start": {
              const message = parsed.message as
                | Record<string, unknown>
                | undefined;
              if (message) {
                const rawId =
                  typeof message.id === "string" ? message.id : "";
                respId = rawId.startsWith("resp_")
                  ? rawId
                  : `resp_${rawId}`;
                model =
                  typeof message.model === "string" ? message.model : "";
                created = Math.floor(Date.now() / 1000);
              }

              // response.created
              safeEnqueue(
                encoder.encode(
                  emit("response.created", {
                    type: "response.created",
                    response: {
                      id: respId,
                      object: "response",
                      created_at: created,
                      model,
                      status: "in_progress",
                      output: [],
                      usage: null,
                    },
                  }),
                ),
              );

              // response.in_progress
              safeEnqueue(
                encoder.encode(
                  emit("response.in_progress", {
                    type: "response.in_progress",
                    response: {
                      id: respId,
                      object: "response",
                      created_at: created,
                      model,
                      status: "in_progress",
                      output: [],
                      usage: null,
                    },
                  }),
                ),
              );
              break;
            }

            case "content_block_start": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const block = parsed.content_block as
                | Record<string, unknown>
                | undefined;
              if (!block || typeof block.type !== "string") break;

              const currentOutputIndex = outputIndex++;

              if (block.type === "text") {
                const itemId = `msg_${respId}_${currentOutputIndex}`;
                outputItems.set(index, {
                  kind: "text",
                  itemId,
                  outputIndex: currentOutputIndex,
                  text: "",
                });

                // response.output_item.added
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: currentOutputIndex,
                      item: {
                        type: "message",
                        id: itemId,
                        role: "assistant",
                        status: "in_progress",
                        content: [],
                      },
                    }),
                  ),
                );

                // response.content_part.added
                safeEnqueue(
                  encoder.encode(
                    emit("response.content_part.added", {
                      type: "response.content_part.added",
                      item_id: itemId,
                      output_index: currentOutputIndex,
                      content_index: 0,
                      part: {
                        type: "output_text",
                        text: "",
                        annotations: [],
                      },
                    }),
                  ),
                );
              } else if (block.type === "tool_use") {
                const callId =
                  typeof block.id === "string" ? block.id : "";
                const name =
                  typeof block.name === "string" ? block.name : "";
                const itemId = `fc_${callId}`;
                outputItems.set(index, {
                  kind: "tool_use",
                  itemId,
                  outputIndex: currentOutputIndex,
                  callId,
                  name,
                  args: "",
                });

                // response.output_item.added
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: currentOutputIndex,
                      item: {
                        type: "function_call",
                        id: itemId,
                        call_id: callId,
                        name,
                        arguments: "",
                        status: "in_progress",
                      },
                    }),
                  ),
                );
              }
              // thinking blocks: not represented in Responses API — skip
              break;
            }

            case "content_block_delta": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const delta = parsed.delta as
                | Record<string, unknown>
                | undefined;
              if (!delta || typeof delta.type !== "string") break;

              const item = outputItems.get(index);
              if (!item) break;

              if (
                delta.type === "text_delta" &&
                typeof delta.text === "string" &&
                item.kind === "text"
              ) {
                item.text += delta.text;

                // response.output_text.delta
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_text.delta", {
                      type: "response.output_text.delta",
                      item_id: item.itemId,
                      output_index: item.outputIndex,
                      content_index: 0,
                      delta: delta.text,
                    }),
                  ),
                );
              } else if (
                delta.type === "input_json_delta" &&
                typeof delta.partial_json === "string" &&
                item.kind === "tool_use"
              ) {
                item.args += delta.partial_json;

                // response.function_call_arguments.delta
                safeEnqueue(
                  encoder.encode(
                    emit("response.function_call_arguments.delta", {
                      type: "response.function_call_arguments.delta",
                      item_id: item.itemId,
                      output_index: item.outputIndex,
                      delta: delta.partial_json,
                    }),
                  ),
                );
              }
              break;
            }

            case "content_block_stop": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const item = outputItems.get(index);
              if (!item) break;

              if (item.kind === "text") {
                // response.output_text.done
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_text.done", {
                      type: "response.output_text.done",
                      item_id: item.itemId,
                      output_index: item.outputIndex,
                      content_index: 0,
                      text: item.text,
                    }),
                  ),
                );

                // response.content_part.done
                safeEnqueue(
                  encoder.encode(
                    emit("response.content_part.done", {
                      type: "response.content_part.done",
                      item_id: item.itemId,
                      output_index: item.outputIndex,
                      content_index: 0,
                      part: {
                        type: "output_text",
                        text: item.text,
                        annotations: [],
                      },
                    }),
                  ),
                );

                // response.output_item.done
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_item.done", {
                      type: "response.output_item.done",
                      output_index: item.outputIndex,
                      item: {
                        type: "message",
                        id: item.itemId,
                        role: "assistant",
                        status: "completed",
                        content: [
                          {
                            type: "output_text",
                            text: item.text,
                            annotations: [],
                          },
                        ],
                      },
                    }),
                  ),
                );
              } else if (item.kind === "tool_use") {
                // response.function_call_arguments.done
                safeEnqueue(
                  encoder.encode(
                    emit("response.function_call_arguments.done", {
                      type: "response.function_call_arguments.done",
                      item_id: item.itemId,
                      output_index: item.outputIndex,
                      arguments: item.args,
                    }),
                  ),
                );

                // response.output_item.done
                safeEnqueue(
                  encoder.encode(
                    emit("response.output_item.done", {
                      type: "response.output_item.done",
                      output_index: item.outputIndex,
                      item: {
                        type: "function_call",
                        id: item.itemId,
                        call_id: item.callId,
                        name: item.name,
                        arguments: item.args,
                        status: "completed",
                      },
                    }),
                  ),
                );
              }
              break;
            }

            case "message_delta": {
              // Stop reason is captured by the accumulator — we use it
              // in message_stop to build the final response.completed event.
              break;
            }

            case "message_stop": {
              // Build the final response.completed from the accumulator
              const resp = accumulator.getResponse();

              const finalOutput: Array<Record<string, unknown>> = [];
              for (const block of resp.content) {
                if (block.type === "text") {
                  finalOutput.push({
                    type: "message",
                    id: `msg_${respId}_${finalOutput.length}`,
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: block.text,
                        annotations: [],
                      },
                    ],
                  });
                } else if (block.type === "tool_use") {
                  finalOutput.push({
                    type: "function_call",
                    id: `fc_${block.id}`,
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                    status: "completed",
                  });
                }
              }

              const finalStatus = mapStatusFromStopReason(resp.stopReason);

              const usageData: Record<string, unknown> = {
                input_tokens: resp.usage.inputTokens,
                output_tokens: resp.usage.outputTokens,
                total_tokens:
                  resp.usage.inputTokens + resp.usage.outputTokens,
              };
              if (resp.usage.cacheReadInputTokens != null) {
                usageData.prompt_tokens_details = {
                  cached_tokens: resp.usage.cacheReadInputTokens,
                };
              }

              safeEnqueue(
                encoder.encode(
                  emit("response.completed", {
                    type: "response.completed",
                    response: {
                      id: respId,
                      object: "response",
                      created_at: created,
                      model: resp.model,
                      status: finalStatus,
                      output: finalOutput,
                      usage: usageData,
                    },
                  }),
                ),
              );
              break;
            }

            // "ping" and unknown events — skip
          }
        }
      } catch (err) {
        console.error(
          "[lore] openai-responses stream translation error:",
          err,
        );
        // Emit a response.failed event so clients don't hang waiting
        try {
          controller.enqueue(
            encoder.encode(
              emit("response.failed", {
                type: "response.failed",
                response: {
                  id: respId || "resp_error",
                  object: "response",
                  created_at: created,
                  model,
                  status: "failed",
                  output: [],
                  usage: null,
                  error: {
                    type: "server_error",
                    message: err instanceof Error ? err.message : "upstream stream error",
                  },
                },
              }),
            ),
          );
        } catch {
          // Controller may already be closed
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },

    cancel() {
      // Client disconnected — cancel the upstream reader to stop wasting bandwidth
      cancelled = true;
      try {
        anthropicResponse.body?.cancel();
      } catch {
        // Best-effort cancellation
      }
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
// Internal helpers for the streaming translator
// ---------------------------------------------------------------------------

function mapStatusFromStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
    case "tool_use":
      return "completed";
    case "max_tokens":
    case "length":
      return "incomplete";
    default:
      return "completed";
  }
}
