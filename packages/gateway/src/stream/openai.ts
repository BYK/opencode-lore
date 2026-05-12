/**
 * Anthropic SSE → OpenAI Chat Completions SSE streaming translator.
 *
 * Reads Anthropic-format SSE events from an upstream Response and emits
 * OpenAI Chat Completions streaming chunks incrementally, so the client
 * receives tokens as they arrive rather than waiting for the full response.
 *
 * Anthropic lifecycle:
 *   message_start → content_block_start → content_block_delta (repeated)
 *   → content_block_stop → message_delta → message_stop
 *
 * OpenAI Chat Completions streaming lifecycle:
 *   chunk with delta.role → chunk with delta.content (repeated)
 *   → chunk with finish_reason → data: [DONE]
 *
 * Uses `parseSSEStream` from the Anthropic stream module to parse upstream
 * events, and `createStreamAccumulator` to build the internal GatewayResponse
 * (for pipeline post-processing that may read it).
 */
import { parseSSEStream, createStreamAccumulator } from "./anthropic";

// ---------------------------------------------------------------------------
// Types for in-flight tool call tracking
// ---------------------------------------------------------------------------

/** Tracks a tool_use content block being streamed. */
type InflightToolCall = {
  /** Anthropic block index. */
  blockIndex: number;
  /** Tool call index in the OpenAI `tool_calls` array. */
  toolCallIndex: number;
  /** Tool use ID from Anthropic. */
  id: string;
  /** Function name. */
  name: string;
  /** Whether the initial chunk (with id+name) has been emitted. */
  headerEmitted: boolean;
};

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Streaming translator
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic SSE streaming Response into an OpenAI Chat
 * Completions SSE streaming Response.
 *
 * The returned Response streams OpenAI-format `data: {...}\n\n` lines
 * incrementally as upstream Anthropic events arrive.
 */
export function translateAnthropicStreamToOpenAI(
  anthropicResponse: Response,
): Response {
  const encoder = new TextEncoder();
  const accumulator = createStreamAccumulator();

  // State extracted from message_start
  let baseId = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let roleChunkEmitted = false;
  let finishReason = "";

  // Tool call tracking: blockIndex → InflightToolCall
  const toolCalls = new Map<number, InflightToolCall>();
  let nextToolCallIndex = 0;

  function formatChunk(
    delta: Record<string, unknown>,
    finish: string | null,
    usage?: Record<string, unknown>,
  ): string {
    const chunk: Record<string, unknown> = {
      id: baseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finish,
        },
      ],
    };
    if (usage) {
      chunk.usage = usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const reader = anthropicResponse.body!.getReader();

        for await (const { event, data } of parseSSEStream(reader)) {
          // Always feed the accumulator so we get a complete GatewayResponse
          accumulator.processEvent(event, data);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Non-JSON event (ping, etc.) — skip
            continue;
          }

          switch (event) {
            case "message_start": {
              const message = parsed.message as Record<string, unknown> | undefined;
              if (message) {
                const rawId = typeof message.id === "string" ? message.id : "";
                baseId = rawId.startsWith("chatcmpl-") ? rawId : `chatcmpl-${rawId}`;
                model = typeof message.model === "string" ? message.model : "";
                created = Math.floor(Date.now() / 1000);
              }

              // Emit the role chunk
              if (!roleChunkEmitted) {
                controller.enqueue(
                  encoder.encode(formatChunk({ role: "assistant" }, null)),
                );
                roleChunkEmitted = true;
              }
              break;
            }

            case "content_block_start": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const block = parsed.content_block as Record<string, unknown> | undefined;
              if (!block || typeof block.type !== "string") break;

              if (block.type === "tool_use") {
                // Register the tool call — emit the initial chunk with id+name
                const toolCallIndex = nextToolCallIndex++;
                const tc: InflightToolCall = {
                  blockIndex: index,
                  toolCallIndex,
                  id: typeof block.id === "string" ? block.id : "",
                  name: typeof block.name === "string" ? block.name : "",
                  headerEmitted: false,
                };
                toolCalls.set(index, tc);

                // Emit the tool call header chunk (id, type, function name)
                controller.enqueue(
                  encoder.encode(
                    formatChunk(
                      {
                        tool_calls: [
                          {
                            index: tc.toolCallIndex,
                            id: tc.id,
                            type: "function",
                            function: {
                              name: tc.name,
                              arguments: "",
                            },
                          },
                        ],
                      },
                      null,
                    ),
                  ),
                );
                tc.headerEmitted = true;
              }
              // text blocks: nothing to emit yet — wait for deltas
              // thinking blocks: not represented in OpenAI format — skip
              break;
            }

            case "content_block_delta": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const delta = parsed.delta as Record<string, unknown> | undefined;
              if (!delta || typeof delta.type !== "string") break;

              if (delta.type === "text_delta" && typeof delta.text === "string") {
                // Emit text content incrementally
                controller.enqueue(
                  encoder.encode(formatChunk({ content: delta.text }, null)),
                );
              } else if (
                delta.type === "input_json_delta" &&
                typeof delta.partial_json === "string"
              ) {
                // Stream tool call arguments incrementally
                const tc = toolCalls.get(index);
                if (tc) {
                  controller.enqueue(
                    encoder.encode(
                      formatChunk(
                        {
                          tool_calls: [
                            {
                              index: tc.toolCallIndex,
                              function: {
                                arguments: delta.partial_json,
                              },
                            },
                          ],
                        },
                        null,
                      ),
                    ),
                  );
                }
              }
              // thinking_delta, signature_delta: not in OpenAI format — skip
              break;
            }

            case "content_block_stop": {
              // No explicit emission needed for content_block_stop in OpenAI format.
              // Text blocks are already fully streamed via deltas.
              // Tool call arguments are already fully streamed via deltas.
              break;
            }

            case "message_delta": {
              const delta = parsed.delta as Record<string, unknown> | undefined;
              if (delta && typeof delta.stop_reason === "string") {
                finishReason = mapStopReason(delta.stop_reason);
              }
              break;
            }

            case "message_stop": {
              // Build usage from accumulator
              const resp = accumulator.getResponse();
              const usage: Record<string, unknown> = {
                prompt_tokens: resp.usage.inputTokens,
                completion_tokens: resp.usage.outputTokens,
                total_tokens: resp.usage.inputTokens + resp.usage.outputTokens,
              };
              if (resp.usage.cacheReadInputTokens != null) {
                usage.prompt_tokens_details = {
                  cached_tokens: resp.usage.cacheReadInputTokens,
                };
              }

              // Emit final chunk with finish_reason and usage
              controller.enqueue(
                encoder.encode(
                  formatChunk({}, finishReason || "stop", usage),
                ),
              );

              // Emit [DONE] sentinel
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              break;
            }

            // "ping" and unknown events — skip (already fed to accumulator)
          }
        }
      } catch (err) {
        // If upstream errors, try to close gracefully with [DONE]
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          // Controller may already be closed
        }
        console.error("[lore] openai stream translation error:", err);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
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
