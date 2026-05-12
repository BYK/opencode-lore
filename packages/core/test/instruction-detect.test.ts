import { describe, test, expect, beforeEach } from "bun:test";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import {
  extractInstructionCandidates,
  findRepeatedInstructions,
  formatForCurator,
  detectAndFormat,
  type InstructionCandidate,
  type RepeatedInstruction,
} from "../src/instruction-detect";
import type { LoreMessage, LorePart } from "../src/types";

const PROJECT = "/test/instruction-detect/project";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  role: "user" | "assistant",
  sessionID: string,
): LoreMessage {
  if (role === "user") {
    return {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    };
  }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function makeParts(messageID: string, text: string, sessionID = "sess-1"): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    },
  ];
}

function insertDistillation(input: {
  projectId: string;
  sessionID: string;
  observations: string;
  archived?: 0 | 1;
}): string {
  const id = crypto.randomUUID();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.sessionID,
      "",
      "[]",
      input.observations,
      "[]",
      0,
      Math.ceil(input.observations.length / 3),
      input.archived ?? 0,
      Date.now(),
    );
  return id;
}

// ---------------------------------------------------------------------------
// extractInstructionCandidates
// ---------------------------------------------------------------------------

describe("extractInstructionCandidates", () => {
  test("extracts 'always X' from user messages", () => {
    const messages = [
      { role: "user", content: "Please always create a PR for changes.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("create a PR for changes");
  });

  test("extracts 'never X' from user messages", () => {
    const messages = [
      { role: "user", content: "You should never push directly to main.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("push directly to main");
  });

  test("extracts 'make sure to X' from user messages", () => {
    const messages = [
      { role: "user", content: "Make sure to run the linter before pushing.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("run the linter before pushing");
  });

  test("extracts 'don't forget to X' from user messages", () => {
    const messages = [
      { role: "user", content: "Don't forget to update the changelog when releasing.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("update the changelog when releasing");
  });

  test("extracts 'I want/need/prefer/expect' patterns", () => {
    const messages = [
      { role: "user", content: "I want you to use squash merges for all PRs.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("use squash merges for all PRs");
  });

  test("extracts 'please always X' pattern — deduped with 'always X'", () => {
    const messages = [
      { role: "user", content: "Please always run tests before committing.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    // Both "always X" and "please always X" patterns fire, but dedup
    // collapses them since they produce the same lowercased text
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("run tests before committing");
  });

  test("ignores assistant messages", () => {
    const messages = [
      { role: "assistant", content: "I'll always create a PR for changes.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(0);
  });

  test("ignores short captures (< 10 chars)", () => {
    const messages = [
      { role: "user", content: "Always do X.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    // "do X" is only 3 chars — should be filtered
    expect(results).toHaveLength(0);
  });

  test("deduplicates by lowercased text", () => {
    const messages = [
      { role: "user", content: "Always create a PR for changes.", session_id: "s1" },
      { role: "user", content: "Always create a PR for changes.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
  });

  test("extracts multiple different instructions", () => {
    const messages = [
      { role: "user", content: "Always create a PR. Never push to main directly.", session_id: "s1" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(2);
  });

  test("caps at MAX_CANDIDATES (5)", () => {
    const messages = [
      {
        role: "user",
        content:
          "Always create a PR for changes. " +
          "Never push to main directly. " +
          "Make sure to run the linter. " +
          "Don't forget to update the docs. " +
          "I want you to use conventional commits. " +
          "Always add tests for new features. " +
          "Never skip code review.",
        session_id: "s1",
      },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("preserves session_id on candidates", () => {
    const messages = [
      { role: "user", content: "Always create a PR for changes.", session_id: "my-session-42" },
    ];
    const results = extractInstructionCandidates(messages);
    expect(results).toHaveLength(1);
    expect(results[0].sessionID).toBe("my-session-42");
  });
});

// ---------------------------------------------------------------------------
// findRepeatedInstructions (FTS path — no embeddings in test)
// ---------------------------------------------------------------------------

describe("findRepeatedInstructions", () => {
  const pid = ensureProject(PROJECT);

  beforeEach(() => {
    // Clean up distillations and temporal messages
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  });

  test("detects instruction repeated in 2+ prior sessions", async () => {
    // Insert distillations from 2 prior sessions mentioning "create a PR"
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🔴 (14:30) User stated always create a PR for changes.",
    });
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-2",
      observations: "🔴 (10:00) User said always create a PR before merging.",
    });

    const candidates: InstructionCandidate[] = [
      { text: "create a PR for changes", sessionID: "current-sess" },
    ];

    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
      threshold: 2,
    });

    expect(results).toHaveLength(1);
    expect(results[0].instruction).toBe("create a PR for changes");
    expect(results[0].priorSessionCount).toBeGreaterThanOrEqual(2);
  });

  test("excludes current session from count", async () => {
    // Insert distillation from current session — should not count
    insertDistillation({
      projectId: pid,
      sessionID: "current-sess",
      observations: "🔴 (14:30) User stated always create a PR for changes.",
    });
    // Insert from only 1 prior session — below threshold of 2
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🔴 (10:00) User said always create a PR for review.",
    });

    const candidates: InstructionCandidate[] = [
      { text: "create a PR for changes", sessionID: "current-sess" },
    ];

    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
      threshold: 2,
    });

    expect(results).toHaveLength(0);
  });

  test("respects threshold parameter", async () => {
    // Insert from only 1 prior session
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🔴 (14:30) User stated always create a PR for changes.",
    });

    const candidates: InstructionCandidate[] = [
      { text: "create a PR for changes", sessionID: "current-sess" },
    ];

    // threshold=1 — should find it
    const results1 = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
      threshold: 1,
    });
    expect(results1).toHaveLength(1);

    // threshold=2 — should not find it (only 1 prior session)
    const results2 = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
      threshold: 2,
    });
    expect(results2).toHaveLength(0);
  });

  test("returns empty when no repetitions found", async () => {
    // Insert distillation with unrelated content
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🟡 (14:30) Agent debugging auth issue in auth.ts.",
    });

    const candidates: InstructionCandidate[] = [
      { text: "create a PR for changes", sessionID: "current-sess" },
    ];

    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
    });

    expect(results).toHaveLength(0);
  });

  test("returns empty for empty candidates", async () => {
    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates: [],
    });
    expect(results).toHaveLength(0);
  });

  test("searches archived distillations too", async () => {
    // Insert archived distillations from 2 prior sessions
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🔴 (14:30) User stated always create a PR for changes.",
      archived: 1,
    });
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-2",
      observations: "🔴 (10:00) User said always create a PR for review.",
      archived: 1,
    });

    const candidates: InstructionCandidate[] = [
      { text: "create a PR for changes", sessionID: "current-sess" },
    ];

    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
      threshold: 2,
    });

    expect(results).toHaveLength(1);
    expect(results[0].priorSessionCount).toBeGreaterThanOrEqual(2);
  });

  test("skips candidates with fewer than 2 meaningful search terms", async () => {
    // "run tests" after filtering may be < 2 terms depending on stopwords
    // but "run" and "tests" should both survive filtering
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "User always runs tests before committing.",
    });
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-2",
      observations: "User always runs tests before pushing.",
    });

    const candidates: InstructionCandidate[] = [
      // Very short instruction text — terms may be too few after filtering
      { text: "a b c d e f g h i j", sessionID: "current-sess" },
    ];

    // Should not crash, may return empty
    const results = await findRepeatedInstructions({
      projectPath: PROJECT,
      currentSessionID: "current-sess",
      candidates,
    });
    // Just verify it doesn't throw
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatForCurator
// ---------------------------------------------------------------------------

