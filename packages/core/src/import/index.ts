/**
 * Conversation import system — detects and imports knowledge from
 * external AI coding agent conversation histories.
 */

// Types
export type {
  ConversationChunk,
  DetectedSession,
  DetectionResult,
  AgentHistoryProvider,
} from "./types";

// Detection
export { detectAll } from "./detect";

// Provider registry
export {
  registerProvider,
  getProviders,
  getProvider,
  clearProviders,
} from "./providers";

// Extraction (lazy — avoid pulling in LLM/curator deps for detection-only use)
export { extractKnowledge, type ExtractionProgress, type ExtractionResult } from "./extract";

// Idempotency
export {
  isImported,
  recordImport,
  computeHash,
  listImports,
  type ImportRecord,
} from "./history";

// Register built-in providers on first import.
// Each provider module calls registerProvider() at load time.
import "./providers/claude-code";
import "./providers/codex";
import "./providers/opencode";
import "./providers/cline";
import "./providers/continue";
import "./providers/pi";
import "./providers/aider";
