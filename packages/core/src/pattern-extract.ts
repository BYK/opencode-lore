/**
 * Lightweight regex-based pattern extraction from distillation observations.
 *
 * Scans for decision/preference/choice patterns and returns structured
 * extractions that can be stored as knowledge entries. No LLM required.
 *
 * Patterns target how decisions and preferences are typically expressed
 * in distilled engineering context:
 *   - "decided to use X"
 *   - "chose X over Y"
 *   - "switched from X to Y"
 *   - "prefers X for Y"
 *   - "going with X because Y"
 *
 * Also matches process instruction patterns from distilled observations
 * where the observer normalizes user assertions:
 *   - "User stated always X"
 *   - "User said never Y"
 *   - "User stated make sure to X"
 *   - "User stated don't forget to X"
 *
 * Extracted entries participate in the normal curator cycle — the curator
 * can consolidate or remove them based on actual value. The extraction is
 * a cheap seed, not a permanent fixture.
 */

export type ExtractedPattern = {
  category: "decision" | "preference";
  /** Short descriptive title, e.g. "Chose PostgreSQL over MySQL". */
  title: string;
  /** Full matched text for context. */
  content: string;
};

type PatternDef = {
  regex: RegExp;
  category: "decision" | "preference";
  titleFn: (match: RegExpMatchArray) => string;
};

const PATTERNS: PatternDef[] = [
  // Decision patterns
  {
    regex: /decided to (?:use |switch to |go with |adopt )(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Decided to use ${m[1].trim()}`,
  },
  {
    regex: /chose (.+?) over (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Chose ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    regex: /switched from (.+?) to (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Switched from ${m[1].trim()} to ${m[2].trim()}`,
  },
  {
    regex: /going with (.+?) (?:because|for|due to)(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Going with ${m[1].trim()}`,
  },
  {
    regex: /migrat(?:ed|ing) (?:from .+? )?to (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Migrated to ${m[1].trim()}`,
  },
  {
    regex: /adopted (.+?) (?:for|as|instead)(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Adopted ${m[1].trim()}`,
  },

  // Preference patterns
  {
    regex: /prefers? (.+?) (?:over|to|instead of|rather than) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Prefers ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:always |usually |typically )(?:use|prefer|go with) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Typically uses ${m[1].trim()}`,
  },

  // Declarative preference patterns — match distilled observations recording
  // user practices/conventions stated as facts rather than directives.
  // Uses "uses/likes" but NOT "prefers" to avoid overlap with the comparison
  // pattern above ("prefers X over/to Y").
  {
    regex:
      /(?:user |team |we )(?:uses?|likes?) (.+?) (?:for|as|when|in) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Uses ${m[1].trim()} for ${m[2].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:doesn't|does not|don't|do not) (?:like|use|want) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Avoids ${m[1].trim()}`,
  },
  {
    regex:
      /(?:the |our |project )convention is (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Convention: ${m[1].trim()}`,
  },

  // Process instruction patterns — match distilled observations recording
  // user assertions about workflow/process rules. The distillation observer
  // normalizes user instructions into "User stated always X" phrasing.
  // These require "stated/asserted/said" to avoid overlapping with the
  // existing "typically uses" pattern above (which already handles
  // "user always use/prefer/go with X").
  {
    regex: /(?:user |team |we )(?:stated |asserted |said )(?:to )?always (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Always ${m[1].trim()}`,
  },
  {
    regex: /(?:user |team |we )(?:stated |asserted |said )(?:to )?never (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Never ${m[1].trim()}`,
  },
  {
    regex: /(?:user |team |we )(?:stated |asserted |said )(?:to )?make sure to (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Make sure to ${m[1].trim()}`,
  },
  {
    regex: /(?:user |team |we )(?:stated |asserted |said )(?:to )?(?:don't|do not) forget (?:to )?(.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Always ${m[1].trim()}`,
  },
];

/**
 * Extract decision/preference patterns from distillation observations text.
 *
 * Returns structured entries suitable for `ltm.create()`. Deduplicates by
 * lowercased title within a single call.
 *
 * @param observations  The distilled observations text to scan.
 * @returns             Array of extracted patterns (may be empty).
 */
export function extractPatterns(observations: string): ExtractedPattern[] {
  const results: ExtractedPattern[] = [];
  const seen = new Set<string>();

  for (const { regex, category, titleFn } of PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    regex.lastIndex = 0;
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(observations)) !== null) {
      // Skip false positives: template placeholders (e.g. "X", "Y"),
      // quoted fragments, or very short captures that are clearly not
      // real technology/tool names. Plain apostrophes (') are allowed
      // since they appear in valid names like "Bun's test runner".
      const captures = match.slice(1);
      if (captures.some((c) => c && (c.trim().length <= 2 || /["\u201C\u201D`\u2018\u2019]/.test(c)))) continue;

      const title = titleFn(match);
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ category, title, content: match[0].trim() });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Action tag extraction and cross-session counting
// ---------------------------------------------------------------------------

/** Regex to match action tags like [requested-tests], [corrected-style], etc. */
const ACTION_TAG_RE = /\[([a-z]+-[a-z-]+)\]/g;

/**
 * Extract action tags from distillation observation text.
 * Returns deduplicated tag names (e.g., "requested-tests", "corrected-style").
 */
export function extractActionTags(observations: string): string[] {
  const tags = new Set<string>();
  ACTION_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_TAG_RE.exec(observations)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

/** Map from tag name to human-readable preference title. */
const TAG_TITLE_MAP: Record<string, string> = {
  "requested-tests": "Always write tests alongside implementation",
  "corrected-style": "Follow consistent code style conventions",
  "rejected-approach": "Respect explicitly rejected approaches",
  "requested-error-handling": "Always add proper error handling with try/catch and status codes",
  "requested-review": "Review code before committing",
  "enforced-workflow": "Follow the established git workflow (branch, PR, review)",
};

/**
 * Generate a preference title from a tag name.
 * Uses the predefined map for common tags, falls back to title-casing.
 */
export function tagToTitle(tag: string): string {
  if (TAG_TITLE_MAP[tag]) return TAG_TITLE_MAP[tag];
  // Fallback: convert kebab-case to title case
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
