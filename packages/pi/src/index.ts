/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * Gateway-only mode: the extension detects the Lore gateway, redirects
 * compatible provider URLs through it, and registers a single Pi-specific
 * hook (session_before_compact) that the gateway cannot handle via HTTP
 * interception. All other memory features (LTM injection, gradient
 * transforms, temporal capture, recall, idle work) are handled
 * exclusively by the gateway pipeline.
 *
 * If the gateway is not running, the extension logs an error and becomes
 * inert — no hooks are registered and Pi runs without memory features.
 *
 * Installation (in user's `~/.pi/agent/extensions/`):
 *   import lore from "@loreai/pi";
 *   export default lore;
 *
 * Or as a Pi package:
 *   pi install npm:@loreai/pi
 */
import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { distillation, log } from "@loreai/core";

// Pi doesn't re-export these event result types at the top level — inline their
// minimal shape here to avoid depending on an internal package path.
type SessionBeforeCompactResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

/**
 * Providers whose wire protocol the Lore gateway can proxy.
 *
 * - anthropic-messages API → gateway POST /v1/messages
 * - openai-completions API → gateway POST /v1/chat/completions
 *
 * Providers using other protocols (Google SDK, AWS Bedrock SDK, OpenAI
 * responses API, Mistral conversations) are not redirected.
 */
const GATEWAY_PROVIDERS = [
  // anthropic-messages API
  "anthropic",
  "fireworks",
  "github-copilot",
  // openai-completions API
  "deepseek",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "huggingface",
];

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay Pi startup noticeably.
 */
async function probeGateway(baseURL: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Derive a stable session identifier from Pi's current session file path.
 */
function sessionIDFor(sessionFile: string | undefined): string {
  if (!sessionFile) return `pi-ephemeral-${process.pid}`;
  return `pi-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)}`;
}

/**
 * Pi extension entry point.
 *
 * Pi calls this function when loading the extension — either via `pi -e`
 * or after `pi install`. Detects the Lore gateway and, if available,
 * redirects provider URLs and registers compaction override.
 */
export default async function lorePiExtension(pi: ExtensionAPI): Promise<void> {
  const gatewayBase =
    (process.env.LORE_GATEWAY_URL ?? "http://127.0.0.1:6969").replace(/\/$/, "");

  let gatewayActive = false;
  const inTestEnv =
    process.env.NODE_ENV === "test" ||
    process.env.LORE_GATEWAY_MODE === "test";

  if (process.env.LORE_GATEWAY_MODE !== "0" && !inTestEnv) {
    gatewayActive = await probeGateway(gatewayBase);
  }

  if (!gatewayActive && !inTestEnv && process.env.LORE_GATEWAY_MODE !== "0") {
    const msg =
      "Lore gateway not detected — memory features are unavailable. " +
      "Run Pi through the gateway with `lore run pi`, or start the gateway separately.";
    log.error("pi:", msg);
    return;
  }

  if (!gatewayActive) return;

  log.info(`pi: gateway active — routing providers through ${gatewayBase}`);

  // Redirect all gateway-compatible providers through the proxy.
  for (const provider of GATEWAY_PROVIDERS) {
    pi.registerProvider(provider, { baseUrl: gatewayBase });
  }

  // ---------------------------------------------------------------------------
  // Minimal session tracking — only needed by session_before_compact below.
  // ---------------------------------------------------------------------------

  let projectPath = process.cwd();
  let currentSessionID = sessionIDFor(undefined);

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    projectPath = ctx.cwd;
    currentSessionID = sessionIDFor(ctx.sessionManager.getSessionFile());
  });

  // ---------------------------------------------------------------------------
  // Compaction override — session_before_compact
  //
  // Pi's compaction goes through its extension API, not HTTP. The gateway
  // intercepts compaction via HTTP request patterns (Claude Code-specific),
  // which don't match Pi's internal compaction flow. The extension provides
  // Lore's distillation-aware summaries directly.
  // ---------------------------------------------------------------------------

  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      _ctx,
    ): Promise<SessionBeforeCompactResult | undefined> => {
      try {
        const summaries = distillation.loadForSession(
          projectPath,
          currentSessionID,
        );
        if (summaries.length === 0) return undefined;

        const summaryText = summaries
          .map((s) => s.observations)
          .join("\n\n---\n\n");

        return {
          compaction: {
            summary: summaryText,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      } catch (err) {
        log.error("pi: custom compaction failed, falling back to default:", err);
        return undefined;
      }
    },
  );
}

/** Named export for users who prefer `import { LorePiExtension }` style. */
export { lorePiExtension as LorePiExtension };
