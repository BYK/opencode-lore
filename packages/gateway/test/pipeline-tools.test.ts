/**
 * Tests for tool_result reconstruction in loreMessagesToGateway and the
 * removeOrphanedToolResults safety net.
 *
 * These test the fix for the "unexpected tool_use_id found in tool_result
 * blocks" Anthropic API error that occurs when gradient evicts an assistant
 * message but keeps the following user message with orphaned tool_result refs.
 */
import { describe, test, expect } from "bun:test";
import {
  loreMessagesToGateway,
  removeOrphanedToolResults,
} from "../src/pipeline";
import type {
  LoreMessageWithParts,
  LoreUserMessage,
  LoreAssistantMessage,
  LorePart,
  LoreTextPart,
  LoreToolPart,
} from "@loreai/core";
import type { GatewayContentBlock } from "../src/translate/types";

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
