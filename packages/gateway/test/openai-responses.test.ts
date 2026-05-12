/**
 * Tests for the OpenAI Responses API translator.
 *
 * Covers:
 *  - String/array input parsing
 *  - Upstream request round-trip
 *  - Response conversion (non-streaming and streaming)
 *  - Stop reason → status mapping
 *  - Extras passthrough (previous_response_id, reasoning, truncation)
 */
import { describe, test, expect } from "bun:test";
import {
  parseOpenAIResponsesRequest,
  buildOpenAIResponsesUpstreamRequest,
  buildOpenAIResponsesResponse,
} from "../src/translate/openai-responses";
import type { GatewayResponse } from "../src/translate/types";

// ---------------------------------------------------------------------------
// parseOpenAIResponsesRequest
// ---------------------------------------------------------------------------

describe("parseOpenAIResponsesRequest", () => {
  const headers = { "authorization": "Bearer sk-test123" };

  test("parses string input as single user message", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hello world", stream: false },
      headers,
    );
    expect(req.protocol).toBe("openai-responses");
    expect(req.model).toBe("gpt-4o");
    expect(req.stream).toBe(false);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  test("parses array input with message items", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "What is 2+2?" },
          {
            type: "message",
            role: "assistant",
            content: "4",
          },
          { type: "message", role: "user", content: "Thanks!" },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "What is 2+2?" },
    ]);
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toEqual([
      { type: "text", text: "4" },
    ]);
    expect(req.messages[2].role).toBe("user");
  });

  test("parses function_call and function_call_output items", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Search for cats" },
          {
            type: "function_call",
            call_id: "call_123",
            name: "search",
            arguments: '{"query":"cats"}',
          },
          {
            type: "function_call_output",
            call_id: "call_123",
            output: "Found 5 cats",
          },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(3);

    // User message
    expect(req.messages[0].role).toBe("user");

    // Function call → tool_use
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toEqual([
      {
        type: "tool_use",
        id: "call_123",
        name: "search",
        input: { query: "cats" },
      },
    ]);

    // Function output → tool_result
    expect(req.messages[2].role).toBe("user");
    expect(req.messages[2].content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_123",
        content: "Found 5 cats",
      },
    ]);
  });

  test("extracts instructions as system prompt", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        instructions: "You are a helpful assistant.",
        input: "Hi",
      },
      headers,
    );
    expect(req.system).toBe("You are a helpful assistant.");
  });

  test("parses tools in Responses API format", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
          {
            type: "web_search",
            name: "web_search",
          },
        ],
      },
      headers,
    );
    // Only function tools are parsed
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toEqual({
      name: "get_weather",
      description: "Get the weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    });
  });

  test("extracts max_output_tokens", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hi", max_output_tokens: 8192 },
      headers,
    );
    expect(req.maxTokens).toBe(8192);
  });

  test("defaults max_output_tokens to 4096", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hi" },
      headers,
    );
    expect(req.maxTokens).toBe(4096);
  });

  test("preserves Responses API extras", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hi",
        temperature: 0.7,
        previous_response_id: "resp_abc123",
        reasoning: { effort: "high" },
        truncation: "auto",
      },
      headers,
    );
    expect(req.extras?.temperature).toBe(0.7);
    expect(req.extras?.previous_response_id).toBe("resp_abc123");
    expect(req.extras?.reasoning).toEqual({ effort: "high" });
    expect(req.extras?.truncation).toBe("auto");
  });

  test("parses message with content array (input_text parts)", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Hello " },
              { type: "input_text", text: "world" },
            ],
          },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
  });

  test("handles messages without explicit type field", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { role: "user", content: "Hello" },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIResponsesUpstreamRequest
// ---------------------------------------------------------------------------

describe("buildOpenAIResponsesUpstreamRequest", () => {
  test("builds correct URL and body structure", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        instructions: "Be helpful",
        stream: true,
        max_output_tokens: 2048,
        temperature: 0.5,
      },
      { "authorization": "Bearer sk-test" },
    );

    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );

    expect(result.url).toBe("https://api.openai.com/v1/responses");
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["Authorization"]).toBe("Bearer sk-test");

    const body = result.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Be helpful");
    expect(body.max_output_tokens).toBe(2048);
    expect(body.temperature).toBe(0.5);
    expect(Array.isArray(body.input)).toBe(true);
  });

  test("round-trips tool definitions", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(req, "https://api.openai.com");
    const body = result.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("search");
    expect(tools[0].description).toBe("Search the web");
    expect(tools[0].parameters).toEqual({ type: "object", properties: {} });
  });

  test("forwards previous_response_id and reasoning", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        previous_response_id: "resp_abc",
        reasoning: { effort: "medium" },
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(req, "https://api.openai.com");
    const body = result.body as Record<string, unknown>;
    expect(body.previous_response_id).toBe("resp_abc");
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  test("reconstructs input items from gateway messages", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Search for cats" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"cats"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "cats found",
          },
        ],
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(req, "https://api.openai.com");
    const body = result.body as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;

    expect(input).toHaveLength(3);
    expect(input[0].type).toBe("message");
    expect(input[1].type).toBe("function_call");
    expect(input[1].call_id).toBe("call_1");
    expect(input[1].name).toBe("search");
    expect(input[2].type).toBe("function_call_output");
    expect(input[2].call_id).toBe("call_1");
    expect(input[2].output).toBe("cats found");
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIResponsesResponse
// ---------------------------------------------------------------------------

