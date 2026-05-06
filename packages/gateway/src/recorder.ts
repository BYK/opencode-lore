/**
 * Fixture recorder and replayer for the Lore gateway.
 *
 * Recording mode: intercepts every upstream API call, writes the
 * (request, response) pair to an NDJSON fixture file, then returns
 * the real response to the caller unchanged.
 *
 * Replay mode: replays stored fixtures in sequence, never touching
 * the upstream API.  Useful for deterministic integration tests.
 */
import { appendFileSync } from "node:fs";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One entry per upstream API call, stored in the fixture file. */
export interface FixtureEntry {
  /** Sequence number within the recording session (0-based). */
  seq: number;
  /** Wall-clock timestamp (ms since Unix epoch) when the call was made. */
  ts: number;
  /** The upstream request body as sent (Anthropic /v1/messages JSON). */
  request: unknown;
  /** The full upstream response body (non-streaming, even if original was streaming). */
  response: unknown;
  /** Whether the original request asked for a streaming response. */
  wasStreaming: boolean;
  /** Model that was used for the request. */
  model: string;
}

/**
 * Interceptor function injected into the upstream forwarding path.
 *
 * @param requestBody  - The request body that will be sent upstream.
 * @param model        - Model identifier from the request.
 * @param wasStreaming - Whether the original request was streaming.
 * @param makeRealRequest - Thunk that performs the actual HTTP request.
 *                          The interceptor decides whether to call it.
 */
export type UpstreamInterceptor = (
  requestBody: unknown,
  model: string,
  wasStreaming: boolean,
  makeRealRequest: () => Promise<Response>,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Non-null when recording is active; holds the path of the fixture file. */
let recordingPath: string | null = null;

/** Monotonically increasing counter for fixture sequence numbers. */
let seqCounter = 0;

// ---------------------------------------------------------------------------
// Recording control
// ---------------------------------------------------------------------------

/** Enable recording mode. All upstream calls will be appended to `fixturePath`. */
export function startRecording(fixturePath: string): void {
  recordingPath = fixturePath;
  seqCounter = 0;
  log.info(`[recorder] recording to: ${fixturePath}`);
}

/** Disable recording mode. */
export function stopRecording(): void {
  recordingPath = null;
}

// ---------------------------------------------------------------------------
// Recording interceptor
// ---------------------------------------------------------------------------

/**
 * Returns an `UpstreamInterceptor` when recording mode is active, or
 * `null` when it is not.
 *
 * The returned interceptor:
 *  1. Calls `makeRealRequest()` to get the real upstream response.
 *  2. Reads the full response body text (works for both streaming and
 *     non-streaming — the raw body is always valid JSON from Anthropic
 *     even for streaming responses because we force `stream:false` when
 *     we need the body for the fixture; for streaming the body is SSE
 *     text which we store verbatim).
 *  3. Appends a `FixtureEntry` line to the fixture file.
 *  4. Returns a new `Response` with the same status, headers, and body
 *     (the original body stream is already consumed, so we reconstitute it).
 */
export function getRecordedInterceptor(): UpstreamInterceptor | null {
  if (!recordingPath) return null;

  // Capture the path at interceptor creation time so closure is stable
  const fixturePath = recordingPath;

  return async (
    requestBody: unknown,
    model: string,
    wasStreaming: boolean,
    makeRealRequest: () => Promise<Response>,
  ): Promise<Response> => {
    const ts = Date.now();
    const seq = seqCounter++;

    // Perform the real upstream request
    const realResponse = await makeRealRequest();

    // Collect all response headers before consuming the body
    const responseHeaders: Record<string, string> = {};
    realResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Read the full body text — this consumes the stream
    const bodyText = await realResponse.text();

    // Parse body as JSON for structured storage; fall back to raw string
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(bodyText);
    } catch {
      responseBody = bodyText;
    }

    // Write the fixture entry
    const entry: FixtureEntry = {
      seq,
      ts,
      request: requestBody,
      response: responseBody,
      wasStreaming,
      model,
    };
    appendFileSync(fixturePath, JSON.stringify(entry) + "\n", "utf8");

    log.info(`[recorder] captured turn seq=${seq} model=${model}`);

    // Return a new Response with the same status and headers but a fresh body
    return new Response(bodyText, {
      status: realResponse.status,
      headers: responseHeaders,
    });
  };
}

// ---------------------------------------------------------------------------
// Replay interceptor
// ---------------------------------------------------------------------------

/**
 * Returns an interceptor that replays the given fixtures in sequence,
 * without ever calling `makeRealRequest()`.
 *
 * Each call advances an internal counter.  When the counter exceeds
 * `fixtures.length`, an error is thrown.
 */
export function getReplayInterceptor(fixtures: FixtureEntry[]): UpstreamInterceptor {
  let replayCounter = 0;

  return async (
    _requestBody: unknown,
    _model: string,
    _wasStreaming: boolean,
    _makeRealRequest: () => Promise<Response>,
  ): Promise<Response> => {
    if (replayCounter >= fixtures.length) {
      throw new Error(
        `Replay exhausted: no more fixtures (tried to replay entry ${replayCounter}, ` +
          `but only ${fixtures.length} fixture(s) are available)`,
      );
    }

    const fixture = fixtures[replayCounter++];

    log.info(
      `[recorder] replaying seq=${fixture.seq} model=${fixture.model} ` +
        `(${replayCounter}/${fixtures.length})`,
    );

    // Always return a non-streaming JSON response — the pipeline handles
    // re-streaming if the client originally requested SSE.
    return new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
