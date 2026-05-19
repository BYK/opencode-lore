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
  MAX_RECALL_DEPTH,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  buildRecallFollowUp,
  buildRecallMarker,
  parseRecallMarker,
  isRecallMarker,
  scopeToLabel,
  labelToScope,
  recallStoreKey,
  expandRecallMarkers,
  cleanupRecallStore,
  replaceRecallWithMarker,
} from "../src/recall";
import type {
  GatewayResponse,
  GatewayRequest,
  GatewayToolUseBlock,
  RecallStore,
  StoredRecall,
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

function makeStoredRecall(
  overrides: Partial<StoredRecall> = {},
): StoredRecall {
  return {
    toolUseId: "toolu_recall_1",
    input: { query: "test query", scope: "all" },
    position: 1,
    result: "## Recall Results\n* some result",
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

describe("MAX_RECALL_DEPTH", () => {
  test("is a positive integer safety-net cap", () => {
    expect(MAX_RECALL_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_RECALL_DEPTH)).toBe(true);
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
// Marker utilities
// ---------------------------------------------------------------------------

describe("scopeToLabel / labelToScope", () => {
  test("maps all scopes to labels", () => {
    expect(scopeToLabel("all")).toBe("all archives");
    expect(scopeToLabel("session")).toBe("session history");
    expect(scopeToLabel("project")).toBe("project archives");
    expect(scopeToLabel("knowledge")).toBe("knowledge base");
  });

  test("defaults unknown scope to 'all archives'", () => {
    expect(scopeToLabel("unknown")).toBe("all archives");
    expect(scopeToLabel()).toBe("all archives");
  });

  test("reverse maps labels back to scopes", () => {
    expect(labelToScope("all archives")).toBe("all");
    expect(labelToScope("session history")).toBe("session");
    expect(labelToScope("project archives")).toBe("project");
    expect(labelToScope("knowledge base")).toBe("knowledge");
  });

  test("defaults unknown label to 'all'", () => {
    expect(labelToScope("unknown label")).toBe("all");
  });
});

describe("buildRecallMarker", () => {
  test("builds correct marker with default scope", () => {
    expect(buildRecallMarker("test query")).toBe(
      '📚 Searching all archives for "test query"…',
    );
  });

  test("builds correct marker with explicit scope", () => {
    expect(buildRecallMarker("auth flow", "session")).toBe(
      '📚 Searching session history for "auth flow"…',
    );
    expect(buildRecallMarker("config", "project")).toBe(
      '📚 Searching project archives for "config"…',
    );
    expect(buildRecallMarker("patterns", "knowledge")).toBe(
      '📚 Searching knowledge base for "patterns"…',
    );
  });
});

describe("parseRecallMarker", () => {
  test("parses a valid marker", () => {
    const result = parseRecallMarker(
      '📚 Searching all archives for "gradient cache"…',
    );
    expect(result).toEqual({ query: "gradient cache", scope: "all" });
  });

  test("parses markers with different scopes", () => {
    expect(
      parseRecallMarker('📚 Searching session history for "auth"…'),
    ).toEqual({ query: "auth", scope: "session" });
    expect(
      parseRecallMarker('📚 Searching project archives for "config"…'),
    ).toEqual({ query: "config", scope: "project" });
    expect(
      parseRecallMarker('📚 Searching knowledge base for "patterns"…'),
    ).toEqual({ query: "patterns", scope: "knowledge" });
  });

  test("returns null for non-marker text", () => {
    expect(parseRecallMarker("hello world")).toBeNull();
    expect(parseRecallMarker("[Searching memory...]")).toBeNull();
    expect(parseRecallMarker("")).toBeNull();
  });
});

describe("isRecallMarker", () => {
  test("detects search markers", () => {
    expect(isRecallMarker('📚 Searching all archives for "test query"…')).toBe(true);
    expect(isRecallMarker('📚 Searching session history for "auth"…')).toBe(true);
    expect(isRecallMarker('📚 Searching project archives for "config"…')).toBe(true);
    expect(isRecallMarker('📚 Searching knowledge base for "patterns"…')).toBe(true);
  });

  test("detects id-based detail markers", () => {
    expect(isRecallMarker("📚 Fetching detail for k:abc123…")).toBe(true);
    expect(isRecallMarker("📚 Fetching detail for d:019abc…")).toBe(true);
  });

  test("rejects non-marker text", () => {
    expect(isRecallMarker("hello world")).toBe(false);
    expect(isRecallMarker("[Searching memory...]")).toBe(false);
    expect(isRecallMarker("")).toBe(false);
    expect(isRecallMarker("📚 Some other text")).toBe(false);
  });
});

describe("recallStoreKey", () => {
  test("creates key from query and scope", () => {
    expect(recallStoreKey("test", "all")).toBe("all:test");
    expect(recallStoreKey("test", "session")).toBe("session:test");
  });

  test("defaults scope to all", () => {
    expect(recallStoreKey("test")).toBe("all:test");
  });
});

// ---------------------------------------------------------------------------
// buildRecallFollowUp
// ---------------------------------------------------------------------------

describe("buildRecallFollowUp", () => {
  test("builds correct follow-up request structure with text blocks", () => {
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

    // Original messages + assistant (marker text) + user (recall results as text)
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[0].role).toBe("user");
    expect(followUp.messages[1].role).toBe("assistant");
    expect(followUp.messages[2].role).toBe("user");

    // Assistant message contains a marker text block (not tool_use)
    expect(followUp.messages[1].content).toHaveLength(1);
    expect(followUp.messages[1].content[0].type).toBe("text");
    expect((followUp.messages[1].content[0] as { text: string }).text).toContain(
      "find config",
    );

    // User message contains recall results as plain text (not tool_result)
    const resultBlock = followUp.messages[2].content[0];
    expect(resultBlock.type).toBe("text");
    expect((resultBlock as { text: string }).text).toBe(
      "## Recall Results\n* config is in /root",
    );

    // Tools list keeps recall — the continuation is recall-aware and
    // can handle further recall calls (multi-turn recall).
    expect(followUp.tools).toHaveLength(2);
    expect(followUp.tools.map((t) => t.name).sort()).toEqual(["Read", "recall"]);
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

  test("preserves thinking blocks in assistant message for extended thinking", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [
        { name: "Read", description: "Read", inputSchema: {} },
        { name: "recall", description: "Recall", inputSchema: {} },
      ],
    );

    const recallBlock = makeRecallToolUse("find config");
    const resp = makeResponse(
      [
        { type: "thinking", thinking: "Let me search for config info...", signature: "sig_abc123" },
        { type: "text", text: "Let me search." },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUp(
      req,
      resp,
      "## Recall Results\n* config is in /root",
      recallBlock,
    );

    // Assistant message should contain thinking block + marker text
    const assistant = followUp.messages[1];
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("thinking");
    expect((assistant.content[0] as { thinking: string }).thinking).toBe(
      "Let me search for config info...",
    );
    expect((assistant.content[0] as { signature: string }).signature).toBe(
      "sig_abc123",
    );
    expect(assistant.content[1].type).toBe("text");
    expect((assistant.content[1] as { text: string }).text).toContain("find config");
  });

  test("excludes text blocks but keeps thinking blocks", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [
        { type: "thinking", thinking: "reasoning...", signature: "sig_1" },
        { type: "text", text: "Some pre-recall text" },
        { type: "text", text: "More text" },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUp(req, resp, "result", recallBlock);

    const assistant = followUp.messages[1];
    // Only thinking + marker text — original text blocks excluded
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("thinking");
    expect(assistant.content[1].type).toBe("text");
    expect((assistant.content[1] as { text: string }).text).toContain("test query");
  });

  test("handles multiple thinking blocks", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [
        { type: "thinking", thinking: "first thought", signature: "sig_1" },
        { type: "thinking", thinking: "second thought", signature: "sig_2" },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUp(req, resp, "result", recallBlock);

    const assistant = followUp.messages[1];
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content[0].type).toBe("thinking");
    expect(assistant.content[1].type).toBe("thinking");
    expect(assistant.content[2].type).toBe("text");
    expect((assistant.content[2] as { text: string }).text).toContain("test query");
  });

  test("works without thinking blocks (non-thinking model)", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [{ type: "text", text: "Let me search." }, recallBlock],
      "tool_use",
    );

    const followUp = buildRecallFollowUp(req, resp, "result", recallBlock);

    const assistant = followUp.messages[1];
    // No thinking blocks — just the marker text
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0].type).toBe("text");
    expect((assistant.content[0] as { text: string }).text).toContain("test query");
  });

  test("uses '[No results found.]' for empty recall result", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    );

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock], "tool_use");

    const followUp = buildRecallFollowUp(req, resp, "", recallBlock);

    const resultBlock = followUp.messages[2].content[0];
    expect(resultBlock.type).toBe("text");
    expect((resultBlock as { text: string }).text).toBe("[No results found.]");
  });
});