describe("formatForCurator", () => {
  test("formats repeated instructions with session counts", () => {
    const instructions: RepeatedInstruction[] = [
      { instruction: "create a PR for all changes", priorSessionCount: 3 },
      { instruction: "merge with squash", priorSessionCount: 2 },
    ];
    const result = formatForCurator(instructions);
    expect(result).toContain("CROSS-SESSION REPEATED INSTRUCTIONS");
    expect(result).toContain('"create a PR for all changes" (seen in 3 prior sessions)');
    expect(result).toContain('"merge with squash" (seen in 2 prior sessions)');
  });

  test("returns empty string for no instructions", () => {
    expect(formatForCurator([])).toBe("");
  });

  test("handles singular session count", () => {
    const instructions: RepeatedInstruction[] = [
      { instruction: "always lint", priorSessionCount: 1 },
    ];
    const result = formatForCurator(instructions);
    expect(result).toContain("(seen in 1 prior session)");
    expect(result).not.toContain("sessions)");
  });
});

// ---------------------------------------------------------------------------
// detectAndFormat (integration)
// ---------------------------------------------------------------------------

describe("detectAndFormat", () => {
  const pid = ensureProject(PROJECT);

  beforeEach(() => {
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  });

  test("full pipeline with repeated instructions", async () => {
    // Store a user message in the current session with an instruction
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-current-1", "user", "current-sess"),
      parts: makeParts("msg-current-1", "Always create a PR for all changes.", "current-sess"),
    });

    // Insert distillations from 2 prior sessions mentioning similar instructions
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-1",
      observations: "🔴 (14:30) User stated always create a PR for changes.",
    });
    insertDistillation({
      projectId: pid,
      sessionID: "prior-sess-2",
      observations: "🔴 (10:00) User said always create a PR before merging.",
    });

    const result = await detectAndFormat({
      projectPath: PROJECT,
      sessionID: "current-sess",
    });

    expect(result).toContain("CROSS-SESSION REPEATED INSTRUCTIONS");
    expect(result).toContain("prior session");
  });

  test("returns empty string when no instructions in current session", async () => {
    // Store a user message without instruction keywords
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-no-instr", "user", "current-sess"),
      parts: makeParts("msg-no-instr", "Can you help me fix this bug?", "current-sess"),
    });

    const result = await detectAndFormat({
      projectPath: PROJECT,
      sessionID: "current-sess",
    });

    expect(result).toBe("");
  });

  test("returns empty string when no prior sessions match", async () => {
    // Store instruction in current session but no matching prior distillations
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-lonely", "user", "current-sess"),
      parts: makeParts("msg-lonely", "Always create a PR for all changes.", "current-sess"),
    });

    const result = await detectAndFormat({
      projectPath: PROJECT,
      sessionID: "current-sess",
    });

    expect(result).toBe("");
  });
});