describe("buildOpenAIResponsesResponse", () => {
  const baseResponse: GatewayResponse = {
    id: "resp_test123",
    model: "gpt-4o",
    content: [{ type: "text", text: "Hello! How can I help?" }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 8,
    },
  };

  test("non-streaming: builds correct Responses API JSON", async () => {
    const response = buildOpenAIResponsesResponse(baseResponse, false);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("resp_test123");
    expect(body.object).toBe("response");
    expect(body.model).toBe("gpt-4o");
    expect(body.status).toBe("completed");

    const output = body.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("message");
    expect(output[0].role).toBe("assistant");

    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("output_text");
    expect(content[0].text).toBe("Hello! How can I help?");

    const usage = body.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(8);
    expect(usage.total_tokens).toBe(18);
  });

  test("non-streaming: tool_use maps to function_call output", async () => {
    const resp: GatewayResponse = {
      id: "test",
      model: "gpt-4o",
      content: [
        { type: "text", text: "Let me search." },
        {
          type: "tool_use",
          id: "call_abc",
          name: "search",
          input: { query: "cats" },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 10 },
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;

    expect(output).toHaveLength(2);
    // First: text message
    expect(output[0].type).toBe("message");
    // Second: function_call
    expect(output[1].type).toBe("function_call");
    expect(output[1].call_id).toBe("call_abc");
    expect(output[1].name).toBe("search");
    expect(output[1].arguments).toBe('{"query":"cats"}');
  });

  test("non-streaming: max_tokens maps to incomplete status", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      stopReason: "max_tokens",
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("incomplete");
  });

  test("non-streaming: id gets resp_ prefix if missing", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      id: "msg_123",
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("resp_msg_123");
  });

  test("streaming: produces Responses API SSE events", async () => {
    const response = buildOpenAIResponsesResponse(baseResponse, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const text = await response.text();
    // Should contain key event types
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.in_progress");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.output_text.done");
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain("event: response.completed");

    // Should contain the actual text
    expect(text).toContain("Hello! How can I help?");
  });

  test("streaming: tool_use produces function_call events", async () => {
    const resp: GatewayResponse = {
      id: "test",
      model: "gpt-4o",
      content: [
        {
          type: "tool_use",
          id: "call_abc",
          name: "search",
          input: { query: "cats" },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 10 },
    };

    const response = buildOpenAIResponsesResponse(resp, true);
    const text = await response.text();
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.function_call_arguments.done");
    expect(text).toContain('"name":"search"');
  });
});
