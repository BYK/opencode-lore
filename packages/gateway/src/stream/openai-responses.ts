/**
 * OpenAI Responses API SSE stream accumulator.
 *
 * Parses upstream Responses API streaming events and accumulates the full
 * response into a `GatewayResponse`. The Responses API uses a different
 * SSE event lifecycle than Anthropic:
 *
 *   response.created → response.in_progress →
 *   response.output_item.added → response.output_text.delta (repeated) →
 *   response.output_item.done → response.function_call_arguments.delta →
 *   response.function_call_arguments.done →
 *   response.completed
 *
 * Reuses `parseSSEStream` from the Anthropic stream module since the
 * underlying SSE wire format is the same.
 */
import type {
  GatewayContentBlock,
  GatewayResponse,
  GatewayUsage,
} from "../translate/types";
import { parseSSEStream } from "./anthropic";

// ---------------------------------------------------------------------------
// Stream accumulator
// ---------------------------------------------------------------------------

/**
 * Accumulate an OpenAI Responses API SSE stream into a GatewayResponse.
 *
 * Consumes the upstream Response body and returns the accumulated result.
 */
export async function accumulateResponsesSSEStream(
  response: Response,
): Promise<GatewayResponse> {
  let id = "";
  let model = "";
  let stopReason = "end_turn";

  const usage: GatewayUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  /** Accumulating output items indexed by output_index. */
  const items = new Map<
    number,
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; callId: string; name: string; args: string }
  >();

  const reader = response.body!.getReader();

  for await (const { event, data } of parseSSEStream(reader)) {
    // Some Responses API implementations send untyped `data:` lines
    // without `event:` — skip those.
    if (!data || data === "[DONE]") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (event) {
      case "response.created":
      case "response.in_progress": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp) {
          if (typeof resp.id === "string") id = resp.id;
          if (typeof resp.model === "string") model = resp.model;
        }
        break;
      }

      case "response.output_item.added": {
        const outputIndex = parsed.output_index as number;
        const item = parsed.item as Record<string, unknown> | undefined;
        if (typeof outputIndex !== "number" || !item) break;

        if (item.type === "message") {
          items.set(outputIndex, { type: "text", text: "" });
        } else if (item.type === "function_call") {
          items.set(outputIndex, {
            type: "tool_use",
            id: String(item.id ?? ""),
            callId: String(item.call_id ?? ""),
            name: String(item.name ?? ""),
            args: "",
          });
        }
        break;
      }

      case "response.output_text.delta": {
        const outputIndex = parsed.output_index as number;
        const delta = parsed.delta as string | undefined;
        if (typeof outputIndex !== "number" || typeof delta !== "string") break;

        const item = items.get(outputIndex);
        if (item?.type === "text") {
          item.text += delta;
        }
        break;
      }

      case "response.output_text.done": {
        const outputIndex = parsed.output_index as number;
        const text = parsed.text as string | undefined;
        if (typeof outputIndex !== "number") break;

        const item = items.get(outputIndex);
        if (item?.type === "text" && typeof text === "string") {
          // Replace accumulated text with the final version (more reliable)
          item.text = text;
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const outputIndex = parsed.output_index as number;
        const delta = parsed.delta as string | undefined;
        if (typeof outputIndex !== "number" || typeof delta !== "string") break;

        const item = items.get(outputIndex);
        if (item?.type === "tool_use") {
          item.args += delta;
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const outputIndex = parsed.output_index as number;
        const args = parsed.arguments as string | undefined;
        if (typeof outputIndex !== "number") break;

        const item = items.get(outputIndex);
        if (item?.type === "tool_use" && typeof args === "string") {
          item.args = args;
        }
        break;
      }

      case "response.completed": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp) {
          if (typeof resp.id === "string") id = resp.id;
          if (typeof resp.model === "string") model = resp.model;
          if (typeof resp.status === "string") {
            stopReason = mapStatusToStopReason(resp.status);
          }

          const respUsage = resp.usage as Record<string, unknown> | undefined;
          if (respUsage) {
            if (typeof respUsage.input_tokens === "number") {
              usage.inputTokens = respUsage.input_tokens;
            }
            if (typeof respUsage.output_tokens === "number") {
              usage.outputTokens = respUsage.output_tokens as number;
            }
            const promptDetails = respUsage.prompt_tokens_details as Record<string, number> | undefined;
            if (promptDetails?.cached_tokens !== undefined) {
              usage.cacheReadInputTokens = promptDetails.cached_tokens;
            }
          }
        }
        break;
      }

      // Other events (response.output_item.done, response.content_part.*,
      // response.reasoning_summary_*, etc.) — ignored for accumulation
    }
  }

  // Build content blocks from accumulated items, sorted by output_index
  const content: GatewayContentBlock[] = [];
  const sortedIndices = Array.from(items.keys()).sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const item = items.get(index)!;
    if (item.type === "text") {
      if (item.text) {
        content.push({ type: "text", text: item.text });
      }
    } else if (item.type === "tool_use") {
      let input: unknown = {};
      if (item.args) {
        try {
          input = JSON.parse(item.args);
        } catch {
          input = item.args;
        }
      }
      content.push({
        type: "tool_use",
        id: item.callId || item.id,
        name: item.name,
        input,
      });
    }
  }

  // If we saw tool_use, map stop reason accordingly
  if (content.some((b) => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  return { id, model, content, stopReason, usage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStatusToStopReason(status: string): string {
  switch (status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return "max_tokens";
    case "cancelled":
      return "stop";
    case "failed":
      return "stop";
    default:
      return "end_turn";
  }
}
