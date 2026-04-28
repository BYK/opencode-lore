import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

// Local-dev-only contract tests that assert upstream OpenCode still exposes
// the hooks and patterns Lore depends on. These tests read the upstream
// source directly from the sibling checkout at ~/Code/opencode — they skip
// cleanly when the upstream repo isn't present (CI, fresh clones, other
// dev machines).
//
// Why: Lore's gradient transform rides experimental.chat.messages.transform,
// which upstream made fire during compaction in commit 4cb29967f. If
// upstream ever reverts or renames the hook, these tests fail loudly on
// the developer's machine instead of Lore's gradient silently losing
// compaction-path coverage.

const UPSTREAM_ROOT = "/home/byk/Code/opencode";
const UPSTREAM_COMPACTION = `${UPSTREAM_ROOT}/packages/opencode/src/session/compaction.ts`;
const UPSTREAM_OVERFLOW = `${UPSTREAM_ROOT}/packages/opencode/src/session/overflow.ts`;
const UPSTREAM_PROVIDER_ERROR = `${UPSTREAM_ROOT}/packages/opencode/src/provider/error.ts`;

const hasUpstream = existsSync(UPSTREAM_COMPACTION);

test.skipIf(!hasUpstream)(
  "upstream compaction invokes experimental.chat.messages.transform on the head",
  () => {
    const source = readFileSync(UPSTREAM_COMPACTION, "utf8");
    expect(source).toContain("experimental.chat.messages.transform");
  },
);

test.skipIf(!hasUpstream)(
  "upstream compaction invokes experimental.session.compacting hook",
  () => {
    const source = readFileSync(UPSTREAM_COMPACTION, "utf8");
    expect(source).toContain("experimental.session.compacting");
  },
);

test.skipIf(!hasUpstream)(
  "upstream overflow.ts exports usable() and isOverflow()",
  () => {
    const source = readFileSync(UPSTREAM_OVERFLOW, "utf8");
    expect(source).toContain("export function usable");
    expect(source).toContain("export function isOverflow");
  },
);

test.skipIf(!hasUpstream)(
  "upstream provider/error.ts contains OVERFLOW_PATTERNS array",
  () => {
    const source = readFileSync(UPSTREAM_PROVIDER_ERROR, "utf8");
    expect(source).toContain("OVERFLOW_PATTERNS");
    // Spot-check a few provider-specific regexes Lore mirrors
    expect(source).toContain("prompt is too long");
    expect(source).toContain("request entity too large");
    expect(source).toContain("context_length_exceeded");
  },
);
