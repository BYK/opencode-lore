import { describe, test, expect } from "bun:test";
import { buildCompactPrompt, COMPACT_SUMMARY_TEMPLATE } from "../src/prompt";

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
});