// ---------------------------------------------------------------------------
// expandRecallMarkers
// ---------------------------------------------------------------------------

describe("expandRecallMarkers", () => {
  test("expands marker in assistant message back to tool_use + tool_result", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("test query", "all"), makeStoredRecall());

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          { type: "text", text: buildRecallMarker("test query", "all") },
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

    const result = expandRecallMarkers(req, store);

    expect(result).toBe(true);

    // Assistant message should now have recall tool_use replacing the marker
    const assistant = req.messages[1];
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe("recall");

    // User message should have recall tool_result inserted
    const user = req.messages[2];
    expect(user.content).toHaveLength(2);
    expect(user.content[0].type).toBe("tool_result");
    expect((user.content[0] as { toolUseId: string }).toolUseId).toBe(
      "toolu_recall_1",
    );
  });

  test("returns false when no markers found", () => {
    const store: RecallStore = new Map();
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "just text" }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("returns false when marker present but no store entry", () => {
    const store: RecallStore = new Map(); // empty
    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("unknown", "all") }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "thanks" }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("returns false with empty messages", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("test", "all"), makeStoredRecall());
    const req = makeRequest([]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("splits assistant message when continuation text follows marker (recall-only)", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("arch query", "all"), makeStoredRecall({
      toolUseId: "toolu_recall_split",
      input: { query: "arch query", scope: "all" },
      result: "Found: architecture docs",
    }));

    // Simulate recall-only with follow-up: the client sees one assistant
    // message with marker + continuation text from the follow-up.
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "tell me about arch" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: buildRecallMarker("arch query", "all") },
          { type: "text", text: "Based on the architecture docs, here's what I found..." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "thanks, tell me more" }] },
    ]);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Should split into: assistant[tool_use] → user[tool_result] → assistant[continuation] → user[next]
    expect(req.messages).toHaveLength(5);

    // Message 1: assistant with just the tool_use (truncated)
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toHaveLength(1);
    expect(req.messages[1].content[0].type).toBe("tool_use");
    expect((req.messages[1].content[0] as GatewayToolUseBlock).id).toBe("toolu_recall_split");

    // Message 2: synthetic user with tool_result
    expect(req.messages[2].role).toBe("user");
    expect(req.messages[2].content).toHaveLength(1);
    expect(req.messages[2].content[0].type).toBe("tool_result");
    expect((req.messages[2].content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_split");
    expect((req.messages[2].content[0] as { content: string }).content).toBe("Found: architecture docs");

    // Message 3: continuation assistant message
    expect(req.messages[3].role).toBe("assistant");
    expect(req.messages[3].content).toHaveLength(1);
    expect((req.messages[3].content[0] as { text: string }).text).toBe(
      "Based on the architecture docs, here's what I found...",
    );

    // Message 4: original next user message (unchanged)
    expect(req.messages[4].role).toBe("user");
    expect((req.messages[4].content[0] as { text: string }).text).toBe("thanks, tell me more");
  });

  test("does NOT split when content after marker is only tool_use blocks (mixed tools)", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("mixed query", "all"), makeStoredRecall({
      toolUseId: "toolu_recall_mixed",
      input: { query: "mixed query", scope: "all" },
    }));

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "search and read" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll search and read." },
          { type: "text", text: buildRecallMarker("mixed query", "all") },
          { type: "tool_use", id: "toolu_read_1", name: "Read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_read_1", content: "file content" },
        ],
      },
    ]);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Should NOT split — tool_use blocks stay in the same message
    expect(req.messages).toHaveLength(3);

    const assistant = req.messages[1];
    expect(assistant.content).toHaveLength(3); // text + recall tool_use + Read tool_use
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe("recall");
    expect(assistant.content[2].type).toBe("tool_use");
    expect((assistant.content[2] as GatewayToolUseBlock).name).toBe("Read");

    // User message has recall tool_result prepended
    const user = req.messages[2];
    expect(user.content).toHaveLength(2);
    expect((user.content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_mixed");
    expect((user.content[1] as { toolUseId: string }).toolUseId).toBe("toolu_read_1");
  });

  test("expands markers across multiple assistant messages", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("query1", "all"), makeStoredRecall({
      toolUseId: "toolu_recall_1",
      input: { query: "query1", scope: "all" },
    }));
    store.set(recallStoreKey("query2", "session"), makeStoredRecall({
      toolUseId: "toolu_recall_2",
      input: { query: "query2", scope: "session" },
    }));

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("query1", "all") }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("query2", "session") }],
      },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Both assistant messages should have tool_use blocks
    expect(req.messages[1].content[0].type).toBe("tool_use");
    expect((req.messages[1].content[0] as GatewayToolUseBlock).id).toBe("toolu_recall_1");
    expect(req.messages[3].content[0].type).toBe("tool_use");
    expect((req.messages[3].content[0] as GatewayToolUseBlock).id).toBe("toolu_recall_2");

    // Both following user messages should have tool_results inserted
    expect(req.messages[2].content[0].type).toBe("tool_result");
    expect((req.messages[2].content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_1");
    expect(req.messages[4].content[0].type).toBe("tool_result");
    expect((req.messages[4].content[0] as { toolUseId: string }).toolUseId).toBe("toolu_recall_2");
  });
});

