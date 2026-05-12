/**
 * HTTP server for the Lore gateway proxy.
 *
 * Routes:
 *   POST /v1/messages          → Anthropic protocol
 *   POST /v1/chat/completions  → OpenAI Chat Completions protocol
 *   POST /v1/responses         → OpenAI Responses API protocol
 *   GET  /v1/models            → Passthrough to upstream
 *   GET  /health               → Health check
 *
 * Uses `Bun.serve()` — this package targets Bun exclusively.
 */
import type { GatewayConfig } from "./config";
import type { GatewayRequest } from "./translate/types";
import { parseAnthropicRequest } from "./translate/anthropic";
import { parseOpenAIRequest, buildOpenAIResponse } from "./translate/openai";
import { translateAnthropicStreamToOpenAI } from "./stream/openai";
import {
  parseOpenAIResponsesRequest,
  buildOpenAIResponsesResponse,
} from "./translate/openai-responses";
import { translateAnthropicStreamToResponses } from "./stream/openai-responses";
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

// NOTE: This endpoint only supports the Anthropic upstream. OpenAI clients
// calling GET /v1/models will have their request forwarded to Anthropic,
// which will likely reject the OpenAI API key. A proper fix would route
// based on auth header type, but that's a separate enhancement.
async function handleModelsPassthrough(req: Request, config: GatewayConfig): Promise<Response> {
  try {
    // Forward auth headers from the original request so upstream
    // providers that require authentication don't reject with 401.
    const headers: Record<string, string> = { "content-type": "application/json" };
    const apiKey = req.headers.get("x-api-key");
    const auth = req.headers.get("authorization");
    if (apiKey) headers["x-api-key"] = apiKey;
    if (auth) headers["authorization"] = auth;
    // Anthropic requires the version header
    const anthropicVersion = req.headers.get("anthropic-version");
    if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;

    const upstream = await fetch(`${config.upstreamAnthropic}/v1/models`, {
      headers,
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
    // True streaming: translate Anthropic SSE → OpenAI Chat Completions SSE incrementally
    return withCors(translateAnthropicStreamToOpenAI(pipelineResp));
  }

  // Non-streaming: translate JSON body
  const respBody = await pipelineResp.json();
  return withCors(buildOpenAIResponse(respBody, false));
}

async function handleOpenAIResponses(
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
    gatewayReq = parseOpenAIResponsesRequest(body, headersToRecord(req.headers));
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
  // Translate back to Responses API format before returning to the client.
  if (!pipelineResp.ok) {
    return withCors(pipelineResp);
  }

  const contentType = pipelineResp.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    // True streaming: translate Anthropic SSE → Responses API SSE incrementally
    return withCors(translateAnthropicStreamToResponses(pipelineResp));
  }

  // Non-streaming: translate JSON body
  const respBody = await pipelineResp.json();
  return withCors(buildOpenAIResponsesResponse(respBody, false));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(config: GatewayConfig): {
  stop: () => void;
  port: number;
  hosts: string[];
} {
  // Shared fetch handler for all server instances.
  const fetch = async (req: Request): Promise<Response> => {
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

      // POST /v1/responses — OpenAI Responses API protocol
      if (method === "POST" && pathname === "/v1/responses") {
        return await handleOpenAIResponses(req, config);
      }

      // GET /v1/models — passthrough
      if (method === "GET" && pathname === "/v1/models") {
        return await handleModelsPassthrough(req, config);
      }

      // GET /health — health check
      if (method === "GET" && pathname === "/health") {
        return handleHealth();
      }

      // GET/POST /ui/* — Web dashboard (lazy-imported to keep proxy hot path fast)
      if (pathname === "/ui" || pathname.startsWith("/ui/")) {
        const { handleUIRequest } = await import("./ui");
        return withCors(await handleUIRequest(req, url));
      }

      // 404 for everything else
      return errorResponse(404, "not_found", `No route for ${method} ${pathname}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      console.error(`[lore] uncaught error: ${msg}`);
      return errorResponse(500, "api_error", msg);
    }
  };

  // Spawn one Bun.serve() per host address. This allows binding to
  // specific interfaces (e.g. 127.0.0.1 + a Tailscale IP) without
  // opening to 0.0.0.0.
  const servers = config.hosts.map((host) =>
    Bun.serve({
      port: config.port,
      hostname: host,
      // Bun defaults to 10s which is too short for LLM streaming responses.
      // 255 is the maximum allowed by Bun.
      idleTimeout: 255,
      fetch,
    }),
  );

  return {
    stop: () => servers.forEach((s) => s.stop()),
    port: servers[0].port ?? config.port,
    hosts: config.hosts,
  };
}
