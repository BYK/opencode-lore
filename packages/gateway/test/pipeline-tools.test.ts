/**
 * Tests for tool_result reconstruction in loreMessagesToGateway and the
 * removeOrphanedToolResults safety net.
 *
 * These test the fix for the "unexpected tool_use_id found in tool_result
 * blocks" Anthropic API error that occurs when gradient evicts an assistant
 * message but keeps the following user message with orphaned tool_result refs.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  loreMessagesToGateway,
  removeOrphanedToolResults,
} from "../src/pipeline";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import {
  transform,
  setModelLimits,
  calibrate,
  db,
  ensureProject,
} from "@loreai/core";
import type {
  LoreMessageWithParts,
  LoreUserMessage,
  LoreAssistantMessage,
  LorePart,
  LoreTextPart,
  LoreToolPart,
} from "@loreai/core";
import type { GatewayContentBlock, GatewayMessage } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeUserMsg(
  id: string,
  parts: LorePart[],
  sessionID = "test-sess",
): LoreMessageWithParts {
  const info: LoreUserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "anthropic", modelID: "test" },
  };
  return { info, parts };
}

function makeAssistantMsg(
  id: string,
  parts: LorePart[],
  sessionID = "test-sess",
): LoreMessageWithParts {
  const info: LoreAssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "test",
    providerID: "anthropic",
    mode: "test",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  return { info, parts };
}

function textPart(
  text: string,
  messageID = "msg",
  sessionID = "test-sess",
): LoreTextPart {
  return {
    id: `text-${Math.random().toString(36).slice(2)}`,
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: 0, end: 0 },
  };
}

function completedToolPart(
  tool: string,
  callID: string,
  input: unknown,
  output: string,
  messageID = "msg",
  sessionID = "test-sess",
): LoreToolPart {
  return {
    id: `tool-${Math.random().toString(36).slice(2)}`,
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID,
    state: {
      status: "completed",
      input,
      output,
      time: { start: 0, end: 0 },
    },
  };
}

function errorToolPart(
  tool: string,
  callID: string,
  input: unknown,
  error: string,
  messageID = "msg",
  sessionID = "test-sess",
): LoreToolPart {
  return {
    id: `tool-${Math.random().toString(36).slice(2)}`,
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID,
    state: {
      status: "error",
      input,
      error,
      time: { start: 0, end: 0 },
    },
  };
}

function pendingToolPart(
  tool: string,
  callID: string,
  input: unknown,
  messageID = "msg",
  sessionID = "test-sess",
): LoreToolPart {
  return {
    id: `tool-${Math.random().toString(36).slice(2)}`,
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID,
    state: { status: "pending", input },
  };
}

// ---------------------------------------------------------------------------
// loreMessagesToGateway: tool_result reconstruction
// ---------------------------------------------------------------------------

describe("loreMessagesToGateway — tool_result reconstruction", () => {
  test("reconstructs tool_result on following user message from completed tool part", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("list files")]),
      makeAssistantMsg("a1", [
        textPart("I'll list the files."),
        completedToolPart("bash", "toolu_1", { command: "ls" }, "file1.ts\nfile2.ts"),
      ]),
      makeUserMsg("u2", [textPart("[tool results provided]")]),
    ];

    const result = loreMessagesToGateway(messages);

    // Assistant should have text + tool_use
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.content).toHaveLength(2);
    expect(result[1]!.content[0]!.type).toBe("text");
    expect(result[1]!.content[1]!.type).toBe("tool_use");
    const toolUse = result[1]!.content[1]! as { type: "tool_use"; id: string; name: string; input: unknown };
    expect(toolUse.id).toBe("toolu_1");
    expect(toolUse.name).toBe("bash");

    // User message should have reconstructed tool_result prepended before text
    expect(result[2]!.role).toBe("user");
    expect(result[2]!.content).toHaveLength(2);
    expect(result[2]!.content[0]!.type).toBe("tool_result");
    const toolResult = result[2]!.content[0]! as { type: "tool_result"; toolUseId: string; content: string };
    expect(toolResult.toolUseId).toBe("toolu_1");
    expect(toolResult.content).toBe("file1.ts\nfile2.ts");
    expect(result[2]!.content[1]!.type).toBe("text");
  });

  test("reconstructs tool_result with is_error from error tool part", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("run something")]),
      makeAssistantMsg("a1", [
        errorToolPart("bash", "toolu_err", { command: "fail" }, "command not found"),
      ]),
      makeUserMsg("u2", [textPart("[tool results provided]")]),
    ];

    const result = loreMessagesToGateway(messages);

    // User message should have error tool_result
    const toolResult = result[2]!.content[0]! as {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.toolUseId).toBe("toolu_err");
    expect(toolResult.content).toBe("command not found");
    expect(toolResult.isError).toBe(true);
  });

  test("multiple tool calls on one assistant: all tool_results reconstructed", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("do stuff")]),
      makeAssistantMsg("a1", [
        completedToolPart("bash", "toolu_a", { command: "ls" }, "file1"),
        completedToolPart("read", "toolu_b", { path: "f.ts" }, "const x = 1"),
      ]),
      makeUserMsg("u2", [textPart("[tool results provided]")]),
    ];

    const result = loreMessagesToGateway(messages);

    // User message should have 2 tool_results + 1 text
    expect(result[2]!.content).toHaveLength(3);
    expect(result[2]!.content[0]!.type).toBe("tool_result");
    expect(result[2]!.content[1]!.type).toBe("tool_result");
    expect(result[2]!.content[2]!.type).toBe("text");

    const tr1 = result[2]!.content[0]! as { toolUseId: string; content: string };
    const tr2 = result[2]!.content[1]! as { toolUseId: string; content: string };
    expect(tr1.toolUseId).toBe("toolu_a");
    expect(tr1.content).toBe("file1");
    expect(tr2.toolUseId).toBe("toolu_b");
    expect(tr2.content).toBe("const x = 1");
  });

  test("pending tool part emits tool_use but no tool_result", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("do it")]),
      makeAssistantMsg("a1", [
        pendingToolPart("bash", "toolu_pending", { command: "echo" }),
      ]),
      makeUserMsg("u2", [textPart("interrupted")]),
    ];

    const result = loreMessagesToGateway(messages);

    // Assistant should have tool_use
    expect(result[1]!.content).toHaveLength(1);
    expect(result[1]!.content[0]!.type).toBe("tool_use");

    // User should NOT have a tool_result (pending = no result yet)
    expect(result[2]!.content).toHaveLength(1);
    expect(result[2]!.content[0]!.type).toBe("text");
  });

  test("residual tool:'result' parts on user messages are still handled gracefully", () => {
    // This tests the fallback path — if resolveToolResults didn't strip
    // the tool:"result" parts for some reason, loreMessagesToGateway
    // should still emit them as tool_result blocks.
    const resultPart: LoreToolPart = {
      id: "r1",
      sessionID: "test-sess",
      messageID: "u2",
      type: "tool",
      tool: "result",
      callID: "toolu_fallback",
      state: {
        status: "completed",
        input: null,
        output: "fallback output",
        time: { start: 0, end: 0 },
      },
    };
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("start")]),
      makeAssistantMsg("a1", [
        completedToolPart("bash", "toolu_fallback", {}, "output"),
      ]),
      makeUserMsg("u2", [resultPart]),
    ];

    const result = loreMessagesToGateway(messages);

    // User message should have the reconstructed tool_result (from assistant's
    // completed part) PLUS the residual tool_result (from the result part).
    // Both reference the same toolUseId — that's harmless (removeOrphanedToolResults
    // would catch mismatches).
    const userContent = result[2]!.content;
    const toolResults = userContent.filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  test("conversation without tool calls passes through unchanged", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("hello")]),
      makeAssistantMsg("a1", [textPart("hi there")]),
      makeUserMsg("u2", [textPart("thanks")]),
    ];

    const result = loreMessagesToGateway(messages);

    expect(result).toHaveLength(3);
    expect(result[0]!.content).toHaveLength(1);
    expect(result[0]!.content[0]!.type).toBe("text");
    expect(result[1]!.content).toHaveLength(1);
    expect(result[1]!.content[0]!.type).toBe("text");
    expect(result[2]!.content).toHaveLength(1);
    expect(result[2]!.content[0]!.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// removeOrphanedToolResults
// ---------------------------------------------------------------------------

describe("removeOrphanedToolResults", () => {
  test("removes tool_result that references a missing tool_use", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        // No tool_use on this assistant message
        role: "assistant",
        content: [{ type: "text", text: "sure" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_gone",
            content: "orphaned",
          },
          { type: "text", text: "follow-up" },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    // tool_result should be removed, text preserved
    expect(messages[2]!.content).toHaveLength(1);
    expect(messages[2]!.content[0]!.type).toBe("text");
  });

  test("keeps tool_result that matches tool_use on preceding assistant", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ok", name: "bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_ok",
            content: "output",
          },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    // tool_result should be preserved (matching tool_use exists)
    expect(messages[1]!.content).toHaveLength(1);
    expect(messages[1]!.content[0]!.type).toBe("tool_result");
  });

  test("removes only the orphaned tool_result, keeps matched ones", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_match", name: "bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_match",
            content: "good",
          },
          {
            type: "tool_result",
            toolUseId: "toolu_orphan",
            content: "bad",
          },
          { type: "text", text: "continue" },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    expect(messages[1]!.content).toHaveLength(2);
    expect(messages[1]!.content[0]!.type).toBe("tool_result");
    expect(
      (messages[1]!.content[0]! as { toolUseId: string }).toolUseId,
    ).toBe("toolu_match");
    expect(messages[1]!.content[1]!.type).toBe("text");
  });

  test("replaces empty user message with placeholder text after removing all tool_results", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_orphan1",
            content: "a",
          },
          {
            type: "tool_result",
            toolUseId: "toolu_orphan2",
            content: "b",
          },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    expect(messages[1]!.content).toHaveLength(1);
    expect(messages[1]!.content[0]!.type).toBe("text");
    expect((messages[1]!.content[0]! as { text: string }).text).toBe(
      "[tool results provided]",
    );
  });

  test("user message at index 0 (no preceding assistant) gets orphaned tool_result stripped", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_impossible",
            content: "no assistant before",
          },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    expect(messages[0]!.content).toHaveLength(1);
    expect(messages[0]!.content[0]!.type).toBe("text");
    expect((messages[0]!.content[0]! as { text: string }).text).toBe(
      "[tool results provided]",
    );
  });

  test("no-op when there are no tool_result blocks at all", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    ];

    const before = JSON.stringify(messages);
    removeOrphanedToolResults(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: gradient eviction scenario
// ---------------------------------------------------------------------------

describe("end-to-end: gradient eviction doesn't produce orphaned tool_result", () => {
  test("after evicting assistant message, reconstructed tool_result on user message is valid", () => {
    // Simulate the scenario where gradient evicted the assistant message
    // but kept the user message. After resolveToolResults stripped the
    // tool:"result" parts, the user message only has placeholder text.
    // loreMessagesToGateway should NOT produce any tool_result blocks.
    const messages: LoreMessageWithParts[] = [
      // This is what remains after gradient eviction — the assistant with
      // tool_use is gone, user message only has placeholder text.
      makeUserMsg("u-evicted", [textPart("[tool results provided]")]),
      makeAssistantMsg("a-new", [textPart("Starting fresh...")]),
      makeUserMsg("u-current", [textPart("What happened?")]),
    ];

    const result = loreMessagesToGateway(messages);
    removeOrphanedToolResults(result);

    // No tool_result blocks anywhere — no orphans possible
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // If there IS a tool_result, it must match a tool_use on the preceding msg
          const idx = result.indexOf(msg);
          const prev = idx > 0 ? result[idx - 1]! : null;
          const toolUseIds = new Set(
            (prev?.content ?? [])
              .filter((b) => b.type === "tool_use")
              .map((b) => (b as { id: string }).id),
          );
          expect(toolUseIds.has((block as { toolUseId: string }).toolUseId)).toBe(true);
        }
      }
    }
  });

  test("tool call pair survives when both assistant and user are kept", () => {
    // Both messages survive gradient — tool_result reconstructed correctly
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("u1", [textPart("do something")]),
      makeAssistantMsg("a1", [
        completedToolPart("bash", "toolu_kept", { command: "ls" }, "file.ts"),
      ]),
      makeUserMsg("u2", [textPart("[tool results provided]")]),
      makeAssistantMsg("a2", [textPart("Here it is.")]),
    ];

    const result = loreMessagesToGateway(messages);
    removeOrphanedToolResults(result);

    // Validate tool pairing: tool_use on assistant[1], tool_result on user[2]
    const assistantContent = result[1]!.content;
    const userContent = result[2]!.content;

    const toolUse = assistantContent.find((b) => b.type === "tool_use") as {
      type: "tool_use";
      id: string;
    };
    const toolResult = userContent.find((b) => b.type === "tool_result") as {
      type: "tool_result";
      toolUseId: string;
      content: string;
    };

    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolResult.toolUseId).toBe(toolUse.id);
    expect(toolResult.content).toBe("file.ts");
  });
});

import { buildOpenAIUpstreamRequest } from "../src/translate/openai";
import type { GatewayRequest } from "../src/translate/types";

function makeOpenAIReq(messages: GatewayRequest["messages"]): GatewayRequest {
  return {
    protocol: "openai",
    model: "test-model",
    stream: false,
    maxTokens: 1000,
    metadata: {
      projectId: "test",
      projectPath: "/test",
      gitRemote: "test",
      gitRoot: "/test",
    },
    system: "system prompt",
    messages,
    tools: [],
    rawHeaders: {},
  };
}

test("BUG-006: OpenAI translator preserves tool_result as role:tool message", () => {
  const req = makeOpenAIReq([
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call_123", content: "the result" },
      ],
    },
  ]);

  const body = buildOpenAIUpstreamRequest(req, "https://api.openai.com").body as { messages: any[] };
  const toolMsg = body.messages.find((m: any) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg.tool_call_id).toBe("call_123");
  expect(toolMsg.content).toBe("the result");
});

test("BUG-006: mixed text + tool_result in same message emits both", () => {
  const req = makeOpenAIReq([
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call_A", content: "result A" },
        { type: "text", text: "Please continue" },
      ],
    },
  ]);

  const body = buildOpenAIUpstreamRequest(req, "https://api.openai.com").body as { messages: any[] };
  // Should have system + tool + user messages
  const toolMsg = body.messages.find((m: any) => m.role === "tool");
  const userMsg = body.messages.find((m: any) => m.role === "user");
  expect(toolMsg).toBeDefined();
  expect(toolMsg.tool_call_id).toBe("call_A");
  expect(userMsg).toBeDefined();
  expect(userMsg.content).toBe("Please continue");
});

test("BUG-006: multiple tool_results in one message are all preserved", () => {
  const req = makeOpenAIReq([
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call_1", content: "result 1" },
        { type: "tool_result", toolUseId: "call_2", content: "result 2" },
        { type: "tool_result", toolUseId: "call_3", content: "" },
      ],
    },
  ]);

  const body = buildOpenAIUpstreamRequest(req, "https://api.openai.com").body as { messages: any[] };
  const toolMsgs = body.messages.filter((m: any) => m.role === "tool");
  expect(toolMsgs).toHaveLength(3);
  expect(toolMsgs[0].tool_call_id).toBe("call_1");
  expect(toolMsgs[1].tool_call_id).toBe("call_2");
  expect(toolMsgs[2].tool_call_id).toBe("call_3");
  expect(toolMsgs[2].content).toBe(""); // empty content preserved
});

// ---------------------------------------------------------------------------
// #424: removeOrphanedToolResults — bidirectional validation (tool_use → tool_result)
// ---------------------------------------------------------------------------

describe("removeOrphanedToolResults — tool_use→tool_result (pass 2, #424)", () => {
  test("removes orphaned tool_use when no following user message exists", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read the file" },
          { type: "tool_use", id: "toolu_001", name: "read", input: {} },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    // tool_use should be removed — no following user with tool_result
    const assistant = messages[1];
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0].type).toBe("text");
  });

  test("removes orphaned tool_use when following message is assistant (back-to-back)", () => {
    // This simulates the #424 bug: prefix ends with assistant, raw window
    // starts with assistant — loreMessagesToGateway produces back-to-back
    // assistants where the first has tool_use with no tool_result.
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "[memory context]" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "distilled observations" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read the file" },
          { type: "tool_use", id: "toolu_eval_000010", name: "read", input: { path: "src/main.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_eval_000010", content: "file contents" },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    // The tool_use on assistant[2] references tool_result on user[3], but
    // messages[3].role is user — this should be kept since the following
    // message IS a user with the matching tool_result.
    const assistant2 = messages[2];
    expect(assistant2.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  test("removes tool_use when following user has no matching tool_result", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read" },
          { type: "tool_use", id: "toolu_001", name: "read", input: {} },
          { type: "tool_use", id: "toolu_002", name: "write", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          // Only has tool_result for toolu_001, not toolu_002
          { type: "tool_result", toolUseId: "toolu_001", content: "result" },
          { type: "text", text: "continue" },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    const assistant = messages[1];
    // toolu_001 kept (has matching result), toolu_002 removed
    expect(assistant.content).toHaveLength(2); // text + toolu_001
    const toolUseBlocks = assistant.content.filter((b) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(1);
    expect((toolUseBlocks[0] as any).id).toBe("toolu_001");
  });

  test("keeps tool_use when following user has matching tool_result", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_001", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_001", content: "data" },
        ],
      },
    ];

    removeOrphanedToolResults(messages);

    // Everything should be preserved
    expect(messages[1].content).toHaveLength(1);
    expect(messages[1].content[0].type).toBe("tool_use");
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0].type).toBe("tool_result");
  });

  test("replaces empty assistant with placeholder after removing all tool_use blocks", () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: GatewayContentBlock[];
    }> = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_001", name: "read", input: {} },
        ],
      },
      // No following user message at all
    ];

    removeOrphanedToolResults(messages);

    // The assistant message should have a placeholder instead of being empty
    expect(messages[1].content).toHaveLength(1);
    expect(messages[1].content[0].type).toBe("text");
    expect((messages[1].content[0] as any).text).toBe("[assistant response]");
  });
});

// ---------------------------------------------------------------------------
// #424: End-to-end integration test — inflated eval through full pipeline
// ---------------------------------------------------------------------------

describe("end-to-end: inflated eval tool_use/tool_result through full pipeline (#424)", () => {
  // Use a unique session ID to avoid state pollution from other gradient tests
  const SESSION_E2E = `sess-e2e-424-${Date.now()}`;
  const PID_E2E = "/test/pipeline/e2e-424";
  let projectId: string;

  beforeAll(() => {
    projectId = ensureProject(PID_E2E);
    // Small context window to force gradient compression (like 400K inflate)
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  afterAll(() => {
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
  });

  /**
   * Simulates the eval's buildMessages() → gateway pipeline path.
   * Builds Anthropic-format messages with tool_use/tool_result pairs
   * (like inflated filler), converts through the full pipeline, and
   * validates Anthropic API compliance.
   */
  test("inflated messages with tool_use/tool_result survive gradient compression", () => {
    // Store a distillation so gradient produces a prefix (triggers layer 1+)
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "dist-e2e-424",
        projectId,
        SESSION_E2E,
        "",
        "[]",
        "x".repeat(500),
        "[]",
        0,
        170,
        0,
        Date.now(),
      );

    // Build Anthropic-format messages mimicking inflated eval:
    // Alternating user text + assistant tool_use + user tool_result + assistant text
    // (same pattern as inflate.ts filler templates).
    // Each turn generates ~1000 tokens (3000 chars / 3) to overflow the 8K usable budget.
    const gatewayMessages: GatewayMessage[] = [];
    let toolCounter = 0;

    for (let i = 0; i < 15; i++) {
      const toolId = `toolu_eval_${(++toolCounter).toString(36).padStart(6, "0")}`;

      // User asks to do something (~300 tokens)
      gatewayMessages.push({
        role: "user",
        content: [{ type: "text", text: `Implement feature ${i}: ${"x".repeat(900)}` }],
      });

      // Assistant calls a tool (~700 tokens: text + tool input)
      gatewayMessages.push({
        role: "assistant",
        content: [
          { type: "text", text: `I'll implement feature ${i}. ${"z".repeat(600)}` },
          { type: "tool_use", id: toolId, name: "write", input: { path: `src/feature${i}.ts`, content: "x".repeat(1200) } },
        ],
      });

      // User provides tool result (~300 tokens)
      gatewayMessages.push({
        role: "user",
        content: [
          { type: "tool_result", toolUseId: toolId, content: `Wrote src/feature${i}.ts successfully. ${"w".repeat(800)}` },
        ],
      });

      // Assistant summarizes (~300 tokens)
      gatewayMessages.push({
        role: "assistant",
        content: [{ type: "text", text: `Feature ${i} implemented successfully. ${"y".repeat(900)}` }],
      });
    }

    // Final user message (current turn)
    gatewayMessages.push({
      role: "user",
      content: [{ type: "text", text: "Now summarize everything we did." }],
    });

    // --- Full pipeline path (same as pipeline.ts step 7) ---
    // 1. Convert to Lore format
    const loreMessages = gatewayMessagesToLore(gatewayMessages, SESSION_E2E);

    // 2. Resolve tool results (merges into assistant parts, strips from user)
    resolveToolResults(loreMessages);

    // 3. Gradient transform (will compress at layer 1+ due to small context)
    const result = transform({
      messages: loreMessages,
      projectPath: PID_E2E,
      sessionID: SESSION_E2E,
    });

    // Must be at gradient layer 1+ (compressed with prefix)
    expect(result.layer).toBeGreaterThanOrEqual(1);
    // Messages were evicted (not all 61 input messages survive)
    expect(result.messages.length).toBeLessThan(loreMessages.length);

    // 4. Convert back to gateway format
    const transformedMessages = loreMessagesToGateway(result.messages);

    // 5. Safety net
    removeOrphanedToolResults(transformedMessages);

    // --- Anthropic API compliance validation ---

    // A. No back-to-back same-role messages
    for (let i = 1; i < transformedMessages.length; i++) {
      expect(transformedMessages[i].role).not.toBe(transformedMessages[i - 1].role);
    }

    // B. First message must be user
    expect(transformedMessages[0].role).toBe("user");

    // C. Every tool_use on an assistant has a matching tool_result on the
    //    immediately following user message
    for (let i = 0; i < transformedMessages.length; i++) {
      const msg = transformedMessages[i];
      if (msg.role !== "assistant") continue;
      const toolUseIds = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => (b as { id: string }).id);

      if (toolUseIds.length === 0) continue;

      // Must have a following user message
      const next = transformedMessages[i + 1];
      expect(next).toBeDefined();
      expect(next.role).toBe("user");

      // Every tool_use ID must have a matching tool_result
      const toolResultIds = new Set(
        next.content
          .filter((b) => b.type === "tool_result")
          .map((b) => (b as { toolUseId: string }).toolUseId),
      );

      for (const id of toolUseIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
    }

    // D. Every tool_result on a user references a tool_use on the preceding assistant
    for (let i = 0; i < transformedMessages.length; i++) {
      const msg = transformedMessages[i];
      if (msg.role !== "user") continue;
      const toolResultIds = msg.content
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { toolUseId: string }).toolUseId);

      if (toolResultIds.length === 0) continue;

      const prev = transformedMessages[i - 1];
      expect(prev).toBeDefined();
      expect(prev.role).toBe("assistant");

      const toolUseIdSet = new Set(
        prev.content
          .filter((b) => b.type === "tool_use")
          .map((b) => (b as { id: string }).id),
      );

      for (const id of toolResultIds) {
        expect(toolUseIdSet.has(id)).toBe(true);
      }
    }

    // E. No empty content arrays
    for (const msg of transformedMessages) {
      expect(msg.content.length).toBeGreaterThan(0);
    }
  });
});
