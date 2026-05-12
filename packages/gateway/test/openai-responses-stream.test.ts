/**
 * Tests for the OpenAI Responses API SSE stream accumulator.
 *
 * Covers:
 *  - Text output accumulation from delta events
 *  - Function call accumulation from arguments delta events
 *  - Usage extraction from response.completed
 *  - Stop reason mapping from status
 *  - Mixed text + function_call output
 */
import { describe, test, expect } from "bun:test";
import { accumulateResponsesSSEStream } from "../src/stream/openai-responses";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake SSE Response from event/data pairs. */
function buildSSEResponse(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): Response {
  const chunks = events.map(
    (e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
  );
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// accumulateResponsesSSEStream
// ---------------------------------------------------------------------------

describe("accumulateResponsesSSEStream", () => {
  test("accumulates text output from delta events", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_abc",
            model: "gpt-4o",
            status: "in_progress",
          },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Hello ",
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "world!",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Hello world!",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_abc",
            model: "gpt-4o",
            status: "completed",
            usage: {
              input_tokens: 15,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.id).toBe("resp_abc");
    expect(result.model).toBe("gpt-4o");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world!" });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(5);
  });

  test("accumulates function call from arguments delta", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_fc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "search",
            arguments: "",
          },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"query":',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '"cats"}',
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"query":"cats"}',
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_fc",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 20, output_tokens: 10 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
    const toolUse = result.content[0] as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };
    expect(toolUse.id).toBe("call_abc");
    expect(toolUse.name).toBe("search");
    expect(toolUse.input).toEqual({ query: "cats" });
    expect(result.stopReason).toBe("tool_use");
  });

  test("accumulates mixed text + function_call output", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_mix", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Let me search.",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Let me search.",
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_2",
            call_id: "call_xyz",
            name: "web_search",
            arguments: "",
          },
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          output_index: 1,
          arguments: '{"q":"test"}',
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_mix",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 30, output_tokens: 15 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Let me search.",
    });
    expect(result.content[1].type).toBe("tool_use");
    const toolUse = result.content[1] as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };
    expect(toolUse.id).toBe("call_xyz");
    expect(toolUse.name).toBe("web_search");
    expect(toolUse.input).toEqual({ q: "test" });
    expect(result.stopReason).toBe("tool_use");
  });

  test("maps incomplete status to max_tokens stop reason", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_inc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Truncated text...",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_inc",
            model: "gpt-4o",
            status: "incomplete",
            usage: { input_tokens: 10, output_tokens: 4096 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.stopReason).toBe("max_tokens");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Truncated text...",
    });
  });

  test("handles empty stream gracefully", async () => {
    const response = new Response("", {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await accumulateResponsesSSEStream(response);
    expect(result.content).toHaveLength(0);
    expect(result.id).toBe("");
    expect(result.model).toBe("");
  });

  test("handles [DONE] marker", async () => {
    const sse =
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_d", model: "gpt-4o", status: "in_progress" },
      })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_d",
          model: "gpt-4o",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n\n` +
      `data: [DONE]\n\n`;

    const response = new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await accumulateResponsesSSEStream(response);
    expect(result.id).toBe("resp_d");
    expect(result.model).toBe("gpt-4o");
  });

  test("prefers output_text.done over accumulated deltas", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_t", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "partial",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "final complete text",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_t",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "final complete text",
    });
  });

  test("captures prompt_tokens_details.cached_tokens as cacheReadInputTokens", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_cache", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Hello",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_cache",
            model: "gpt-4o",
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              prompt_tokens_details: {
                cached_tokens: 80,
              },
            },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.usage.cacheReadInputTokens).toBe(80);
  });

  test("cacheReadInputTokens is undefined when no cached_tokens in usage", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_nc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_nc",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 50, output_tokens: 5 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.cacheReadInputTokens).toBeUndefined();
  });
});
