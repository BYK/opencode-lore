import { describe, test, expect } from "bun:test";
import {
  buildCompactPrompt,
  COMPACT_SUMMARY_TEMPLATE,
  recursiveUser,
} from "../src/prompt";

// All required section headings emitted by COMPACT_SUMMARY_TEMPLATE. Pinning
// this list keeps Lore's /compact output aligned with the upstream OpenCode
// SUMMARY_TEMPLATE (see packages/core/src/prompt.ts commentary).
const REQUIRED_SECTIONS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "## Relevant Files",
];

describe("COMPACT_SUMMARY_TEMPLATE", () => {
  test("contains every required section heading", () => {
    for (const heading of REQUIRED_SECTIONS) {
      expect(COMPACT_SUMMARY_TEMPLATE).toContain(heading);
    }
  });

  test("instructs the model to close with 'I'm ready to continue.'", () => {
    expect(COMPACT_SUMMARY_TEMPLATE).toContain("I'm ready to continue.");
  });

  test("sections appear in the upstream-canonical order", () => {
    const positions = REQUIRED_SECTIONS.map((s) =>
      COMPACT_SUMMARY_TEMPLATE.indexOf(s),
    );
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]).toBeLessThan(positions[i + 1]);
    }
  });
});

describe("buildCompactPrompt", () => {
  test("no distillations, no knowledge — emits template only", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      knowledge: "",
    });
    // Template body present.
    for (const heading of REQUIRED_SECTIONS) {
      expect(prompt).toContain(heading);
    }
    // Distillation-reminder sentence absent when no distillations provided.
    expect(prompt).not.toContain("Lore has pre-computed chunked summaries");
    // No knowledge block.
    expect(prompt).not.toContain("## Long-term Knowledge");
  });

  test("with distillations — injects the pre-computed summaries reminder", () => {
    const prompt = buildCompactPrompt({ hasDistillations: true });
    expect(prompt).toContain("Lore has pre-computed chunked summaries");
  });

  test("with knowledge block — appends knowledge after template", () => {
    const knowledge = "## Long-term Knowledge\n### Pattern\n- **X**: Y";
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      knowledge,
    });
    expect(prompt).toContain(knowledge);
  });

  test("undefined knowledge is treated the same as empty string", () => {
    const a = buildCompactPrompt({ hasDistillations: false, knowledge: undefined });
    const b = buildCompactPrompt({ hasDistillations: false, knowledge: "" });
    expect(a).toBe(b);
    expect(a).not.toContain("## Long-term Knowledge");
  });

  test("block ordering: distill-reminder → template → knowledge", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: true,
      knowledge: "## Long-term Knowledge\n### Pattern\n- **X**: Y",
    });
    const reminderIdx = prompt.indexOf("Lore has pre-computed");
    const templateIdx = prompt.indexOf("## Goal");
    const knowledgeIdx = prompt.indexOf("## Long-term Knowledge");

    expect(reminderIdx).toBeGreaterThan(-1);
    expect(templateIdx).toBeGreaterThan(reminderIdx);
    expect(knowledgeIdx).toBeGreaterThan(templateIdx);
  });

  // F1b: anchor parameter
  test("emits a <previous-summary> block when previousSummary is provided", () => {
    const priorSummary = "## Goal\n- Refactor auth module\n## Progress\n### Done\n- Wrote tests";
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: priorSummary,
    });
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain(priorSummary);
    expect(prompt).toContain("</previous-summary>");
    // Update-in-place instruction.
    expect(prompt).toContain("Update it using the conversation history above");
  });

  test("no anchor block when previousSummary is undefined (byte-identical to pre-F1b)", () => {
    const withParam = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: undefined,
    });
    const withoutParam = buildCompactPrompt({
      hasDistillations: false,
    });
    expect(withParam).toBe(withoutParam);
    expect(withParam).not.toContain("<previous-summary>");
    expect(withParam).not.toContain("Update it using the conversation history");
  });

  test("empty-string previousSummary is treated as absent", () => {
    const withEmpty = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: "",
    });
    const withoutParam = buildCompactPrompt({
      hasDistillations: false,
    });
    expect(withEmpty).toBe(withoutParam);
    expect(withEmpty).not.toContain("<previous-summary>");
  });

  test("anchor block placement: distill-reminder → anchor → template → knowledge", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: true,
      knowledge: "## Long-term Knowledge\n### Pattern\n- **X**: Y",
      previousSummary: "PRIOR_SUMMARY_TOKEN",
    });
    const reminderIdx = prompt.indexOf("Lore has pre-computed");
    const anchorIdx = prompt.indexOf("<previous-summary>");
    const summaryBodyIdx = prompt.indexOf("PRIOR_SUMMARY_TOKEN");
    const templateIdx = prompt.indexOf("## Goal");
    const knowledgeIdx = prompt.indexOf("## Long-term Knowledge");

    expect(reminderIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeGreaterThan(reminderIdx);
    expect(summaryBodyIdx).toBeGreaterThan(anchorIdx);
    expect(templateIdx).toBeGreaterThan(anchorIdx);
    expect(knowledgeIdx).toBeGreaterThan(templateIdx);
  });
});