// ---------------------------------------------------------------------------
// cleanupRecallStore
// ---------------------------------------------------------------------------

describe("cleanupRecallStore", () => {
  test("removes orphaned entries", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("active", "all"), makeStoredRecall());
    store.set(recallStoreKey("orphaned", "all"), makeStoredRecall());

    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("active", "all") }],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);

    cleanupRecallStore(req, store);

    expect(store.size).toBe(1);
    expect(store.has(recallStoreKey("active", "all"))).toBe(true);
    expect(store.has(recallStoreKey("orphaned", "all"))).toBe(false);
  });

  test("no-op on empty store", () => {
    const store: RecallStore = new Map();
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    cleanupRecallStore(req, store);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replaceRecallWithMarker
// ---------------------------------------------------------------------------

describe("replaceRecallWithMarker", () => {
  test("replaces recall tool_use with marker text", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      makeRecallToolUse("find config", "project"),
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.content).toHaveLength(3);
    expect(replaced.content[0].type).toBe("text");
    expect(replaced.content[1].type).toBe("text");
    expect((replaced.content[1] as { text: string }).text).toBe(
      buildRecallMarker("find config", "project"),
    );
    expect(replaced.content[2].type).toBe("tool_use");
    expect((replaced.content[2] as GatewayToolUseBlock).name).toBe("Read");
  });

  test("returns same content when no recall present", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.content).toHaveLength(2);
  });

  test("does not mutate original response", () => {
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const replaced = replaceRecallWithMarker(resp);
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("tool_use");
    expect(replaced.content).toHaveLength(1);
    expect(replaced.content[0].type).toBe("text");
  });

  test("preserves non-content fields", () => {
    const resp = makeResponse([makeRecallToolUse()]);
    resp.usage.inputTokens = 999;

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.id).toBe(resp.id);
    expect(replaced.model).toBe(resp.model);
    expect(replaced.stopReason).toBe(resp.stopReason);
    expect(replaced.usage.inputTokens).toBe(999);
  });
});
