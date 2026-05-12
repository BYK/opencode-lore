/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * On startup, the extension probes for an existing Lore gateway and, if
 * none is found, starts one in-process by importing @loreai/gateway.
 * It then redirects compatible provider URLs through the gateway and
 * registers a single Pi-specific hook (session_before_compact) that the
 * gateway cannot handle via HTTP interception. All other memory features
 * (LTM injection, gradient transforms, temporal capture, recall, idle
 * work) are handled exclusively by the gateway pipeline.
 *
 * If the gateway cannot be started, the extension logs an error and
 * becomes inert — no hooks are registered and Pi runs without memory
 * features.
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
 * - openai-responses API   → gateway POST /v1/responses
 *
 * Providers using other protocols (Google SDK, AWS Bedrock SDK,
 * Mistral conversations) are not redirected.
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
  "zai",
  "minimax",
  "minimax-cn",
  "kimi-coding",
  "vercel-ai-gateway",
  // openai-responses API
  "openai",
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
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 * The published CJS bundle includes Node.js polyfills that shim Bun.serve()
 * to node:http.createServer(), so this works under both Bun and Node.js.
 */
async function startInProcess(gatewayBase: string): Promise<boolean> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { loadConfig, startServer } = await import(/* webpackIgnore: true */ gw);
    const config = loadConfig();

    // Parse the expected port from gatewayBase so the server binds there.
    const url = new URL(gatewayBase);
    if (url.port) config.port = Number(url.port);

    startServer(config);
    // startServer is synchronous — if it didn't throw, the server is
    // listening. Verify with a quick health check.
    return await probeGateway(gatewayBase, 1000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Port-in-use means something is already on that port but our probe
    // didn't detect it (race). Treat as success — the proxy is available.
    // Match both Node's EADDRINUSE and Bun's "Is port N in use?" format.
    if (/EADDRINUSE/i.test(msg) || /port\b.*\bin use/i.test(msg)) {
      return await probeGateway(gatewayBase, 1000);
    }
    console.info("pi: failed to start gateway in-process:", msg);
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
    if (await probeGateway(gatewayBase)) {
      console.info(`pi: gateway detected at ${gatewayBase}`);
      gatewayActive = true;
    } else {
      console.info(`pi: starting gateway in-process at ${gatewayBase}…`);
      if (await startInProcess(gatewayBase)) {
        console.info(`pi: gateway started in-process at ${gatewayBase}`);
        gatewayActive = true;
      }
    }
  }

  if (!gatewayActive && !inTestEnv && process.env.LORE_GATEWAY_MODE !== "0") {
    const msg =
      "Lore gateway failed to start — memory features are unavailable. " +
      "Ensure @loreai/gateway is installed or start the gateway manually.";
    console.error("pi:", msg);
    return;
  }

  if (!gatewayActive) return;

  console.info(`pi: gateway active — routing providers through ${gatewayBase}`);

  // ---------------------------------------------------------------------------
  // Session tracking — used for provider header injection and compaction.
  // ---------------------------------------------------------------------------

  let projectPath = process.cwd();
  let currentSessionID = sessionIDFor(undefined);

  /**
   * Register (or re-register) all gateway-compatible providers with the
   * current session header. Called on startup and again on session_start
   * once the real session ID is known.
   */
  function registerProviders(): void {
    for (const provider of GATEWAY_PROVIDERS) {
      pi.registerProvider(provider, {
        baseUrl: gatewayBase,
        headers: { "x-lore-session-id": currentSessionID },
      });
    }
  }

  // Initial registration with ephemeral session ID.
  registerProviders();

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    projectPath = ctx.cwd;
    const newID = sessionIDFor(ctx.sessionManager.getSessionFile());
    if (newID !== currentSessionID) {
      currentSessionID = newID;
      // Re-register with the real session ID so all subsequent provider
      // requests carry the correct x-lore-session-id header.
      registerProviders();
    }
  });

  // ---------------------------------------------------------------------------
  // Compaction override — session_before_compact
  //
  // Pi's compaction goes through its extension API, not HTTP. The gateway
  // intercepts compaction via HTTP request patterns (Claude Code-specific),
  // which don't match Pi's internal compaction flow. This hook calls the
  // gateway's POST /v1/compact endpoint to get a full LLM-synthesized
  // compaction summary (force-distill + knowledge + compact prompt).
  // ---------------------------------------------------------------------------

  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      _ctx,
    ): Promise<SessionBeforeCompactResult | undefined> => {
      try {
        const res = await fetch(`${gatewayBase}/v1/compact`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lore-session-id": currentSessionID,
          },
          body: JSON.stringify({
            project_path: projectPath,
            previous_summary: event.preparation.previousSummary,
          }),
        });

        if (!res.ok) {
          // Gateway returned an error — fall back to Pi's default compaction.
          const errBody = await res.text().catch(() => "");
          console.error(
            `pi: compaction endpoint returned ${res.status}: ${errBody}`,
          );
          return undefined;
        }

        const { summary } = (await res.json()) as { summary: string };
        if (!summary) return undefined;

        return {
          compaction: {
            summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      } catch (err) {
        console.error("pi: custom compaction failed, falling back to default:", err);
        return undefined;
      }
    },
  );
}

/** Named export for users who prefer `import { LorePiExtension }` style. */
export { lorePiExtension as LorePiExtension };
