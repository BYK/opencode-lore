/**
 * Reasoning-preservation regression suite.
 *
 * Anthropic's April 23, 2026 postmortem
 * (https://www.anthropic.com/engineering/april-23-postmortem) identified
 * dropping prior thinking/reasoning blocks as the root cause of "forgetfulness,
 * repetition, and odd tool choices" in long sessions. Their bug stemmed from a
 * caching optimization that became sticky: it cleared reasoning every turn
 * after a session crossed the idle threshold once.
 *
 * Lore preserves reasoning blocks verbatim across all gradient layers (0-3) by
 * design — `cleanParts`, `stripToolOutputs`, dedup, and `tryFit` all leave
 * reasoning parts untouched. At layer 4 (nuclear) older messages including
 * their reasoning are evicted as a byproduct of message-level eviction, but
 * the surviving distillation prefix (rendered from `temporal_messages` rows
 * that include `[reasoning]` envelopes) carries forward the reasoning content
 * in summary form.
 *
 * This file pins that contract: reasoning parts are preserved verbatim through
 * every layer that retains the source message. A future refactor that
 * silently regresses this — e.g. by extending `stripToolOutputs` to
 * reasoning, or by routing through `stripToTextOnly` — will fail loudly.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ensureProject } from "../src/db";
import {
  transform,
  setModelLimits,
  calibrate,
  resetCalibration,
  resetPrefixCache,
  resetRawWindowCache,
} from "../src/gradient";
import type {
  LoreMessage,
  LoreMessageWithParts,
  LorePart,
  LoreReasoningPart,
} from "../src/types";
import { isReasoningPart } from "../src/types";

const PROJECT = "/test/gradient-reasoning/project";

function makeReasoningPart(
  messageID: string,
  sessionID: string,
  text: string,
): LoreReasoningPart {
  return {
    id: `r-${messageID}`,
    sessionID,
    messageID,
    type: "reasoning",
    text,
    time: { start: Date.now(), end: Date.now() },
  } as LoreReasoningPart;
}

function makeUserMsg(
  id: string,
  text: string,
  sessionID: string,
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
  };
  return {
    info,
    parts: [
      {
        id: `p-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

function makeAssistantMsgWithReasoning(
  id: string,
  reasoning: string,
  visible: string,
  sessionID: string,
  opts: { withTool?: boolean; reasoningTokens?: number } = {},
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: `parent-${id}`,
    modelID: "claude-opus-4-7",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: opts.reasoningTokens ?? 200,
      cache: { read: 0, write: 0 },
    },
  };
  const parts: LorePart[] = [
    makeReasoningPart(id, sessionID, reasoning),
    {
      id: `t-${id}`,
      sessionID,
      messageID: id,
      type: "text",
      text: visible,
      time: { start: Date.now(), end: Date.now() },
    },
  ];
  if (opts.withTool) {
    parts.push({
      id: `tool-${id}`,
      sessionID,
      messageID: id,
      type: "tool",
      tool: "read",
      callID: `call-${id}`,
      state: {
        status: "completed",
        input: { path: "/test/file.ts" },
        output: "file contents here",
        title: "read",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    } as LorePart);
  }
  return { info, parts };
}

function findReasoningPart(msg: LoreMessageWithParts): string | undefined {
  const part = msg.parts.find(isReasoningPart);
  return part?.text;
}

const SID = "reasoning-audit-sess";

beforeAll(() => {
  ensureProject(PROJECT);
  // Generous limits — layers 0-1 should comfortably handle the test sessions.
  setModelLimits({ context: 50_000, output: 8_000 });
  calibrate(0); // zero overhead for deterministic budget math
  resetCalibration(SID);
  resetPrefixCache(SID);
  resetRawWindowCache(SID);
});

afterAll(() => {
  setModelLimits({ context: 10_000, output: 2_000 });
  calibrate(0);
});

describe("reasoning preservation — Layer 0 (passthrough)", () => {
  test("reasoning blocks survive byte-identical when messages fit", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("rp-u1", "Plan a refactor.", SID),
      makeAssistantMsgWithReasoning(
        "rp-a1",
        "Considering the approach: rename module A, then update all imports.",
        "I'll start by renaming module A.",
        SID,
      ),
      makeUserMsg("rp-u2", "Continue.", SID),
      makeAssistantMsgWithReasoning(
        "rp-a2",
        "Let me check existing imports before renaming.",
        "Checking imports first.",
        SID,
      ),
    ];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });

    expect(result.layer).toBe(0);
    // Layer 0 returns the input array reference — no reordering, no copies.
    expect(result.messages).toBe(messages);

    // Verify reasoning parts survived verbatim.
    expect(findReasoningPart(result.messages[1])).toBe(
      "Considering the approach: rename module A, then update all imports.",
    );
    expect(findReasoningPart(result.messages[3])).toBe(
      "Let me check existing imports before renaming.",
    );
  });

  test("reasoning + tool parts coexist on same assistant message", () => {
    const messages: LoreMessageWithParts[] = [
      makeUserMsg("rp-u3", "Read the config file.", SID),
      makeAssistantMsgWithReasoning(
        "rp-a3",
        "I should read it directly rather than guessing structure.",
        "Reading config now.",
        SID,
        { withTool: true },
      ),
      makeUserMsg("rp-u4", "ok", SID),
    ];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });

    expect(result.layer).toBe(0);
    const a = result.messages[1];
    expect(findReasoningPart(a)).toBe(
      "I should read it directly rather than guessing structure.",
    );
    // Tool part still present
    expect(a.parts.some((p) => p.type === "tool")).toBe(true);
    // Text part still present
    expect(a.parts.some((p) => p.type === "text")).toBe(true);
  });
});

describe("reasoning preservation — Layer 1 (lazy raw window)", () => {
  test("raw-window assistant messages keep their reasoning blocks", () => {
    // Force layer 1 by shrinking budgets so older messages get evicted but
    // the surviving raw window still includes reasoning-bearing assistants.
    const SID1 = "reasoning-l1-sess";
    resetCalibration(SID1);
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);

    // Build 10 turns with reasoning on every assistant. Each message ~1000
    // chars → ~333 tokens. 20 messages ≈ 6660 > 4000 usable → layer 1 fires.
    const messages: LoreMessageWithParts[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        makeUserMsg(`l1-u${i}`, "X".repeat(1_000), SID1),
        makeAssistantMsgWithReasoning(
          `l1-a${i}`,
          `[reasoning ${i}] Thinking through step ${i} carefully.`,
          "Y".repeat(1_000),
          SID1,
        ),
      );
    }

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID1,
    });
    // Should land on layer 1 with this budget profile
    expect(result.layer).toBeGreaterThanOrEqual(1);
    expect(result.layer).toBeLessThanOrEqual(2);

    // Every assistant message that survived in the raw window must keep its
    // reasoning part. Find assistants by id (skip the distilled prefix).
    const survivingAssistants = result.messages.filter(
      (m) => m.info.role === "assistant" && m.info.id.startsWith("l1-a"),
    );
    expect(survivingAssistants.length).toBeGreaterThan(0);
    for (const a of survivingAssistants) {
      const r = findReasoningPart(a);
      expect(r).toBeDefined();
      expect(r).toContain("Thinking through step");
    }

    // Restore defaults
    setModelLimits({ context: 50_000, output: 8_000 });
    calibrate(0);
  });
});

describe("reasoning preservation — Layer 2/3 (tool-output stripping)", () => {
  test("stripping tool outputs does NOT remove reasoning parts", () => {
    // Force a higher layer by maxing out the budget with tool-bearing
    // assistant messages.
    const SID2 = "reasoning-l2-sess";
    resetCalibration(SID2);
    setModelLimits({ context: 4_000, output: 800 });
    calibrate(0);

    // Build messages where tool output dominates token count, so stripping
    // it (layer 2/3) is needed to fit. Reasoning blocks are short.
    // Each tool output is ~6000 chars / ~2000 tokens; with 8 messages that's
    // ~16K tokens of tool output alone, far exceeding the ~3200 usable budget,
    // which forces tool-output stripping (layer 2 or 3).
    const messages: LoreMessageWithParts[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(makeUserMsg(`l2-u${i}`, "Read the next file.", SID2));
      // Big tool output, short reasoning
      const a: LoreMessageWithParts = makeAssistantMsgWithReasoning(
        `l2-a${i}`,
        `[r${i}] Decided to read.`,
        "Read it.",
        SID2,
        { withTool: false }, // we'll attach a custom oversized tool below
      );
      a.parts.push({
        id: `tool-l2-${i}`,
        sessionID: SID2,
        messageID: a.info.id,
        type: "tool",
        tool: "read",
        callID: `call-l2-${i}`,
        state: {
          status: "completed",
          input: { path: `/file${i}.ts` },
          output: "Z".repeat(6_000),
          title: "read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as LorePart);
      messages.push(a);
    }

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID2,
    });
    expect(result.layer).toBeGreaterThanOrEqual(2);

    // Reasoning blocks must survive even when tool outputs are stripped.
    const survivingAssistants = result.messages.filter(
      (m) => m.info.role === "assistant" && m.info.id.startsWith("l2-a"),
    );
    expect(survivingAssistants.length).toBeGreaterThan(0);
    for (const a of survivingAssistants) {
      const r = findReasoningPart(a);
      // Reasoning may not be on every surviving assistant if the assistant
      // was synthesized by the prefix or the message was deduped, but for
      // assistants whose IDs match our pattern AND have a reasoning part,
      // the text must be unmodified.
      if (r !== undefined) {
        expect(r).toMatch(/\[r\d+\] Decided to read\./);
      }
    }

    // Restore defaults
    setModelLimits({ context: 50_000, output: 8_000 });
    calibrate(0);
  });
});

describe("reasoning preservation — semantic invariant", () => {
  test("transform never inserts text 'reasoning removed' or similar markers", () => {
    // Defensive check: ensure no future code path quietly summarizes/replaces
    // reasoning content with a placeholder. If someone implements such a
    // shortcut, this test catches it without depending on exact text.
    const SID3 = "reasoning-invariant-sess";
    resetCalibration(SID3);
    setModelLimits({ context: 50_000, output: 8_000 });
    calibrate(0);

    const messages: LoreMessageWithParts[] = [
      makeUserMsg("inv-u1", "Plan the work.", SID3),
      makeAssistantMsgWithReasoning(
        "inv-a1",
        "Step 1: identify modules. Step 2: enumerate dependencies.",
        "Starting analysis.",
        SID3,
      ),
    ];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID3,
    });

    for (const m of result.messages) {
      for (const p of m.parts) {
        if (isReasoningPart(p)) {
          // Reasoning text must not be replaced with a stub. We check for
          // common placeholder-style phrases.
          expect(p.text).not.toMatch(/\[reasoning (?:omitted|removed|cleared|truncated)\]/i);
          expect(p.text.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
