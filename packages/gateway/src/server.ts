/**
 * HTTP server for the Lore gateway proxy.
 *
 * Routes:
 *   POST /v1/messages          → Anthropic protocol (Phase 1)
 *   POST /v1/chat/completions  → OpenAI protocol (Phase 2 stub)
 *   GET  /v1/models            → Passthrough to upstream
 *   GET  /health               → Health check
 *
 * Uses `Bun.serve()` — this package targets Bun exclusively.
 */
import type { GatewayConfig } from "./config";
import type { GatewayRequest } from "./translate/types";
import { parseAnthropicRequest } from "./translate/anthropic";
import { parseOpenAIRequest, buildOpenAIResponse } from "./translate/openai";
import { accumulateSSEResponse } from "./stream/anthropic";
import { handleRequest } from "./pipeline";

// ---------------------------------------------------------------------------
// Version — best-effort from package.json, falls back gracefully
// ---------------------------------------------------------------------------

let version = "unknown";
try {
  // Bun resolves JSON imports; use require for sync + no top-level await
  const pkg = require("../package.json") as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // Not critical — health endpoint will report "unknown"
}

// ---------------------------------------------------------------------------
// CORS headers — permissive for localhost development
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Bun's Headers object to a plain Record<string, string>. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function jsonResponse(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse(
    {
      type: "error",
      error: { type, message },
    },
    status,
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleAnthropicMessages(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseAnthropicRequest(body, headersToRecord(req.headers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    const result = await handleRequest(gatewayReq, config);
    // Pipeline returns a Response directly (streaming or non-streaming)
    return withCors(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    console.error(`[lore] pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

async function handleModelsPassthrough(config: GatewayConfig): Promise<Response> {
  try {
    const upstream = await fetch(`${config.upstreamAnthropic}/v1/models`, {
      headers: { "content-type": "application/json" },
    });
    // Clone to a new Response so we can append CORS headers
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: new Headers(upstream.headers),
    });
    return withCors(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upstream unreachable";
    return errorResponse(502, "api_error", `Failed to fetch models: ${msg}`);
  }
}

function handleHealth(): Response {
  return jsonResponse({ status: "ok", version });
}

async function handleOpenAIChatCompletions(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIRequest(body, headersToRecord(req.headers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  let pipelineResp: Response;
  try {
    pipelineResp = await handleRequest(gatewayReq, config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    console.error(`[lore] pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }

  // Pipeline always returns internal Anthropic-format response.
  // Translate back to OpenAI format before returning to the client.
  if (!pipelineResp.ok) {
    // Upstream or pipeline error — forward as-is
    return withCors(pipelineResp);
  }

  const contentType = pipelineResp.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    // Streaming: accumulate the internal SSE then re-emit as OpenAI SSE
    const accumulated = await accumulateSSEResponse(pipelineResp);
    return withCors(buildOpenAIResponse(accumulated, true));
  }

  // Non-streaming: translate JSON body
  const respBody = await pipelineResp.json();
  return withCors(buildOpenAIResponse(respBody, false));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(config: GatewayConfig): {
  stop: () => void;
  port: number;
} {
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      // CORS preflight
      if (method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (config.debug) {
        console.error(`[lore] ${method} ${pathname}`);
      }

      try {
        // POST /v1/messages — Anthropic protocol
        if (method === "POST" && pathname === "/v1/messages") {
          return await handleAnthropicMessages(req, config);
        }

        // POST /v1/chat/completions — OpenAI protocol
        if (method === "POST" && pathname === "/v1/chat/completions") {
          return await handleOpenAIChatCompletions(req, config);
        }

        // GET /v1/models — passthrough
        if (method === "GET" && pathname === "/v1/models") {
          return await handleModelsPassthrough(config);
        }

        // GET /health — health check
        if (method === "GET" && pathname === "/health") {
          return handleHealth();
        }

        // 404 for everything else
        return errorResponse(404, "not_found", `No route for ${method} ${pathname}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Internal server error";
        console.error(`[lore] uncaught error: ${msg}`);
        return errorResponse(500, "api_error", msg);
      }
    },
  });

  return {
    stop: () => server.stop(),
    port: server.port ?? config.port,
  };
}
