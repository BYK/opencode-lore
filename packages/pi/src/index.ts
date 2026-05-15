/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * On startup, the extension probes for an existing Lore gateway server
 * and, if none is found, starts one in-process by importing
 * @loreai/gateway. It then redirects compatible provider URLs through
 * the gateway and registers a Pi-specific compaction hook
 * (session_before_compact) that requires Pi's extension API. All other
 * memory features (LTM injection, gradient transforms, temporal capture,
 * recall, idle work) are handled by the gateway pipeline.
 *
 * If the gateway server cannot be reached, the extension logs an error
 * and becomes inert — no hooks are registered and Pi runs without
 * memory features.
 *
 * Installation (in user's `~/.pi/agent/extensions/`):
 *   import lore from "@loreai/pi";
 *   export default lore;
 *
 * Or as a Pi package:
 *   pi install npm:@loreai/pi
 */
import { createHash } from "node:crypto";
import { getGitRemote } from "@loreai/core";
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

/** Default ports to probe when looking for a running gateway (must match gateway defaults). */
const KNOWN_GATEWAY_PORTS = [3207, 5673];

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
 * Resolve the gateway URL by probing known ports and reading the port file.
 *
 * Order: LORE_GATEWAY_URL env var → port file → known default ports (3207, 5673).
 * Returns the URL of a running gateway, or null if none found.
 */
async function resolveGatewayUrl(): Promise<string | null> {
  // 0. Remote gateway — skip local discovery/startup entirely.
  if (process.env.LORE_REMOTE_URL) {
    const url = process.env.LORE_REMOTE_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    console.info(`pi: remote gateway at ${url} not reachable, falling through to local discovery`);
  }

  // 1. Explicit env var — probe it to verify it's actually reachable.
  if (process.env.LORE_GATEWAY_URL) {
    const url = process.env.LORE_GATEWAY_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    // env var set but gateway unreachable — fall through to discovery
  }

  // 2. Build probe list: port file first (handles random port), then known defaults.
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    /* gateway package not available — skip port file */
  }
  for (const p of KNOWN_GATEWAY_PORTS) probePorts.add(p);

  // 3. Probe each port.
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }

  return null;
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 * The published CJS bundle includes Node.js polyfills that shim Bun.serve()
 * to node:http.createServer(), so this works under both Bun and Node.js.
 *
 * Uses startGateway() which handles the full port fallback chain
 * (3207 → 5673 → random) and port file management automatically.
 * Returns the URL of the started gateway, or null on failure.
 */
async function startInProcess(): Promise<string | null> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true });
    const url = `http://127.0.0.1:${handle.port}`;

    if (!handle.owned) {
      console.info(`pi: reusing existing gateway at ${url}`);
    }

    return url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.info("pi: failed to start gateway in-process:", msg);
    return null;
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
  let gatewayBase = "";
  let loreActive = false;
  const loreDisabled =
    process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";
  const inTestEnv = process.env.NODE_ENV === "test";

  if (!loreDisabled && !inTestEnv) {
    // Try to find a running gateway first (probes port file + known ports).
    const existingUrl = await resolveGatewayUrl();
    if (existingUrl) {
      console.info(`pi: gateway detected at ${existingUrl}`);
      gatewayBase = existingUrl;
      loreActive = true;
    } else {
      // No running gateway — start one in-process (handles fallback chain).
      console.info("pi: starting gateway in-process…");
      const startedUrl = await startInProcess();
      if (startedUrl) {
        console.info(`pi: gateway started in-process at ${startedUrl}`);
        gatewayBase = startedUrl;
        loreActive = true;
      }
    }
  }

  if (!loreActive && !inTestEnv && !loreDisabled) {
    const msg =
      "Lore failed to start — memory features are unavailable. " +
      "Ensure @loreai/gateway is installed.";
    console.error("pi:", msg);
    return;
  }

  if (!loreActive) return;

  console.info(`pi: routing providers through ${gatewayBase}`);

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
    const headers: Record<string, string> = {
      "x-lore-session-id": currentSessionID,
    };
    // Inject git remote so the gateway can group worktrees/clones of the
    // same repo without filesystem access (important for remote gateways).
    const remote = getGitRemote(projectPath);
    if (remote) headers["x-lore-git-remote"] = remote;

    for (const provider of GATEWAY_PROVIDERS) {
      pi.registerProvider(provider, { baseUrl: gatewayBase, headers });
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
