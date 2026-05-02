/**
 * Dynamic worker model selection.
 *
 * Background workers (distillation, curation, query expansion) don't need
 * frontier reasoning. This module discovers cheaper models from the same
 * provider and validates their quality via a two-phase comparison:
 *   Phase 1: structural checks (parsability, observation count, token bounds)
 *   Phase 2: LLM judge (session model rates candidate output vs reference)
 *
 * Results are persisted in kv_meta and re-evaluated when the model landscape
 * changes (new models, session model switch, model deprecation).
 */

import { db } from "./db";
import { sha256 } from "#db/driver";
import * as log from "./log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal model info needed for worker selection — provider-agnostic. */
export type ModelInfo = {
  id: string;
  providerID: string;
  cost: { input: number }; // per-token cost
  status: string;
  capabilities: { input: { text: boolean } };
};

/** Result of a worker model validation stored in kv_meta. */
export type WorkerModelResult = {
  modelID: string;
  providerID: string;
  fingerprint: string;
  validatedAt: number;
  judgeScore: number | null; // null = structural-only (no judge run yet)
};

const KV_PREFIX = "lore:worker_model:";

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Select worker model candidates from the available models.
 *
 * Returns up to 2 candidates: cheapest overall + one tier below the session
 * model. The session model itself is included (if it's the cheapest, the list
 * has 1 entry and no comparison is needed).
 */
