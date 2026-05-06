#!/usr/bin/env bun
/**
 * Smoke test for the Lore gateway.
 *
 * Sends canned Anthropic API requests against a locally-started gateway
 * instance and verifies responses end-to-end.
 *
 * Usage:
 *   bun run packages/gateway/script/smoke-test.ts
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY env var, or key stored in
 *     ~/.local/share/opencode/auth.json under "anthropic.key"
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 0. Resolve API key BEFORE importing gateway modules
// ---------------------------------------------------------------------------

function resolveApiKey(): string | null {
  // 1. Environment variable
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  // 2. OpenCode auth.json fallback
  const authPath = join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "auth.json",
  );
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      const key = auth?.anthropic?.key;
      if (typeof key === "string" && key.length > 0) return key;
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
  console.error(
    "[smoke] ERROR: No Anthropic API key found.\n" +
      "  Set ANTHROPIC_API_KEY env var, or ensure\n" +
      "  ~/.local/share/opencode/auth.json has { \"anthropic\": { \"key\": \"sk-ant-...\" } }",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Configure isolated environment BEFORE any gateway/core imports
// ---------------------------------------------------------------------------

const DB_PATH = "/tmp/lore-gateway-smoke-test.db";

// Pick a random high port to avoid conflicts with running instances
const port = 10000 + Math.floor(Math.random() * 50000);

process.env.LORE_LISTEN_PORT = String(port);
process.env.LORE_DB_PATH = DB_PATH;
// Suppress noisy debug output unless explicitly enabled
if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

// Now safe to import gateway modules
const { startServer } = await import("../src/server");
const { loadConfig } = await import("../src/config");
const { parseMarker } = await import("../src/session");

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

const BASE = `http://127.0.0.1:${port}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send an Anthropic-protocol messages request. */
async function sendMessages(
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

/** Parse SSE text into array of {event, data} objects. */
function parseSSE(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event = "";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }
    if (event || data) {
      events.push({ event, data });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 3. Test runner
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`[smoke] ${name} ... PASS`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, passed: false, error: msg });
    console.error(`[smoke] ${name} ... FAIL: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 4. Start the gateway
// ---------------------------------------------------------------------------

console.log(`[smoke] Starting gateway on port ${port}...`);
const config = loadConfig();
const server = startServer(config);
console.log(`[smoke] Gateway running at ${BASE}`);

// Give the server a moment to bind
await sleep(200);

// State shared between tests
let markerFromTest2 = "";
let responseTextFromTest2 = "";

try {
  // -----------------------------------------------------------------------
  // Test 1 — Health check
  // -----------------------------------------------------------------------
  await runTest("Test 1: Health check", async () => {
    const resp = await fetch(`${BASE}/health`);
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const body = (await resp.json()) as Record<string, unknown>;
    assert(body.status === "ok", `Expected status "ok", got "${body.status}"`);
  });

  // -----------------------------------------------------------------------
  // Test 2 — Non-streaming request with marker injection
  // -----------------------------------------------------------------------
  await runTest("Test 2: Non-streaming request", async () => {
    // Include tools so the request isn't classified as a title/summary
    // passthrough (isTitleOrSummaryRequest checks tools.length ≤ 2)
    const tools = [
      { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    ];

    const resp = await sendMessages({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      stream: false,
      system: "You are a helpful assistant. Reply in exactly one word.",
      messages: [{ role: "user", content: "What is 2+2?" }],
      tools,
    });

    assert(resp.status === 200, `Expected 200, got ${resp.status}`);

    const body = (await resp.json()) as Record<string, unknown>;
    assert(typeof body.id === "string", "Response missing 'id'");
    assert(
      typeof body.stop_reason === "string",
      "Response missing 'stop_reason'",
    );

    const content = body.content as Array<Record<string, unknown>>;
    assert(Array.isArray(content), "Response missing 'content' array");
    assert(
      content.length >= 2,
      `Expected ≥2 content blocks (marker + response), got ${content.length}`,
    );

    // First block should be our [lore:...] marker
    const markerBlock = content[0];
    assert(
      markerBlock.type === "text",
      `First block type should be "text", got "${markerBlock.type}"`,
    );
    const markerText = markerBlock.text as string;
    const parsedMarker = parseMarker(markerText);
    assert(
      parsedMarker !== null,
      `First block should contain [lore:...] marker, got: "${markerText}"`,
    );
    markerFromTest2 = parsedMarker!;

    // Second block should be actual response text
    const responseBlock = content[1];
    assert(
      responseBlock.type === "text",
      `Second block type should be "text", got "${responseBlock.type}"`,
    );
    responseTextFromTest2 = responseBlock.text as string;
    assert(
      responseTextFromTest2.length > 0,
      "Response text block is empty",
    );

    console.log(
      `[smoke]   marker: [lore:${markerFromTest2}], response: "${responseTextFromTest2.trim()}"`,
    );
  });

  // -----------------------------------------------------------------------
  // Test 3 — Streaming request
  // -----------------------------------------------------------------------
  await runTest("Test 3: Streaming request", async () => {
    const tools = [
      { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    ];

    const resp = await sendMessages({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      stream: true,
      system: "You are a helpful assistant. Reply in exactly one word.",
      messages: [{ role: "user", content: "What is 5+5?" }],
      tools,
    });

    assert(resp.status === 200, `Expected 200, got ${resp.status}`);

    const contentType = resp.headers.get("content-type") ?? "";
    assert(
      contentType.includes("text/event-stream"),
      `Expected text/event-stream, got "${contentType}"`,
    );

    const sseText = await resp.text();
    const events = parseSSE(sseText);

    assert(events.length > 0, "No SSE events received");

    const eventTypes = new Set(events.map((e) => e.event));

    const requiredEvents = [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ];

    for (const req of requiredEvents) {
      assert(
        eventTypes.has(req),
        `Missing required SSE event type: "${req}" (got: ${[...eventTypes].join(", ")})`,
      );
    }

    // Accumulate text from content_block_delta events
    let accumulated = "";
    for (const evt of events) {
      if (evt.event === "content_block_delta" && evt.data) {
        try {
          const delta = JSON.parse(evt.data) as Record<string, unknown>;
          const d = delta.delta as Record<string, unknown> | undefined;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            accumulated += d.text;
          }
        } catch {
          // skip unparseable data
        }
      }
    }

    assert(
      accumulated.length > 0,
      "Accumulated text from streaming deltas is empty",
    );
    console.log(
      `[smoke]   streamed ${events.length} events, accumulated: "${accumulated.trim()}"`,
    );
  });

  // Small delay between tests to avoid rate limits
  await sleep(500);

  // -----------------------------------------------------------------------
  // Test 4 — Session continuity (follow-up, no new marker)
  // -----------------------------------------------------------------------
  await runTest("Test 4: Session continuity", async () => {
    assert(
      markerFromTest2.length > 0,
      "Skipped — no marker from Test 2",
    );

    const tools = [
      { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    ];

    const resp = await sendMessages({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      stream: false,
      system: "You are a helpful assistant. Reply in exactly one word.",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: `[lore:${markerFromTest2}]` },
            { type: "text", text: responseTextFromTest2 },
          ],
        },
        { role: "user", content: "What is 3+3?" },
      ],
      tools,
    });

    assert(resp.status === 200, `Expected 200, got ${resp.status}`);

    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    assert(Array.isArray(content), "Response missing 'content' array");
    assert(content.length >= 1, "Response has no content blocks");

    // Should NOT have a new marker — the session already has one
    const firstBlock = content[0];
    if (firstBlock.type === "text") {
      const firstText = firstBlock.text as string;
      const marker = parseMarker(firstText);
      if (marker !== null) {
        // If there IS a marker, it should be the SAME one from test 2
        // (not a newly generated one)
        assert(
          marker === markerFromTest2,
          `Got a different marker: "${marker}" vs original "${markerFromTest2}"`,
        );
      }
    }

    // Extract the actual response text (skip marker blocks if any)
    let responseText = "";
    for (const block of content) {
      if (block.type === "text") {
        const text = block.text as string;
        if (!parseMarker(text)) {
          responseText += text;
        }
      }
    }
    assert(
      responseText.trim().length > 0,
      "No response text after marker filtering",
    );
    console.log(`[smoke]   response: "${responseText.trim()}"`);
  });

  // Small delay between tests
  await sleep(500);

  // -----------------------------------------------------------------------
  // Test 5 — Title/summary passthrough
  // -----------------------------------------------------------------------
  await runTest("Test 5: Title passthrough", async () => {
    const resp = await sendMessages({
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      stream: false,
      system: "Generate a short title.",
      messages: [
        { role: "user", content: "Title this: User asks about math" },
      ],
    });

    assert(resp.status === 200, `Expected 200, got ${resp.status}`);

    const body = (await resp.json()) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    assert(Array.isArray(content), "Response missing 'content' array");
    assert(content.length >= 1, "Response has no content blocks");

    // Passthrough — no marker injection
    for (const block of content) {
      if (block.type === "text") {
        const text = block.text as string;
        const marker = parseMarker(text);
        assert(
          marker === null,
          `Passthrough request should not have a marker, got: "${text}"`,
        );
      }
    }

    const responseText = content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    assert(
      responseText.trim().length > 0,
      "Passthrough response is empty",
    );
    console.log(`[smoke]   title: "${responseText.trim()}"`);
  });
} finally {
  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  console.log("[smoke] Stopping server...");
  server.stop();

  // Clean up temp DB and related files
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${DB_PATH}${suffix}`;
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // best-effort cleanup
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("");
  if (failed === 0) {
    console.log(`[smoke] All ${passed} tests passed!`);
    process.exit(0);
  } else {
    console.log(`[smoke] ${passed} passed, ${failed} failed:`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}
