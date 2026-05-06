import { describe, test, expect } from "bun:test";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import type { GatewayMessage } from "../src/translate/types";
import { isToolPart } from "@loreai/core";

// ---------------------------------------------------------------------------
// Helper: build a typical tool-call conversation in gateway message format
// ---------------------------------------------------------------------------

function makeToolConversation(): GatewayMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "List the files" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll list the files for you." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "toolu_abc",
          content: "file1.ts\nfile2.ts",
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Here are the files." }],
    },
  ];
}

// ---------------------------------------------------------------------------
// resolveToolResults: pairing + stripping
// ---------------------------------------------------------------------------

describe("resolveToolResults", () => {
  test("resolves pending tool_use → completed and strips tool_result parts from user messages", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-1");
    resolveToolResults(messages);

    // Assistant's tool part should now be completed with the output
    const assistantMsg = messages[1]!;
    const toolPart = assistantMsg.parts.find(
      (p) => isToolPart(p) && p.tool === "bash",
    );
    expect(toolPart).toBeDefined();
    expect((toolPart as any).state.status).toBe("completed");
    expect((toolPart as any).state.output).toBe("file1.ts\nfile2.ts");

    // User message should have NO tool_result parts (stripped)
    const toolResultUser = messages[2]!;
    const resultParts = toolResultUser.parts.filter(
      (p) => isToolPart(p) && p.tool === "result",
    );
    expect(resultParts).toHaveLength(0);
  });

  test("user message with only tool_result parts gets placeholder text after stripping", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-2");
    resolveToolResults(messages);

    // The user message that was tool_result-only should now have a placeholder
    const toolResultUser = messages[2]!;
    expect(toolResultUser.parts).toHaveLength(1);
    expect(toolResultUser.parts[0]!.type).toBe("text");
    expect((toolResultUser.parts[0] as any).text).toBe(
      "[tool results provided]",
    );
  });

  test("user message with text + tool_result preserves text, strips tool_result", () => {
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Run these commands" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_xyz",
            name: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_xyz",
            content: "hi",
          },
          { type: "text", text: "Now do the next thing" },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-3");
    resolveToolResults(messages);

    // User message should keep the text part but not the tool_result part
    const userMsg = messages[2]!;
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]!.type).toBe("text");
    expect((userMsg.parts[0] as any).text).toBe("Now do the next thing");
  });

  test("unresolved tool_result parts (no matching tool_use) are also stripped", () => {
    // tool_result references a callID that doesn't match any tool_use
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Start" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_orphan",
            content: "orphaned result",
          },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-4");
    resolveToolResults(messages);

    // Orphaned tool_result should be stripped, replaced with placeholder
    const userMsg = messages[1]!;
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]!.type).toBe("text");
    expect((userMsg.parts[0] as any).text).toBe(
      "[tool results provided]",
    );
  });

  test("multiple tool calls in one assistant message: all tool_result parts stripped", () => {
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Do multiple things" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "read",
            input: { path: "file.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: "file1.ts",
          },
          {
            type: "tool_result",
            toolUseId: "toolu_2",
            content: "const x = 1;",
          },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-5");
    resolveToolResults(messages);

    // Both assistant tool parts should be resolved
    const assistantMsg = messages[1]!;
    const toolParts = assistantMsg.parts.filter(
      (p) => isToolPart(p) && p.tool !== "result",
    );
    expect(toolParts).toHaveLength(2);
    expect((toolParts[0] as any).state.status).toBe("completed");
    expect((toolParts[0] as any).state.output).toBe("file1.ts");
    expect((toolParts[1] as any).state.status).toBe("completed");
    expect((toolParts[1] as any).state.output).toBe("const x = 1;");

    // User message should have NO tool_result parts — replaced with placeholder
    const userMsg = messages[2]!;
    const resultParts = userMsg.parts.filter(
      (p) => isToolPart(p) && p.tool === "result",
    );
    expect(resultParts).toHaveLength(0);
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]!.type).toBe("text");
  });

  test("assistant messages are never modified by stripping pass", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-6");
    resolveToolResults(messages);

    // All assistant messages should still have their original parts (text + tool)
    const assistant1 = messages[1]!;
    expect(assistant1.info.role).toBe("assistant");
    const textParts = assistant1.parts.filter((p) => p.type === "text");
    const toolParts = assistant1.parts.filter((p) => p.type === "tool");
    expect(textParts).toHaveLength(1);
    expect(toolParts).toHaveLength(1);
  });
});