// ─── F2: recursiveUser anchor parameter ──────────────────────────────

describe("recursiveUser", () => {
  const segments = [
    { observations: "obs A" },
    { observations: "obs B" },
  ];

  test("no anchor: emits plain consolidation prompt", () => {
    const out = recursiveUser(segments);
    expect(out).toContain("Observation segments to consolidate");
    expect(out).toContain("Segment 1:\nobs A");
    expect(out).toContain("Segment 2:\nobs B");
    expect(out).not.toContain("<previous-meta-summary>");
  });

  test("undefined previousMeta is byte-identical to no parameter", () => {
    const withParam = recursiveUser(segments, undefined);
    const withoutParam = recursiveUser(segments);
    expect(withParam).toBe(withoutParam);
  });

  test("empty-string previousMeta is treated as absent (falsy check)", () => {
    const withEmpty = recursiveUser(segments, "");
    const withoutParam = recursiveUser(segments);
    expect(withEmpty).toBe(withoutParam);
    expect(withEmpty).not.toContain("<previous-meta-summary>");
  });

  test("with anchor: emits <previous-meta-summary> block + new-segments header", () => {
    const priorMeta =
      "### Current State\n- working on auth module\n### Key Decisions\n- chose OAuth2";
    const out = recursiveUser(segments, priorMeta);
    expect(out).toContain("<previous-meta-summary>");
    expect(out).toContain(priorMeta);
    expect(out).toContain("</previous-meta-summary>");
    // Update-in-place instruction.
    expect(out).toContain("Update the anchored meta-summary below");
    expect(out).toContain("Preserve still-true details");
    // New segments still present.
    expect(out).toContain("New observation segments to merge");
    expect(out).toContain("Segment 1:\nobs A");
    expect(out).toContain("Segment 2:\nobs B");
  });

  test("anchor block placement: instruction → anchor → new segments", () => {
    const priorMeta = "PRIOR_META_TOKEN";
    const out = recursiveUser(segments, priorMeta);
    const instructionIdx = out.indexOf("Update the anchored meta-summary");
    const anchorOpenIdx = out.indexOf("<previous-meta-summary>");
    const anchorBodyIdx = out.indexOf(priorMeta);
    const segmentsHeaderIdx = out.indexOf("New observation segments");

    expect(instructionIdx).toBeGreaterThan(-1);
    expect(anchorOpenIdx).toBeGreaterThan(instructionIdx);
    expect(anchorBodyIdx).toBeGreaterThan(anchorOpenIdx);
    expect(segmentsHeaderIdx).toBeGreaterThan(anchorBodyIdx);
  });

  test("with anchor + 0 segments: still emits anchor block (caller's threshold gate)", () => {
    // metaDistill rejects 0-segment input early; recursiveUser doesn't enforce
    // a minimum and produces a valid prompt either way. Pin this to keep the
    // helper's contract independent of the caller's thresholding.
    const out = recursiveUser([], "PRIOR_META");
    expect(out).toContain("<previous-meta-summary>");
    expect(out).toContain("PRIOR_META");
    expect(out).toContain("New observation segments to merge");
  });
});
