/**
 * Unit tests for gateway recall interception helpers.
 *
 * Tests the pure functions in recall.ts:
 *  - Tool definition
 *  - Detection helpers (findRecallToolUse, hasRecallToolUse, hasOtherToolUse)
 *  - Follow-up request builder
 *  - Pending recall injection
 *  - Response stripping
 */
import { describe, test, expect } from "bun:test";
import {
  RECALL_GATEWAY_TOOL,
  RECALL_TOOL_NAME,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  isPendingRecallValid,
  buildRecallFollowUp,
  injectPendingRecall,
  stripRecallFromResponse,
} from "../src/recall";
import type {
  GatewayResponse,
  GatewayRequest,
  GatewayToolUseBlock,
  PendingRecall,
} from "../src/translate/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeResponse(
  content: GatewayResponse["content"],
  stopReason = "end_turn",
): GatewayResponse {
  return {
    id: "msg_test",
    model: "claude-sonnet-4-20250514",
    content,
    stopReason,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function makeRequest(
  messages: GatewayRequest["messages"] = [],
  tools: GatewayRequest["tools"] = [],
): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-sonnet-4-20250514",
    system: "test system",
    messages,
    tools,
    stream: true,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {},
  };
}

function makeRecallToolUse(
  query = "test query",
  scope = "all",
  id = "toolu_recall_1",
): GatewayToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: RECALL_TOOL_NAME,
    input: { query, scope },
  };
}