export function selectWorkerCandidates(
  sessionModel: { id: string; providerID: string; cost: { input: number } },
  providerModels: ModelInfo[],
): ModelInfo[] {
  // Filter: same provider, active, text-capable
  const eligible = providerModels.filter(
    (m) =>
      m.providerID === sessionModel.providerID &&
      m.status === "active" &&
      m.capabilities.input.text,
  );

  if (eligible.length === 0) return [];

  // Sort by cost ascending (cheapest first)
  const sorted = [...eligible].sort((a, b) => a.cost.input - b.cost.input);

  // Cheapest overall
  const cheapest = sorted[0];

  // One tier below session model: the most expensive model that's still
  // cheaper than the session model. If session IS cheapest, this is undefined.
  const belowSession = sorted
    .filter((m) => m.cost.input < sessionModel.cost.input)
    .pop(); // last = most expensive among cheaper ones

  // Deduplicate
  const candidates = new Map<string, ModelInfo>();
  candidates.set(cheapest.id, cheapest);
  if (belowSession && belowSession.id !== cheapest.id) {
    candidates.set(belowSession.id, belowSession);
  }

  // If session model is the cheapest, return just it
  if (cheapest.id === sessionModel.id || cheapest.cost.input >= sessionModel.cost.input) {
    return [cheapest];
  }

  return [...candidates.values()];
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a fingerprint from the model landscape. Changes when:
 * - Models are added or removed from the provider
 * - The session model changes
 */
export function computeModelFingerprint(
  providerID: string,
  sessionModelID: string,
  activeModelIDs: string[],
): string {
  const sorted = [...activeModelIDs].sort();
  return sha256(
    JSON.stringify({ providerID, sessionModelID, modelIDs: sorted }),
  );
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getValidatedWorkerModel(
  providerID: string,
): WorkerModelResult | null {
  const row = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(`${KV_PREFIX}${providerID}`) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as WorkerModelResult;
  } catch {
    return null;
  }
}

export function storeValidatedWorkerModel(result: WorkerModelResult): void {
  const key = `${KV_PREFIX}${result.providerID}`;
  const value = JSON.stringify(result);
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(key, value, value);
}

/**
 * Check whether the stored validation is stale (fingerprint mismatch).
 */
export function isValidationStale(
  stored: WorkerModelResult | null,
  currentFingerprint: string,
): boolean {
  if (!stored) return true;
  return stored.fingerprint !== currentFingerprint;
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

export type StructuralCheckResult = {
  passed: boolean;
  observationCount: number;
  tokenCount: number;
  reason?: string;
};

/**
 * Structural quality check: does the candidate distillation output meet
 * minimum quality thresholds relative to the reference?
 */
export function structuralCheck(
  candidateObservations: string | null,
  referenceObservations: string,
): StructuralCheckResult {
  if (candidateObservations == null || candidateObservations.length === 0) {
    return { passed: false, observationCount: 0, tokenCount: 0, reason: candidateObservations === null ? "parse_failed" : "empty" };
  }

  // Count observation lines (non-empty lines starting with common markers)
  const countObs = (text: string) =>
    text.split("\n").filter((l) => l.trim().length > 0).length;

  const refCount = countObs(referenceObservations);
  const candCount = countObs(candidateObservations);
  const candTokens = Math.ceil(candidateObservations.length / 3);

  // Observation count within ±50% of reference
  if (refCount > 0 && (candCount < refCount * 0.5 || candCount > refCount * 1.5)) {
    return {
      passed: false,
      observationCount: candCount,
      tokenCount: candTokens,
      reason: `observation_count_${candCount}_vs_ref_${refCount}`,
    };
  }

  // Not degenerate: not empty, not >3x reference size
  const refTokens = Math.ceil(referenceObservations.length / 3);
  if (candTokens === 0) {
    return { passed: false, observationCount: candCount, tokenCount: candTokens, reason: "empty" };
  }
  if (refTokens > 0 && candTokens > refTokens * 3) {
    return {
      passed: false,
      observationCount: candCount,
      tokenCount: candTokens,
      reason: `token_count_${candTokens}_vs_ref_${refTokens}_3x`,
    };
  }

  return { passed: true, observationCount: candCount, tokenCount: candTokens };
}

// ---------------------------------------------------------------------------
// Judge prompt
// ---------------------------------------------------------------------------

export const WORKER_JUDGE_SYSTEM = `You are evaluating distillation quality. You will be given a REFERENCE distillation (produced by a capable model) and a CANDIDATE distillation (produced by a cheaper model) of the same conversation segment.

Rate the candidate on a scale of 1-5:
5 = Captures all key facts and decisions, equivalent to reference
4 = Captures most facts, minor omissions
3 = Captures the essential facts, some detail loss acceptable
2 = Missing important facts or technical details
1 = Significantly incomplete or inaccurate

Respond with ONLY a single digit (1-5).`;

export function workerJudgeUser(
  reference: string,
  candidate: string,
): string {
  return `<reference>\n${reference}\n</reference>\n\n<candidate>\n${candidate}\n</candidate>`;
}

/** Parse the judge's score from a response. Returns null on parse failure. */
export function parseJudgeScore(response: string): number | null {
  const match = response.trim().match(/^([1-5])/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Validation orchestration
// ---------------------------------------------------------------------------

import { DISTILLATION_SYSTEM, distillationUser } from "./prompt";
import type { LLMClient } from "./types";

export type ValidationInput = {
  llm: LLMClient;
  providerID: string;
  sessionModelID: string;
  candidates: ModelInfo[];
  /** Recent gen-0 distillation to use as reference (observations text). */
  referenceObservations: string;
  /** Source messages text for re-running distillation with candidates. */
  sourceMessagesText: string;
  /** Date string for the distillation prompt. */
  date: string;
};

/**
 * Run the two-phase quality validation for worker model candidates.
 * Returns the cheapest passing candidate, or null if none pass.
 */
export async function runValidation(
  input: ValidationInput,
): Promise<WorkerModelResult | null> {
  const { llm, candidates, referenceObservations, sourceMessagesText, date } = input;

  const userPrompt = distillationUser({
    messages: sourceMessagesText,
    date,
  });

  for (const candidate of candidates) {
    // Skip the session model — it produced the reference, no need to test
    if (candidate.id === input.sessionModelID) continue;

    // Phase 1: run distillation with candidate model
    let candidateObservations: string | null = null;
    try {
      const raw = await llm.prompt(DISTILLATION_SYSTEM, userPrompt, {
        model: { providerID: candidate.providerID, modelID: candidate.id },
        workerID: "lore-distill",
      });
      if (raw) {
        // Parse <observations>...</observations> block
        const match = raw.match(/<observations>([\s\S]*?)<\/observations>/);
        candidateObservations = match ? match[1].trim() : raw.trim();
      }
    } catch (e) {
      log.warn(`worker model validation: candidate ${candidate.id} failed:`, e);
      continue;
    }

    const structural = structuralCheck(candidateObservations, referenceObservations);
    if (!structural.passed) {
      log.info(
        `worker model validation: ${candidate.id} failed structural check: ${structural.reason}`,
      );
      continue;
    }

    // Phase 2: LLM judge (using session model)
    let judgeScore: number | null = null;
    try {
      const judgeResponse = await llm.prompt(
        WORKER_JUDGE_SYSTEM,
        workerJudgeUser(referenceObservations, candidateObservations!),
        { workerID: "lore-distill" }, // use session model (no model override)
      );
      if (judgeResponse) {
        judgeScore = parseJudgeScore(judgeResponse);
      }
    } catch (e) {
      log.warn(`worker model validation: judge call failed for ${candidate.id}:`, e);
    }

    if (judgeScore !== null && judgeScore < 3) {
      log.info(
        `worker model validation: ${candidate.id} failed judge (score=${judgeScore})`,
      );
      continue;
    }

    // Candidate passed both phases
    const fingerprint = computeModelFingerprint(
      input.providerID,
      input.sessionModelID,
      candidates.map((c) => c.id),
    );

    const result: WorkerModelResult = {
      modelID: candidate.id,
      providerID: candidate.providerID,
      fingerprint,
      validatedAt: Date.now(),
      judgeScore,
    };
    storeValidatedWorkerModel(result);
    log.info(
      `worker model validated: ${candidate.id} (judge=${judgeScore}) for provider ${input.providerID}`,
    );
    return result;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Effective worker model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective worker model for a given provider.
 * Priority: explicit config > validated auto-selection > session model (fallback).
 */
export function resolveWorkerModel(
  providerID: string,
  configWorkerModel?: { providerID: string; modelID: string },
  configModel?: { providerID: string; modelID: string },
): { providerID: string; modelID: string } | undefined {
  // Explicit override wins
  if (configWorkerModel) return configWorkerModel;

  // Check for validated auto-selection
  const validated = getValidatedWorkerModel(providerID);
  if (validated) {
    return { providerID: validated.providerID, modelID: validated.modelID };
  }

  // Fall back to the session model config (or undefined = host default)
  return configModel;
}
