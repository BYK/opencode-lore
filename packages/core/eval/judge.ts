/**
 * Multi-metric LLM-as-judge for the Lore eval suite.
 *
 * Scores hypotheses against reference answers on a 1-5 scale per criterion,
 * then computes a weighted composite score. Supports dimension-specific
 * rubrics with custom criteria.
 */
import type {
  ScoringRubric,
  ScoringCriterion,
  JudgeResult,
  EvalQuestion,
} from "./types";
import type { EvalLLMClient } from "./llm-backend";

// ---------------------------------------------------------------------------
// Universal criteria (included in every rubric)
// ---------------------------------------------------------------------------

export const FACTUAL_ACCURACY: ScoringCriterion = {
  name: "factual_accuracy",
  description: "Are the facts in the answer correct?",
  scale: {
    1: "Key facts wrong or fabricated",
    3: "Core facts correct, minor errors in details",
    5: "All facts correct including specific values, names, paths",
  },
};

export const COMPLETENESS: ScoringCriterion = {
  name: "completeness",
  description: "Does the answer cover all key information from the reference?",
  scale: {
    1: "Missing most key information from the reference answer",
    3: "Captures the main point but misses supporting details",
    5: "Covers all key information from the reference answer",
  },
};

// ---------------------------------------------------------------------------
// Dimension-specific criteria
// ---------------------------------------------------------------------------

export const SPECIFICITY: ScoringCriterion = {
  name: "specificity",
  description: "How specific and precise is the answer?",
  scale: {
    1: "Vague or generic answer",
    3: "Correct general direction with some specifics",
    5: "Exact values, paths, names, error messages preserved",
  },
};

export const CONTEXT_AVAILABILITY: ScoringCriterion = {
  name: "context_availability",
  description: "Is the information accessible (via context or recall)?",
  scale: {
    1: "Information completely lost",
    3: "Information partially available (vague or incomplete)",
    5: "Information fully accessible (via context or recall)",
  },
};

export const DISTINCTION_PRESERVATION: ScoringCriterion = {
  name: "distinction_preservation",
  description:
    "Can the answer distinguish between similar but different outputs?",
  scale: {
    1: "Cannot distinguish between similar but different outputs",
    3: "Identifies some differences between repeated outputs",
    5: "Correctly distinguishes all unique information across repeated similar outputs",
  },
};

export const TEMPORAL_ATTRIBUTION: ScoringCriterion = {
  name: "temporal_attribution",
  description:
    "Can the answer correctly attribute facts to specific sessions?",
  scale: {
    1: "Cannot identify which session information came from",
    3: "Generally aware of session boundaries",
    5: "Correctly attributes facts to specific sessions and their temporal order",
  },
};

export const CROSS_REFERENCE_QUALITY: ScoringCriterion = {
  name: "cross_reference_quality",
  description: "Can the answer connect related facts across sessions?",
  scale: {
    1: "Cannot connect related facts across sessions",
    3: "Makes some connections but misses relationships",
    5: "Correctly synthesizes information across session boundaries",
  },
};

export const PREFERENCE_RECALL: ScoringCriterion = {
  name: "preference_recall",
  description: "Does the answer correctly recall user preferences?",
  scale: {
    1: "Cannot recall the preference",
    3: "Recalls the general area but not the specific preference",
    5: "Recalls the exact preference with correct details",
  },
};

export const CONSISTENCY: ScoringCriterion = {
  name: "consistency",
  description: "Is the answer consistent with all stated preferences?",
  scale: {
    1: "Contradicts stated preferences",
    3: "Partially follows preferences",
    5: "Fully consistent with all stated preferences",
  },
};

export const CONFIDENCE_RANKING: ScoringCriterion = {
  name: "confidence_ranking",
  description:
    "Does the answer correctly differentiate strong vs weak preferences?",
  scale: {
    1: "Treats casual mentions the same as strong directives",
    3: "Some differentiation between strong and weak preferences",
    5: 'Correctly prioritizes strong directives ("never", "always") over mild preferences',
  },
};

export const PATTERN_DETECTION: ScoringCriterion = {
  name: "pattern_detection",
  description: "Can the answer detect behavioral patterns?",
  scale: {
    1: "Cannot detect behavioral patterns",
    3: "Detects some patterns but misses others",
    5: "Correctly identifies all consistent behavioral patterns",
  },
};