function makePendingRecall(
  overrides: Partial<PendingRecall> = {},
): PendingRecall {
  return {
    toolUseId: "toolu_recall_1",
    input: { query: "test query", scope: "all" },
    position: 1,
    result: "## Recall Results\n* some result",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("RECALL_GATEWAY_TOOL", () => {
  test("has correct name and schema", () => {
    expect(RECALL_GATEWAY_TOOL.name).toBe("recall");
    expect(RECALL_GATEWAY_TOOL.description).toBeTruthy();
    const schema = RECALL_GATEWAY_TOOL.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("scope");
    expect(schema.required).toEqual(["query"]);
  });
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

describe("findRecallToolUse", () => {
  test("finds recall block in response", () => {
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([
      { type: "text", text: "hello" },
      recallBlock,
    ]);
    expect(findRecallToolUse(resp)).toBe(recallBlock);
  });

  test("returns undefined when no recall", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
    ]);
    expect(findRecallToolUse(resp)).toBeUndefined();
  });

  test("returns undefined for empty response", () => {
    const resp = makeResponse([]);
    expect(findRecallToolUse(resp)).toBeUndefined();
  });
});

describe("hasRecallToolUse", () => {
  test("returns true when recall present", () => {
    const resp = makeResponse([makeRecallToolUse()]);
    expect(hasRecallToolUse(resp)).toBe(true);
  });

  test("returns false when no recall", () => {
    const resp = makeResponse([{ type: "text", text: "hello" }]);
    expect(hasRecallToolUse(resp)).toBe(false);
  });
});

describe("hasOtherToolUse", () => {
  test("returns true when non-recall tools present", () => {
    const resp = makeResponse([
      makeRecallToolUse(),
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);
    expect(hasOtherToolUse(resp)).toBe(true);
  });

  test("returns false when only recall present", () => {
    const resp = makeResponse([
      { type: "text", text: "let me search" },
      makeRecallToolUse(),
    ]);
    expect(hasOtherToolUse(resp)).toBe(false);
  });

  test("returns false when no tools at all", () => {
    const resp = makeResponse([{ type: "text", text: "hello" }]);
    expect(hasOtherToolUse(resp)).toBe(false);
  });
});

describe("clientHasRecallTool", () => {
  test("returns true when client has recall tool", () => {
    expect(
      clientHasRecallTool([
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "recall", description: "Search memory", inputSchema: {} },
      ]),
    ).toBe(true);
  });

  test("returns false when client has no recall tool", () => {
    expect(
      clientHasRecallTool([
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "Bash", description: "Run command", inputSchema: {} },
      ]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pending recall TTL
// ---------------------------------------------------------------------------

describe("isPendingRecallValid", () => {
  test("returns true for fresh pending recall", () => {
    const pending = makePendingRecall({ timestamp: Date.now() });
    expect(isPendingRecallValid(pending)).toBe(true);
  });

  test("returns false for expired pending recall", () => {
    const pending = makePendingRecall({
      timestamp: Date.now() - 120_000, // 2 minutes ago
    });
    expect(isPendingRecallValid(pending)).toBe(false);
  });

  test("returns true for recall just within TTL", () => {
    const pending = makePendingRecall({
      timestamp: Date.now() - 50_000, // 50 seconds ago (TTL is 60s)
    });
    expect(isPendingRecallValid(pending)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRecallFollowUp
// ---------------------------------------------------------------------------

describe("buildRecallFollowUp", () => {
  test("builds correct follow-up request structure", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [
        { name: "Read", description: "Read", inputSchema: {} },
        { name: "recall", description: "Recall", inputSchema: {} },
      ],
    );

    const recallBlock = makeRecallToolUse("find config");
    const resp = makeResponse(
      [{ type: "text", text: "Let me search." }, recallBlock],
      "tool_use",
    );

    const followUp = buildRecallFollowUp(
      req,
      resp,
      "## Recall Results\n* config is in /root",
      recallBlock,
    );

    // Original messages + assistant + tool_result
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[0].role).toBe("user");
    expect(followUp.messages[1].role).toBe("assistant");
    expect(followUp.messages[2].role).toBe("user");

    // Assistant message contains ONLY the recall tool_use (pre-recall text excluded)
    expect(followUp.messages[1].content).toHaveLength(1);
    expect(followUp.messages[1].content[0]).toBe(recallBlock);

    // User message contains tool_result
    const toolResult = followUp.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect((toolResult as { toolUseId: string }).toolUseId).toBe(
      recallBlock.id,
    );

    // Tools list should NOT include recall
    expect(followUp.tools).toHaveLength(1);
    expect(followUp.tools[0].name).toBe("Read");
  });

  test("preserves other request properties", () => {
    const req = makeRequest();
    req.system = "my system prompt";
    req.model = "claude-opus-4";
    req.stream = false;

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const followUp = buildRecallFollowUp(req, resp, "result", recallBlock);

    expect(followUp.system).toBe("my system prompt");
    expect(followUp.model).toBe("claude-opus-4");
    expect(followUp.stream).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectPendingRecall
// ---------------------------------------------------------------------------

describe("injectPendingRecall", () => {
  test("injects recall into assistant→user pair", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_1", content: "file content" },
        ],
      },
    ]);

    const pending = makePendingRecall({ position: 1 });
    const result = injectPendingRecall(req, pending);

    expect(result).toBe(true);

    // Assistant message should now have recall tool_use at position 1
    const assistant = req.messages[1];
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe("recall");

    // User message should have recall tool_result prepended
    const user = req.messages[2];
    expect(user.content).toHaveLength(2);
    expect(user.content[0].type).toBe("tool_result");
    expect((user.content[0] as { toolUseId: string }).toolUseId).toBe(
      pending.toolUseId,
    );
  });

  test("clamps position to content length", () => {
    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "thanks" }],
      },
    ]);

    const pending = makePendingRecall({ position: 99 }); // Way beyond content length
    const result = injectPendingRecall(req, pending);

    expect(result).toBe(true);
    // Should be appended at the end
    const assistant = req.messages[0];
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[1].type).toBe("tool_use");
  });

  test("returns false when no assistant→user pair", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const pending = makePendingRecall();
    expect(injectPendingRecall(req, pending)).toBe(false);
  });

  test("returns false with too few messages", () => {
    const req = makeRequest([]);
    const pending = makePendingRecall();
    expect(injectPendingRecall(req, pending)).toBe(false);
  });

  test("strips recall from tools list", () => {
    const req = makeRequest(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "thanks" }],
        },
      ],
      [
        { name: "Read", description: "Read", inputSchema: {} },
        { name: "recall", description: "Recall", inputSchema: {} },
      ],
    );

    const pending = makePendingRecall();
    injectPendingRecall(req, pending);

    expect(req.tools).toHaveLength(1);
    expect(req.tools[0].name).toBe("Read");
  });
});

// ---------------------------------------------------------------------------
// stripRecallFromResponse
// ---------------------------------------------------------------------------

describe("stripRecallFromResponse", () => {
  test("removes recall tool_use blocks", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      makeRecallToolUse(),
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const stripped = stripRecallFromResponse(resp);
    expect(stripped.content).toHaveLength(2);
    expect(stripped.content[0].type).toBe("text");
    expect(stripped.content[1].type).toBe("tool_use");
    expect((stripped.content[1] as GatewayToolUseBlock).name).toBe("Read");
  });

  test("returns same content when no recall present", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const stripped = stripRecallFromResponse(resp);
    expect(stripped.content).toHaveLength(2);
  });

  test("does not mutate original response", () => {
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const stripped = stripRecallFromResponse(resp);
    expect(resp.content).toHaveLength(1);
    expect(stripped.content).toHaveLength(0);
  });

  test("preserves non-content fields", () => {
    const resp = makeResponse([makeRecallToolUse()]);
    resp.usage.inputTokens = 999;

    const stripped = stripRecallFromResponse(resp);
    expect(stripped.id).toBe(resp.id);
    expect(stripped.model).toBe(resp.model);
    expect(stripped.stopReason).toBe(resp.stopReason);
    expect(stripped.usage.inputTokens).toBe(999);
  });
});
