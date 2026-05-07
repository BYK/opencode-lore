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
      const title = titleFn(match);
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ category, title, content: match[0].trim() });
    }
  }

  return results;
}