export const CURRENCY: ScoringCriterion = {
  name: "currency",
  description:
    "Does the answer reflect the current (most recent) preference?",
  scale: {
    1: "Recalls stale/superseded preference",
    3: "Uncertain or mentions both old and new",
    5: "Correctly reports current preference with awareness it changed",
  },
};

export const CROSS_PROJECT_RECALL: ScoringCriterion = {
  name: "cross_project_recall",
  description:
    "Does the answer recall knowledge from other projects?",
  scale: {
    1: "No awareness of knowledge from other projects",
    3: "Vague awareness that something similar was encountered",
    5: "Correctly recalls specific knowledge from the other project with attribution",
  },
};

export const RELEVANCE_MATCHING: ScoringCriterion = {
  name: "relevance_matching",
  description:
    "Does the answer correctly identify when cross-project knowledge is relevant?",
  scale: {
    1: "Surfaces irrelevant cross-project knowledge",
    3: "Surfaces somewhat related knowledge",
    5: "Correctly identifies when cross-project knowledge is relevant to current context",
  },
};

export const CROSS_PROJECT_AVAILABILITY: ScoringCriterion = {
  name: "cross_project_availability",
  description: "Do preferences transfer across projects?",
  scale: {
    1: "Preferences only available in the project where stated",
    3: "Some preferences transfer, others don't",
    5: "All applicable preferences consistently transfer across projects",
  },
};

// ---------------------------------------------------------------------------
// Pre-built rubrics
// ---------------------------------------------------------------------------

export const RUBRICS = {
  /** CM-1: Long session early detail retention */
  contextRetention: {
    criteria: [FACTUAL_ACCURACY, COMPLETENESS, SPECIFICITY],
    weights: {
      factual_accuracy: 0.5,
      completeness: 0.3,
      specificity: 0.2,
    },
  } satisfies ScoringRubric,

  /** CM-2: Tool output deduplication */
  toolDedup: {
    criteria: [FACTUAL_ACCURACY, COMPLETENESS, DISTINCTION_PRESERVATION],
    weights: {
      factual_accuracy: 0.4,
      completeness: 0.3,
      distinction_preservation: 0.3,
    },
  } satisfies ScoringRubric,

  /** CM-3: Gradient layer escalation */
  layerEscalation: {
    criteria: [FACTUAL_ACCURACY, COMPLETENESS, CONTEXT_AVAILABILITY],
    weights: {
      factual_accuracy: 0.4,
      completeness: 0.4,
      context_availability: 0.2,
    },
  } satisfies ScoringRubric,

  /** MSR-1/2/3: Multi-session recall */
  multiSessionRecall: {
    criteria: [
      FACTUAL_ACCURACY,
      COMPLETENESS,
      TEMPORAL_ATTRIBUTION,
      CROSS_REFERENCE_QUALITY,
    ],
    weights: {
      factual_accuracy: 0.3,
      completeness: 0.3,
      temporal_attribution: 0.2,
      cross_reference_quality: 0.2,
    },
  } satisfies ScoringRubric,

  /** PR-1: Explicit preferences */
  explicitPreference: {
    criteria: [PREFERENCE_RECALL, CONSISTENCY, CONFIDENCE_RANKING],
    weights: {
      preference_recall: 0.4,
      consistency: 0.3,
      confidence_ranking: 0.3,
    },
  } satisfies ScoringRubric,

  /** PR-2: Implicit preferences */
  implicitPreference: {
    criteria: [PREFERENCE_RECALL, CONSISTENCY, PATTERN_DETECTION],
    weights: {
      preference_recall: 0.4,
      consistency: 0.4,
      pattern_detection: 0.2,
    },
  } satisfies ScoringRubric,

  /** PR-3: Preference evolution */
  preferenceEvolution: {
    criteria: [CURRENCY, FACTUAL_ACCURACY, COMPLETENESS],
    weights: {
      currency: 0.5,
      factual_accuracy: 0.3,
      completeness: 0.2,
    },
  } satisfies ScoringRubric,

  /** CP-1/2: Cross-project knowledge */
  crossProject: {
    criteria: [CROSS_PROJECT_RECALL, RELEVANCE_MATCHING, FACTUAL_ACCURACY],
    weights: {
      cross_project_recall: 0.4,
      relevance_matching: 0.3,
      factual_accuracy: 0.3,
    },
  } satisfies ScoringRubric,

  /** CP-3: Cross-project preferences */
  crossProjectPreference: {
    criteria: [
      PREFERENCE_RECALL,
      CONSISTENCY,
      CROSS_PROJECT_AVAILABILITY,
    ],
    weights: {
      preference_recall: 0.4,
      consistency: 0.3,
      cross_project_availability: 0.3,
    },
  } satisfies ScoringRubric,
} as const;

// ---------------------------------------------------------------------------
// Judge implementation
// ---------------------------------------------------------------------------

function buildCriteriaDescription(rubric: ScoringRubric): string {
  return rubric.criteria
    .map(
      (c) =>
        `**${c.name}** (weight ${rubric.weights[c.name]}): ${c.description}\n` +
        `  1 = ${c.scale[1]}\n` +
        `  3 = ${c.scale[3]}\n` +
        `  5 = ${c.scale[5]}`,
    )
    .join("\n\n");
}

const JUDGE_SYSTEM = `You are evaluating an AI assistant's answer about a coding session.
Score each criterion on a 1-5 integer scale. Return ONLY valid JSON:
{
  "scores": { "<criterion_name>": <1-5>, ... },
  "reasoning": "<brief explanation of the scores, 2-3 sentences>"
}

IMPORTANT: The reference answer is a MINIMUM — the hypothesis may include additional
correct information beyond the reference. Extra correct details should NOT be penalized.
Only penalize facts that directly CONTRADICT the reference or are clearly fabricated.
A hypothesis that covers all reference points PLUS additional accurate context should
score 5 on factual_accuracy and completeness.

Do NOT include any text outside the JSON object.`;

function buildJudgeUser(
  question: string,
  referenceAnswer: string,
  hypothesis: string,
  rubric: ScoringRubric,
): string {
  const criteria = buildCriteriaDescription(rubric);
  return (
    `## Scoring Criteria\n\n${criteria}\n\n` +
    `## Question\n${question}\n\n` +
    `## Reference Answer\n${referenceAnswer}\n\n` +
    `## Hypothesis (answer to evaluate)\n${hypothesis}\n\n` +
    `Score each criterion on a 1-5 scale. Return JSON only.`
  );
}

function computeComposite(
  scores: Record<string, number>,
  weights: Record<string, number>,
): number {
  let total = 0;
  let weightSum = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const score = scores[name];
    if (score !== undefined) {
      total += score * weight;
      weightSum += weight;
    }
  }
  return weightSum > 0 ? Math.round((total / weightSum) * 100) / 100 : 0;
}

/**
 * Score a hypothesis against a reference answer using an LLM judge.
 *
 * In fixture mode (no LLM client), returns a neutral score of 3.0 for all
 * criteria — fixture mode is for regression detection, not absolute quality.
 */
export async function judge(
  question: EvalQuestion,
  hypothesis: string,
  llm?: EvalLLMClient,
): Promise<JudgeResult> {
  const { rubric } = question;

  // Fixture mode: return neutral scores
  if (!llm) {
    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      scores[c.name] = 3;
    }
    return {
      scores,
      compositeScore: 3.0,
      reasoning: "Fixture mode — no LLM judge available.",
      tokensUsed: 0,
    };
  }

  const userPrompt = buildJudgeUser(
    question.question,
    question.referenceAnswer,
    hypothesis,
    rubric,
  );

  const result = await llm.prompt(JUDGE_SYSTEM, userPrompt, {
    model: llm.config.judgeModel,
    maxTokens: 1024,
    temperature: 0,
  });

  // Parse JSON response
  let parsed: { scores: Record<string, number>; reasoning: string };
  try {
    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = result.text.trim();
    const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      jsonStr = fenced[1].trim();
    }
    parsed = JSON.parse(jsonStr);
  } catch {
    // If parsing fails, return error scores
    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      scores[c.name] = 1;
    }
    return {
      scores,
      compositeScore: 1.0,
      reasoning: `Judge response parsing failed: ${result.text.slice(0, 200)}`,
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }

  // Clamp scores to 1-5
  const scores: Record<string, number> = {};
  for (const c of rubric.criteria) {
    const raw = parsed.scores[c.name] ?? 3;
    scores[c.name] = Math.max(1, Math.min(5, Math.round(raw)));
  }

  return {
    scores,
    compositeScore: computeComposite(scores, rubric.weights),
    reasoning: parsed.reasoning ?? "",
    tokensUsed: result.inputTokens + result.outputTokens,
  };
}
