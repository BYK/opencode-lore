/**
 * Dimension 5: Cost measurement scenarios (COST-1 through COST-5).
 *
 * Unlike other dimensions that measure information retention quality,
 * cost scenarios measure observable system properties: token counts,
 * API call counts, dollar costs, and cache hit rates. The questions
 * serve as structured test assertions — reference answers use
 * placeholder values because actual numbers depend on runtime.
 *
 * All cost scenarios use a minimal rubric (factual accuracy only)
 * since the real evaluation is done by the cost-verifier infrastructure.
 */
import type {
  ScenarioDefinition,
  SessionTranscript,
  ConversationTurn,
  EvalQuestion,
  ScoringRubric,
} from "../types";
import { FACTUAL_ACCURACY } from "../judge";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const PROJECT_PATH = "/tmp/eval-project-cost";
const DIMENSION = "cost" as const;

/** Minimal rubric for cost scenarios — factual accuracy only. */
const COST_RUBRIC: ScoringRubric = {
  criteria: [FACTUAL_ACCURACY],
  weights: { factual_accuracy: 1.0 },
};

// ---------------------------------------------------------------------------
// Helpers: tool_use / tool_result ID generation
// ---------------------------------------------------------------------------

let toolIdCounter = 0;
function nextToolId(): string {
  return `toolu_cost_${String(++toolIdCounter).padStart(4, "0")}`;
}

// Reset counter between scenario builds to keep IDs predictable in tests.
function resetToolIds(): void {
  toolIdCounter = 0;
}

// ---------------------------------------------------------------------------
// Helpers: turn builders
// ---------------------------------------------------------------------------

function userText(text: string, tokens?: number, timestamp?: number): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    ...(tokens != null && { tokens }),
    ...(timestamp != null && { timestamp }),
  };
}

function assistantText(text: string, tokens?: number, timestamp?: number): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(tokens != null && { tokens }),
    ...(timestamp != null && { timestamp }),
  };
}

function assistantToolUse(
  toolName: string,
  input: unknown,
  prefixText?: string,
  tokens?: number,
  timestamp?: number,
): { turn: ConversationTurn; toolId: string } {
  const toolId = nextToolId();
  const content: ConversationTurn["content"] = [];
  if (prefixText) {
    content.push({ type: "text", text: prefixText });
  }
  content.push({ type: "tool_use", id: toolId, name: toolName, input });
  return {
    turn: {
      role: "assistant",
      content,
      ...(tokens != null && { tokens }),
      ...(timestamp != null && { timestamp }),
    },
    toolId,
  };
}

function userToolResult(
  toolUseId: string,
  result: string,
  isError = false,
  tokens?: number,
  timestamp?: number,
): ConversationTurn {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content: result, is_error: isError },
    ],
    ...(tokens != null && { tokens }),
    ...(timestamp != null && { timestamp }),
  };
}

function costQuestion(
  id: string,
  scenario: string,
  sessionRef: string,
  question: string,
  referenceAnswer: string,
  tags: string[],
  difficulty: "easy" | "medium" | "hard" = "easy",
): EvalQuestion {
  return {
    id,
    dimension: DIMENSION,
    scenario,
    sessionRef,
    question,
    referenceAnswer,
    rubric: COST_RUBRIC,
    metadata: {
      difficulty,
      tags,
    },
  };
}

// ---------------------------------------------------------------------------
// Timestamp helpers (realistic pacing: ~90s between turns)
// ---------------------------------------------------------------------------

function ts(minutesFromStart: number): number {
  // Session start: 2025-05-15 10:00:00 UTC
  return new Date("2025-05-15T10:00:00Z").getTime() + minutesFromStart * 60_000;
}

// ============================================================================
// COST-1: Cost Tracking Accuracy
// ============================================================================

function buildCost1Session(): SessionTranscript {
  resetToolIds();
  const turns: ConversationTurn[] = [];

  // Turn 1-2: user asks about a bug, assistant reads a file
  turns.push(userText(
    "I'm seeing a 500 error in production on the /api/users endpoint. Can you investigate?",
    120,
    ts(0),
  ));
  const t1 = assistantToolUse("bash", { command: "curl -s http://localhost:3000/api/users | head -20" },
    "Let me check the endpoint and look at the error logs.",
    200, ts(1));
  turns.push(t1.turn);

  turns.push(userToolResult(t1.toolId,
    '{"error":"Internal Server Error","statusCode":500,"message":"Cannot read properties of undefined (reading \'map\')"}',
    false, 150, ts(1.5)));
  const t2 = assistantToolUse("read", { path: "src/routes/users.ts" },
    "There's a TypeError. Let me look at the route handler.",
    300, ts(2));
  turns.push(t2.turn);

  // Turn 3-4: read file result, then check database
  turns.push(userToolResult(t2.toolId,
    `import { Router } from 'express';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.get('/', async (req, res) => {\n  const users = await db.query('SELECT * FROM users');\n  const formatted = users.rows.map(u => ({ id: u.id, name: u.name, email: u.email }));\n  res.json(formatted);\n});\n\nexport default router;`,
    false, 350, ts(2.5)));
  const t3 = assistantToolUse("bash", { command: "psql -c 'SELECT count(*) FROM users' 2>&1" },
    "The error suggests `users.rows` is undefined. The DB query might be returning a different shape. Let me check the database.",
    400, ts(3));
  turns.push(t3.turn);

  // Turn 5-6: DB result, check DB module
  turns.push(userToolResult(t3.toolId,
    "ERROR:  connection refused\nIs the server running on host \"localhost\" (127.0.0.1) and accepting TCP/IP connections on port 5432?",
    true, 200, ts(3.5)));
  const t4 = assistantToolUse("read", { path: "src/db.ts" },
    "The database connection is failing. That explains why the query returns undefined instead of a result object. Let me check the DB configuration.",
    300, ts(4));
  turns.push(t4.turn);

  // Turn 7-8: DB config, check env
  turns.push(userToolResult(t4.toolId,
    `import pg from 'pg';\n\nconst pool = new pg.Pool({\n  host: process.env.DB_HOST || 'localhost',\n  port: parseInt(process.env.DB_PORT || '5432'),\n  database: process.env.DB_NAME || 'myapp',\n  user: process.env.DB_USER || 'postgres',\n  password: process.env.DB_PASS || '',\n});\n\nexport const db = { query: (text: string, params?: unknown[]) => pool.query(text, params) };`,
    false, 400, ts(4.5)));
  const t5 = assistantToolUse("bash", { command: "docker ps --format '{{.Names}} {{.Status}}' | grep postgres" },
    "The connection uses environment variables with localhost defaults. Let me check if the PostgreSQL container is running.",
    250, ts(5));
  turns.push(t5.turn);

  // Turn 9-10: Docker result, fix
  turns.push(userToolResult(t5.toolId,
    "myapp-postgres   Up 3 hours (healthy)",
    false, 100, ts(5.5)));
  const t6 = assistantToolUse("bash", { command: "docker inspect myapp-postgres --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'" },
    "The container is running but maybe it's not on localhost. Let me check the container IP.",
    200, ts(6));
  turns.push(t6.turn);

  // Turn 11-12: Container IP, check port mapping
  turns.push(userToolResult(t6.toolId, "172.17.0.3", false, 100, ts(6.5)));
  const t7 = assistantToolUse("bash", { command: "docker port myapp-postgres" },
    "The container IP is 172.17.0.3, not localhost. Let me check the port mappings.",
    200, ts(7));
  turns.push(t7.turn);

  // Turn 13-14: Port mapping reveals the issue
  turns.push(userToolResult(t7.toolId, "5432/tcp -> 0.0.0.0:5433", false, 100, ts(7.5)));
  turns.push(assistantText(
    "Found it! The PostgreSQL container maps port 5432 internally to port **5433** externally. The app defaults to port 5432. You need to either:\n\n1. Set `DB_PORT=5433` in your environment, or\n2. Change the Docker port mapping to `5432:5432`\n\nLet me fix the environment.",
    300, ts(8)));

  // Turn 15-16: Apply fix
  turns.push(userText(
    "Let's set the env variable. Can you update the .env file?",
    80, ts(9)));
  const t8 = assistantToolUse("bash", { command: "echo 'DB_PORT=5433' >> .env && cat .env" },
    "I'll add the DB_PORT to your .env file.",
    200, ts(9.5));
  turns.push(t8.turn);

  // Turn 17-18: env result, verify fix
  turns.push(userToolResult(t8.toolId,
    "NODE_ENV=development\nDB_HOST=localhost\nDB_NAME=myapp\nDB_USER=postgres\nDB_PASS=secret123\nDB_PORT=5433",
    false, 150, ts(10)));
  const t9 = assistantToolUse("bash", { command: "source .env && curl -s http://localhost:3000/api/users | head -5" },
    "Now let me restart the server and test the endpoint.",
    200, ts(10.5));
  turns.push(t9.turn);

  // Turn 19-20: Verification
  turns.push(userToolResult(t9.toolId,
    '[{"id":1,"name":"Alice Johnson","email":"alice@example.com"},{"id":2,"name":"Bob Smith","email":"bob@example.com"}]',
    false, 200, ts(11)));
  turns.push(assistantText(
    "The endpoint is working now. The root cause was a port mismatch: Docker mapped PostgreSQL's internal port 5432 to external port 5433, but the app was connecting on 5432.\n\nSummary of changes:\n- Added `DB_PORT=5433` to `.env`\n- Root cause: Docker port mapping `5432/tcp -> 0.0.0.0:5433`",
    250, ts(11.5)));

  // Turn 21-22: User asks to add error handling
  turns.push(userText(
    "Good catch. Can you also add proper error handling to the users route so it doesn't return 500 on DB errors?",
    100, ts(13)));
  const t10 = assistantToolUse("write", {
    path: "src/routes/users.ts",
    content: `import { Router } from 'express';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.get('/', async (req, res) => {\n  try {\n    const users = await db.query('SELECT * FROM users');\n    if (!users?.rows) {\n      return res.status(503).json({ error: 'Database unavailable' });\n    }\n    const formatted = users.rows.map(u => ({ id: u.id, name: u.name, email: u.email }));\n    res.json(formatted);\n  } catch (err) {\n    console.error('Failed to fetch users:', err);\n    res.status(503).json({ error: 'Service temporarily unavailable' });\n  }\n});\n\nexport default router;`,
  },
    "I'll add try/catch with a proper 503 response for database errors.",
    500, ts(13.5));
  turns.push(t10.turn);

  // Turn 23-24: write result, run tests
  turns.push(userToolResult(t10.toolId, "File written successfully.", false, 50, ts(14)));
  const t11 = assistantToolUse("bash", { command: "npm test -- --grep 'users' 2>&1" },
    "Let me run the relevant tests to verify.",
    200, ts(14.5));
  turns.push(t11.turn);

  // Turn 25-26: test results
  turns.push(userToolResult(t11.toolId,
    "  GET /api/users\n    ✓ returns user list (45ms)\n    ✓ returns 503 on database error (12ms)\n    ✓ handles empty result set (8ms)\n\n  3 passing (67ms)",
    false, 200, ts(15)));
  turns.push(assistantText(
    "All 3 tests pass, including the new error handling test. The fix is complete:\n1. ✅ DB port fixed (5432 → 5433)\n2. ✅ Error handling added to users route\n3. ✅ Tests passing",
    200, ts(15.5)));

  // Turn 27-28: Final discussion about monitoring
  turns.push(userText(
    "Should we add monitoring for DB connection failures?",
    60, ts(17)));
  turns.push(assistantText(
    "Yes, I'd recommend adding a health check endpoint that probes the DB connection, and setting up an alert in your monitoring system (Datadog, Prometheus, etc.) for connection failure rates. We could add a `/health/db` endpoint that runs `SELECT 1` and returns the connection latency.",
    250, ts(17.5)));

  // Turn 29-30: Wrap up
  turns.push(userText(
    "Good idea, let's do that in a follow-up. Thanks for the quick fix!",
    50, ts(19)));
  turns.push(assistantText(
    "Happy to help! To summarize the session:\n- **Root cause**: Docker port mapping mismatch (5432→5433)\n- **Fix**: Added `DB_PORT=5433` to `.env`\n- **Improvement**: Added try/catch error handling in the users route\n- **Follow-up**: DB health check endpoint for monitoring\n\nTotal: 2 files changed, 3 tests passing.",
    250, ts(19.5)));

  return {
    id: "cost-1-session",
    label: "Cost tracking accuracy — realistic debugging session",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: turns.reduce((s, t) => s + (t.tokens ?? 200), 0),
      description:
        "A ~15-turn debugging session (DB port mismatch) with tool calls. " +
        "Used to verify Lore's cost tracking matches independent measurement.",
    },
  };
}

function buildCost1Questions(): EvalQuestion[] {
  const S = "cost-1-accuracy";
  const REF = "cost-1-session";
  return [
    costQuestion(`${S}-q1`, S, REF,
      "What was the total input token count reported by Lore for this session?",
      "Verified via cost-verifier: compare loreReported.totalTokens.input against independent tracker.",
      ["input-tokens", "cost-tracking"]),
    costQuestion(`${S}-q2`, S, REF,
      "What was the total output token count reported by Lore for this session?",
      "Verified via cost-verifier: compare loreReported.totalTokens.output against independent tracker.",
      ["output-tokens", "cost-tracking"]),
    costQuestion(`${S}-q3`, S, REF,
      "What was the total estimated cost reported by Lore for conversation API calls?",
      "Verified via cost-verifier: compare loreReported.breakdown.conversation against independent tracker. Error should be < 5%.",
      ["conversation-cost", "cost-tracking"], "medium"),
    costQuestion(`${S}-q4`, S, REF,
      "What was the per-component cost breakdown (conversation, distillation, curation, recall, warmup)?",
      "Verified via cost-verifier: compare each component in loreReported.breakdown against independent tracker. Each component error should be < 5%.",
      ["breakdown", "cost-tracking"], "medium"),
    costQuestion(`${S}-q5`, S, REF,
      "What was the cache_read and cache_write token count reported by Lore?",
      "Verified via cost-verifier: compare loreReported.totalTokens.cacheRead and cacheWrite against independent tracker.",
      ["cache-tokens", "cost-tracking"]),
  ];
}

// ============================================================================
// COST-2: Net Cost Impact (Short Session)
// ============================================================================

function buildCost2Session(): SessionTranscript {
  resetToolIds();
  const turns: ConversationTurn[] = [];

  // A ~10 turn session, ~50K token estimate — fits entirely in context.
  // Simple feature implementation: adding a search endpoint.

  turns.push(userText(
    "I need to add a search endpoint to our API. Users should be able to search products by name with `GET /api/products/search?q=term`. Can you implement it?",
    150, ts(0)));
  const t1 = assistantToolUse("read", { path: "src/routes/products.ts" },
    "Let me first look at the existing products route to understand the current structure.",
    5000, ts(1));
  turns.push(t1.turn);

  turns.push(userToolResult(t1.toolId,
    `import { Router } from 'express';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.get('/', async (req, res) => {\n  const { rows } = await db.query('SELECT * FROM products ORDER BY created_at DESC LIMIT 50');\n  res.json(rows);\n});\n\nrouter.get('/:id', async (req, res) => {\n  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);\n  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });\n  res.json(rows[0]);\n});\n\nexport default router;`,
    false, 5000, ts(1.5)));
  const t2 = assistantToolUse("read", { path: "src/db.ts" },
    "Good, I see the pattern. Let me also check the DB module for the query interface.",
    5000, ts(2));
  turns.push(t2.turn);

  turns.push(userToolResult(t2.toolId,
    `import pg from 'pg';\n\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });\n\nexport const db = {\n  query: (text: string, params?: unknown[]) => pool.query(text, params),\n};`,
    false, 3000, ts(2.5)));
  turns.push(assistantText(
    "I'll add the search endpoint using PostgreSQL's `ILIKE` for case-insensitive matching, with proper input validation and pagination support.\n\nHere's my plan:\n1. Add `GET /api/products/search` with query param `q`\n2. Use `ILIKE '%' || $1 || '%'` for substring matching\n3. Add pagination with `limit` and `offset` params\n4. Validate that `q` is at least 2 characters",
    5000, ts(3)));

  turns.push(userText("Sounds good, go ahead.", 50, ts(4)));
  const t3 = assistantToolUse("write", {
    path: "src/routes/products.ts",
    content: `import { Router } from 'express';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.get('/search', async (req, res) => {\n  const q = req.query.q as string;\n  if (!q || q.length < 2) {\n    return res.status(400).json({ error: 'Search query must be at least 2 characters' });\n  }\n  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);\n  const offset = parseInt(req.query.offset as string) || 0;\n  try {\n    const { rows, rowCount } = await db.query(\n      'SELECT * FROM products WHERE name ILIKE $1 ORDER BY name LIMIT $2 OFFSET $3',\n      ['%' + q + '%', limit, offset]\n    );\n    res.json({ results: rows, total: rowCount, limit, offset });\n  } catch (err) {\n    console.error('Search failed:', err);\n    res.status(500).json({ error: 'Search failed' });\n  }\n});\n\nrouter.get('/', async (req, res) => {\n  const { rows } = await db.query('SELECT * FROM products ORDER BY created_at DESC LIMIT 50');\n  res.json(rows);\n});\n\nrouter.get('/:id', async (req, res) => {\n  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);\n  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });\n  res.json(rows[0]);\n});\n\nexport default router;`,
  },
    "I'll add the search route. Note: it must be defined before `/:id` to avoid route conflicts.",
    6000, ts(4.5));
  turns.push(t3.turn);

  turns.push(userToolResult(t3.toolId, "File written successfully.", false, 50, ts(5)));
  const t4 = assistantToolUse("bash", { command: "npm test -- --grep 'products' 2>&1" },
    "Let me run the product tests to verify everything works.",
    4000, ts(5.5));
  turns.push(t4.turn);

  turns.push(userToolResult(t4.toolId,
    "  GET /api/products\n    ✓ returns product list (23ms)\n    ✓ returns single product (12ms)\n    ✓ returns 404 for missing product (8ms)\n  GET /api/products/search\n    ✓ searches by name (34ms)\n    ✓ returns 400 for short query (5ms)\n    ✓ respects pagination (18ms)\n\n  6 passing (102ms)",
    false, 4000, ts(6)));
  turns.push(assistantText(
    "All 6 tests pass, including the 3 new search tests. The implementation:\n- `GET /api/products/search?q=term` — case-insensitive substring search\n- Validates minimum 2-char query\n- Supports `limit` (max 100) and `offset` pagination\n- Returns `{ results, total, limit, offset }`\n- Error handling with 500 response on DB failure",
    4000, ts(6.5)));

  turns.push(userText(
    "Can you also add an index on the name column for better search performance?",
    80, ts(8)));
  const t5 = assistantToolUse("bash", {
    command: "psql $DATABASE_URL -c 'CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);' 2>&1",
  },
    "I'll create a trigram GIN index for fast ILIKE queries. This requires the pg_trgm extension.",
    3000, ts(8.5));
  turns.push(t5.turn);

  turns.push(userToolResult(t5.toolId,
    "CREATE INDEX",
    false, 50, ts(9)));
  turns.push(assistantText(
    "Done! Created a GIN trigram index on `products.name`. This will significantly speed up the `ILIKE` search queries, especially as the table grows. The index uses `gin_trgm_ops` which supports both `LIKE` and `ILIKE` patterns.",
    3000, ts(9.5)));

  return {
    id: "cost-2-session",
    label: "Short session — product search feature (fits in context)",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: 50_000,
      description:
        "A ~10-turn session (~50K tokens) implementing a search endpoint. " +
        "Fits entirely in context — measures Lore overhead when compression isn't needed.",
    },
  };
}

function buildCost2Questions(): EvalQuestion[] {
  const S = "cost-2-short";
  const REF = "cost-2-session";
  return [
    costQuestion(`${S}-q1`, S, REF,
      "What was the total cost with Lore enabled for this session?",
      "Verified via cost-verifier: totalCostWithLore from CostMetrics.",
      ["total-cost", "overhead"]),
    costQuestion(`${S}-q2`, S, REF,
      "What was the total cost for the baseline (same session without Lore)?",
      "Verified via cost-verifier: totalCostBaseline from CostMetrics.",
      ["baseline-cost", "overhead"]),
    costQuestion(`${S}-q3`, S, REF,
      "What is the Lore overhead percentage for this short session?",
      "Verified via cost-verifier: loreOverheadPct = (totalWithLore - totalBaseline) / totalBaseline * 100. Expected < 15%.",
      ["overhead-pct", "overhead"], "medium"),
    costQuestion(`${S}-q4`, S, REF,
      "What percentage of the overhead is from distillation vs curation vs warmup?",
      "Verified via cost-verifier: breakdown.distillation, breakdown.curation, breakdown.warmup as percentages of total overhead.",
      ["overhead-breakdown", "overhead"], "medium"),
    costQuestion(`${S}-q5`, S, REF,
      "How many distillation API calls were made during this session?",
      "Verified via cost-verifier: count of records where callType === 'distillation'.",
      ["distillation-calls", "api-calls"]),
  ];
}

// ============================================================================
// COST-3: Net Cost Impact (Long Session)
// ============================================================================

/**
 * Build a ~25-turn session with high token estimates to simulate ~200K tokens.
 * Uses large tool outputs (file reads, test outputs, build logs) to inflate
 * the token count realistically.
 */
function buildCost3Session(): SessionTranscript {
  resetToolIds();
  const turns: ConversationTurn[] = [];

  // Phase 1: Investigation (turns 1-8, ~60K tokens)
  turns.push(userText(
    "We need to refactor the authentication module. It's grown to 2000 lines and mixes JWT validation, OAuth2, session management, and RBAC. Let's split it into focused modules.",
    200, ts(0)));
  const t1 = assistantToolUse("read", { path: "src/auth/index.ts" },
    "Let me read the current auth module to understand the full scope.",
    8000, ts(1));
  turns.push(t1.turn);

  // Simulate a large file read (~15K tokens)
  const largeAuthFile = Array.from({ length: 200 }, (_, i) =>
    `// Line ${i + 1}: ${i < 50 ? "JWT validation logic" : i < 100 ? "OAuth2 flow handlers" : i < 150 ? "Session management" : "RBAC permission checks"}\n` +
    `function authFunction${i}(req: Request, res: Response) {\n` +
    `  const token = req.headers.authorization?.split(' ')[1];\n` +
    `  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n` +
    `  // ... complex logic for ${i < 50 ? "JWT" : i < 100 ? "OAuth" : i < 150 ? "sessions" : "RBAC"}\n` +
    `}\n`,
  ).join("\n");
  turns.push(userToolResult(t1.toolId, largeAuthFile, false, 15000, ts(2)));

  turns.push(assistantText(
    "This is a substantial file. I can identify 4 clear modules to extract:\n\n" +
    "1. **JWT** (lines 1-500): Token creation, validation, refresh\n" +
    "2. **OAuth2** (lines 501-1000): Provider configs, callbacks, PKCE flow\n" +
    "3. **Sessions** (lines 1001-1500): Session store, middleware, cleanup\n" +
    "4. **RBAC** (lines 1501-2000): Roles, permissions, middleware\n\n" +
    "Let me start with the JWT module extraction.",
    8000, ts(3)));

  // Phase 2: JWT extraction (turns 9-14, ~50K tokens)
  turns.push(userText("Sounds good. Start with JWT.", 50, ts(5)));
  const t2 = assistantToolUse("write", {
    path: "src/auth/jwt.ts",
    content: "// JWT module extracted from auth/index.ts\n" +
      Array.from({ length: 80 }, (_, i) =>
        `export function jwtFunction${i}() { /* JWT logic */ }\n`,
      ).join(""),
  },
    "Extracting JWT validation into a dedicated module.",
    12000, ts(5.5));
  turns.push(t2.turn);

  turns.push(userToolResult(t2.toolId, "File written successfully.", false, 50, ts(6)));
  const t3 = assistantToolUse("bash", { command: "npm test -- --grep 'jwt' 2>&1" },
    "Let me run the JWT-specific tests to verify the extraction.",
    8000, ts(6.5));
  turns.push(t3.turn);

  // Simulate test output
  const jwtTestOutput = Array.from({ length: 30 }, (_, i) =>
    `    ✓ JWT test case ${i + 1}: ${["validates token signature", "rejects expired tokens", "handles refresh flow", "extracts claims correctly", "validates audience"][i % 5]} (${10 + i}ms)`,
  ).join("\n");
  turns.push(userToolResult(t3.toolId,
    `  JWT Module\n${jwtTestOutput}\n\n  30 passing (342ms)`,
    false, 8000, ts(7)));

  turns.push(assistantText(
    "All 30 JWT tests pass. Now let me extract the OAuth2 module.",
    8000, ts(7.5)));

  // Phase 3: OAuth2 extraction (turns 15-18, ~40K tokens)
  turns.push(userText("Great, proceed with OAuth2.", 50, ts(9)));
  const t4 = assistantToolUse("write", {
    path: "src/auth/oauth2.ts",
    content: "// OAuth2 module extracted from auth/index.ts\n" +
      Array.from({ length: 90 }, (_, i) =>
        `export function oauthFunction${i}() { /* OAuth2 logic for ${["Google", "GitHub", "Microsoft", "Apple"][i % 4]} */ }\n`,
      ).join(""),
  },
    "Extracting OAuth2 handlers — Google, GitHub, Microsoft, and Apple providers.",
    12000, ts(9.5));
  turns.push(t4.turn);

  turns.push(userToolResult(t4.toolId, "File written successfully.", false, 50, ts(10)));
  const t5 = assistantToolUse("bash", { command: "npm test -- --grep 'oauth' 2>&1" },
    "Running OAuth2 tests.",
    10000, ts(10.5));
  turns.push(t5.turn);

  const oauthTestOutput = Array.from({ length: 25 }, (_, i) =>
    `    ✓ OAuth2 test ${i + 1}: ${["authorization URL generation", "callback handling", "token exchange", "PKCE verification", "provider config validation"][i % 5]} (${15 + i * 2}ms)`,
  ).join("\n");
  turns.push(userToolResult(t5.toolId,
    `  OAuth2 Module\n${oauthTestOutput}\n\n  25 passing (521ms)`,
    false, 8000, ts(11)));

  turns.push(assistantText(
    "25 OAuth2 tests passing. Moving to session management extraction.",
    8000, ts(11.5)));

  // Phase 4: Sessions extraction (turns 19-22, ~30K tokens)
  turns.push(userText("Go ahead with sessions.", 50, ts(13)));
  const t6 = assistantToolUse("write", {
    path: "src/auth/sessions.ts",
    content: "// Session management module extracted from auth/index.ts\n" +
      Array.from({ length: 70 }, (_, i) =>
        `export function sessionFunction${i}() { /* Session ${["creation", "validation", "refresh", "cleanup", "middleware"][i % 5]} */ }\n`,
      ).join(""),
  },
    "Extracting session management.",
    10000, ts(13.5));
  turns.push(t6.turn);

  turns.push(userToolResult(t6.toolId, "File written successfully.", false, 50, ts(14)));
  const t7 = assistantToolUse("bash", { command: "npm test -- --grep 'session' 2>&1" },
    "Running session tests.",
    8000, ts(14.5));
  turns.push(t7.turn);

  const sessionTestOutput = Array.from({ length: 20 }, (_, i) =>
    `    ✓ Session test ${i + 1}: ${["creates session", "validates session ID", "expires after timeout", "handles concurrent access", "cleans up stale sessions"][i % 5]} (${8 + i}ms)`,
  ).join("\n");
  turns.push(userToolResult(t7.toolId,
    `  Session Management\n${sessionTestOutput}\n\n  20 passing (289ms)`,
    false, 6000, ts(15)));

  turns.push(assistantText(
    "20 session tests passing. Final module: RBAC.",
    6000, ts(15.5)));

  // Phase 5: RBAC extraction (turns 23-26, ~30K tokens)
  turns.push(userText("Finish with RBAC.", 50, ts(17)));
  const t8 = assistantToolUse("write", {
    path: "src/auth/rbac.ts",
    content: "// RBAC module extracted from auth/index.ts\n" +
      Array.from({ length: 60 }, (_, i) =>
        `export function rbacFunction${i}() { /* RBAC ${["role assignment", "permission check", "middleware guard", "hierarchy resolution", "audit logging"][i % 5]} */ }\n`,
      ).join(""),
  },
    "Extracting RBAC permission system.",
    10000, ts(17.5));
  turns.push(t8.turn);

  turns.push(userToolResult(t8.toolId, "File written successfully.", false, 50, ts(18)));
  const t9 = assistantToolUse("bash", { command: "npm test 2>&1" },
    "Running the full test suite to verify nothing broke.",
    12000, ts(18.5));
  turns.push(t9.turn);

  const fullTestOutput = Array.from({ length: 40 }, (_, i) =>
    `    ✓ Integration test ${i + 1}: ${["end-to-end auth flow", "JWT + OAuth2 handoff", "session persistence", "RBAC enforcement", "token refresh chain"][i % 5]} (${20 + i * 3}ms)`,
  ).join("\n");
  turns.push(userToolResult(t9.toolId,
    `  Full Test Suite\n  JWT Module: 30 passing\n  OAuth2 Module: 25 passing\n  Session Management: 20 passing\n  RBAC: 15 passing\n  Integration Tests\n${fullTestOutput}\n\n  130 passing (2.1s)`,
    false, 10000, ts(19)));

  // Phase 6: Cleanup and index file (turns 27-30, ~20K tokens)
  turns.push(assistantText(
    "All 130 tests pass! Let me create the new index file that re-exports from the individual modules.",
    6000, ts(19.5)));

  turns.push(userText("Yes, update the index file and remove the old monolith.", 80, ts(21)));
  const t10 = assistantToolUse("write", {
    path: "src/auth/index.ts",
    content: "// Auth module — re-exports from focused sub-modules\n" +
      "export * from './jwt';\nexport * from './oauth2';\nexport * from './sessions';\nexport * from './rbac';\n",
  },
    "Replacing the 2000-line monolith with clean re-exports.",
    5000, ts(21.5));
  turns.push(t10.turn);

  turns.push(userToolResult(t10.toolId, "File written successfully.", false, 50, ts(22)));
  const t11 = assistantToolUse("bash", { command: "npm test 2>&1 && echo '---' && wc -l src/auth/*.ts" },
    "Final verification — all tests and line counts.",
    8000, ts(22.5));
  turns.push(t11.turn);

  turns.push(userToolResult(t11.toolId,
    "  130 passing (2.0s)\n---\n  82 src/auth/jwt.ts\n  92 src/auth/oauth2.ts\n  72 src/auth/sessions.ts\n  62 src/auth/rbac.ts\n  5 src/auth/index.ts\n  313 total",
    false, 5000, ts(23)));
  turns.push(assistantText(
    "Refactoring complete!\n\n**Before**: 1 file, 2000 lines\n**After**: 4 focused modules + index, 313 lines total\n\n| Module | Lines | Tests |\n|--------|-------|-------|\n| jwt.ts | 82 | 30 |\n| oauth2.ts | 92 | 25 |\n| sessions.ts | 72 | 20 |\n| rbac.ts | 62 | 15 |\n| Integration | — | 40 |\n| **Total** | **313** | **130** |\n\nAll 130 tests passing. The auth module is now much more maintainable.",
    5000, ts(23.5)));

  // Phase 7: Additional large reads to push past 200K (turns 31-34)
  turns.push(userText(
    "Can you also check if there are any other files importing from the old auth module that need updating?",
    100, ts(25)));
  const t12 = assistantToolUse("bash", { command: "grep -r 'from.*auth/index' src/ --include='*.ts' -l" },
    "Let me find all files importing from the auth module.",
    8000, ts(25.5));
  turns.push(t12.turn);

  const importFiles = Array.from({ length: 15 }, (_, i) =>
    `src/${["routes", "middleware", "services", "controllers", "utils"][i % 5]}/${["users", "admin", "api", "health", "metrics"][i % 5]}.ts`,
  ).join("\n");
  turns.push(userToolResult(t12.toolId, importFiles, false, 5000, ts(26)));
  turns.push(assistantText(
    "Found 15 files importing from auth. Since we're re-exporting everything from the new index, these imports should still work. Let me verify with a type check.",
    8000, ts(26.5)));

  // Final verification
  turns.push(userText("Run tsc to make sure.", 40, ts(28)));
  const t13 = assistantToolUse("bash", { command: "npx tsc --noEmit 2>&1" },
    "Running TypeScript type checker.",
    5000, ts(28.5));
  turns.push(t13.turn);

  turns.push(userToolResult(t13.toolId,
    "No errors found.",
    false, 50, ts(29)));
  turns.push(assistantText(
    "TypeScript type check passes with no errors. All 15 consuming files work with the new module structure through the re-export index. The refactoring is fully complete.",
    5000, ts(29.5)));

  return {
    id: "cost-3-session",
    label: "Long session — auth module refactoring (~200K tokens)",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: 200_000,
      description:
        "A ~25-turn session (~200K tokens) refactoring a large auth module. " +
        "Exceeds context window, triggering compactions in baseline. " +
        "Measures Lore savings from avoided compaction cycles.",
    },
  };
}

function buildCost3Questions(): EvalQuestion[] {
  const S = "cost-3-long";
  const REF = "cost-3-session";
  return [
    costQuestion(`${S}-q1`, S, REF,
      "What was the total cost with Lore vs the compaction baseline for this long session?",
      "Verified via cost-verifier: totalCostWithLore vs totalCostBaseline. Lore should be cheaper due to avoided compactions.",
      ["total-cost", "savings"]),
    costQuestion(`${S}-q2`, S, REF,
      "What percentage savings did Lore achieve over the compaction baseline?",
      "Verified via cost-verifier: savingsPct = (baseline - lore) / baseline * 100. Expected positive (Lore cheaper).",
      ["savings-pct", "savings"], "medium"),
    costQuestion(`${S}-q3`, S, REF,
      "How many compaction cycles would the baseline have needed for this session?",
      "Verified via cost-verifier: counterfactual.avoidedCompactions. At ~200K tokens, expect 1-2 compaction cycles.",
      ["compaction-count", "counterfactual"], "medium"),
    costQuestion(`${S}-q4`, S, REF,
      "What was the estimated cost of the avoided compactions?",
      "Verified via cost-verifier: counterfactual.avoidedCompactionCost.",
      ["avoided-cost", "counterfactual"], "hard"),
    costQuestion(`${S}-q5`, S, REF,
      "What was the prompt cache hit rate for Lore during this session?",
      "Verified via cost-verifier: counterfactual.cacheHitRate. Lore's stable prefix should achieve higher cache hit rates.",
      ["cache-hit-rate", "efficiency"]),
    costQuestion(`${S}-q6`, S, REF,
      "What was the per-turn token breakdown (raw input vs cached input vs output) at the end of the session?",
      "Verified via cost-verifier: last TurnSnapshot from replay result.",
      ["per-turn-tokens", "efficiency"], "hard"),
  ];
}

// ============================================================================
// COST-4: Net Cost Impact (Multi-Session)
// ============================================================================

function buildCost4Sessions(): SessionTranscript[] {
  // Session 1: Initial feature setup
  resetToolIds();
  const s1Turns: ConversationTurn[] = [];

  s1Turns.push(userText(
    "Let's set up a new notification service. We need email, SMS, and push notification support.",
    150, ts(0)));
  const s1t1 = assistantToolUse("bash", { command: "mkdir -p src/notifications && ls src/" },
    "I'll create the notifications directory structure.",
    3000, ts(1));
  s1Turns.push(s1t1.turn);

  s1Turns.push(userToolResult(s1t1.toolId,
    "auth/  db/  routes/  services/  notifications/  utils/",
    false, 2000, ts(1.5)));
  const s1t2 = assistantToolUse("write", {
    path: "src/notifications/email.ts",
    content: "import { SES } from '@aws-sdk/client-ses';\n\nexport class EmailNotifier {\n  private ses: SES;\n  constructor() { this.ses = new SES({ region: 'us-east-1' }); }\n  async send(to: string, subject: string, body: string): Promise<void> {\n    await this.ses.sendEmail({ Source: 'noreply@app.com', Destination: { ToAddresses: [to] }, Message: { Subject: { Data: subject }, Body: { Html: { Data: body } } } });\n  }\n}",
  },
    "Starting with the email notifier using AWS SES.",
    5000, ts(2));
  s1Turns.push(s1t2.turn);

  s1Turns.push(userToolResult(s1t2.toolId, "File written successfully.", false, 50, ts(2.5)));
  const s1t3 = assistantToolUse("write", {
    path: "src/notifications/sms.ts",
    content: "import { SNS } from '@aws-sdk/client-sns';\n\nexport class SMSNotifier {\n  private sns: SNS;\n  constructor() { this.sns = new SNS({ region: 'us-east-1' }); }\n  async send(phoneNumber: string, message: string): Promise<void> {\n    await this.sns.publish({ PhoneNumber: phoneNumber, Message: message });\n  }\n}",
  },
    "And the SMS notifier using AWS SNS.",
    4000, ts(3));
  s1Turns.push(s1t3.turn);

  s1Turns.push(userToolResult(s1t3.toolId, "File written successfully.", false, 50, ts(3.5)));
  const s1t4 = assistantToolUse("write", {
    path: "src/notifications/push.ts",
    content: "import admin from 'firebase-admin';\n\nexport class PushNotifier {\n  async send(deviceToken: string, title: string, body: string): Promise<void> {\n    await admin.messaging().send({ token: deviceToken, notification: { title, body } });\n  }\n}",
  },
    "And push notifications via Firebase Cloud Messaging.",
    4000, ts(4));
  s1Turns.push(s1t4.turn);

  s1Turns.push(userToolResult(s1t4.toolId, "File written successfully.", false, 50, ts(4.5)));
  const s1t5 = assistantToolUse("write", {
    path: "src/notifications/index.ts",
    content: "import { EmailNotifier } from './email';\nimport { SMSNotifier } from './sms';\nimport { PushNotifier } from './push';\n\nexport type NotificationChannel = 'email' | 'sms' | 'push';\n\nexport class NotificationService {\n  private email = new EmailNotifier();\n  private sms = new SMSNotifier();\n  private push = new PushNotifier();\n\n  async notify(channel: NotificationChannel, recipient: string, message: { subject?: string; title?: string; body: string }) {\n    switch (channel) {\n      case 'email': return this.email.send(recipient, message.subject || '', message.body);\n      case 'sms': return this.sms.send(recipient, message.body);\n      case 'push': return this.push.send(recipient, message.title || '', message.body);\n    }\n  }\n}",
  },
    "Creating the unified NotificationService that dispatches to the right channel.",
    5000, ts(5));
  s1Turns.push(s1t5.turn);

  s1Turns.push(userToolResult(s1t5.toolId, "File written successfully.", false, 50, ts(5.5)));
  s1Turns.push(assistantText(
    "Notification service set up with three channels:\n- **Email**: AWS SES (`noreply@app.com`)\n- **SMS**: AWS SNS\n- **Push**: Firebase Cloud Messaging\n\nUnified through `NotificationService.notify(channel, recipient, message)`.",
    4000, ts(6)));

  s1Turns.push(userText("Add tests for each notifier.", 50, ts(8)));
  const s1t6 = assistantToolUse("bash", { command: "npm test -- --grep 'notification' 2>&1" },
    "Let me write and run the tests.",
    5000, ts(9));
  s1Turns.push(s1t6.turn);

  s1Turns.push(userToolResult(s1t6.toolId,
    "  NotificationService\n    ✓ sends email notification (23ms)\n    ✓ sends SMS notification (15ms)\n    ✓ sends push notification (18ms)\n    ✓ throws on invalid channel (5ms)\n\n  4 passing (63ms)",
    false, 3000, ts(9.5)));
  s1Turns.push(assistantText(
    "All 4 notification tests pass. The service is ready for integration.",
    3000, ts(10)));

  const session1: SessionTranscript = {
    id: "cost-4-session-1",
    label: "Multi-session: Notification service setup",
    projectPath: PROJECT_PATH,
    turns: s1Turns,
    metadata: {
      totalTokens: 40_000,
      description: "Session 1/3: Set up email, SMS, and push notification service.",
    },
  };

  // Session 2: Add templating and preferences (~next day)
  resetToolIds();
  const s2Turns: ConversationTurn[] = [];
  const day2 = new Date("2025-05-16T10:00:00Z").getTime();

  s2Turns.push(userText(
    "Let's add notification templates and user preferences to the notification service we built yesterday.",
    150, day2));
  const s2t1 = assistantToolUse("read", { path: "src/notifications/index.ts" },
    "Let me review the current notification service structure.",
    5000, day2 + 60_000);
  s2Turns.push(s2t1.turn);

  s2Turns.push(userToolResult(s2t1.toolId,
    "import { EmailNotifier } from './email';\nimport { SMSNotifier } from './sms';\nimport { PushNotifier } from './push';\n\nexport type NotificationChannel = 'email' | 'sms' | 'push';\n\nexport class NotificationService {\n  // ... existing implementation\n}",
    false, 4000, day2 + 90_000));
  const s2t2 = assistantToolUse("write", {
    path: "src/notifications/templates.ts",
    content: "export interface NotificationTemplate {\n  id: string;\n  name: string;\n  subject?: string;\n  bodyTemplate: string;\n  channel: 'email' | 'sms' | 'push';\n}\n\nconst TEMPLATES: Record<string, NotificationTemplate> = {\n  'welcome': { id: 'welcome', name: 'Welcome Email', subject: 'Welcome to {{appName}}!', bodyTemplate: 'Hi {{name}}, welcome to {{appName}}!', channel: 'email' },\n  'order-confirm': { id: 'order-confirm', name: 'Order Confirmation', subject: 'Order #{{orderId}} confirmed', bodyTemplate: 'Your order #{{orderId}} for ${{total}} has been confirmed.', channel: 'email' },\n  'otp': { id: 'otp', name: 'OTP Code', bodyTemplate: 'Your verification code is {{code}}. Expires in 5 minutes.', channel: 'sms' },\n  'new-message': { id: 'new-message', name: 'New Message', bodyTemplate: '{{sender}}: {{preview}}', channel: 'push' },\n};\n\nexport function getTemplate(id: string): NotificationTemplate | undefined { return TEMPLATES[id]; }\n\nexport function renderTemplate(template: NotificationTemplate, vars: Record<string, string>): { subject?: string; body: string } {\n  let body = template.bodyTemplate;\n  let subject = template.subject;\n  for (const [key, value] of Object.entries(vars)) {\n    body = body.replace(new RegExp(`{{${key}}}`, 'g'), value);\n    if (subject) subject = subject.replace(new RegExp(`{{${key}}}`, 'g'), value);\n  }\n  return { subject, body };\n}",
  },
    "Adding a template system with variable interpolation.",
    6000, day2 + 120_000);
  s2Turns.push(s2t2.turn);

  s2Turns.push(userToolResult(s2t2.toolId, "File written successfully.", false, 50, day2 + 150_000));
  const s2t3 = assistantToolUse("write", {
    path: "src/notifications/preferences.ts",
    content: "import { db } from '../db';\n\nexport interface UserNotificationPrefs {\n  userId: string;\n  emailEnabled: boolean;\n  smsEnabled: boolean;\n  pushEnabled: boolean;\n  quietHoursStart?: string; // 'HH:MM' format\n  quietHoursEnd?: string;\n}\n\nexport async function getUserPrefs(userId: string): Promise<UserNotificationPrefs> {\n  const { rows } = await db.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);\n  if (rows.length === 0) return { userId, emailEnabled: true, smsEnabled: true, pushEnabled: true };\n  return rows[0];\n}\n\nexport async function updateUserPrefs(userId: string, prefs: Partial<UserNotificationPrefs>): Promise<void> {\n  await db.query('INSERT INTO notification_preferences (user_id, email_enabled, sms_enabled, push_enabled, quiet_hours_start, quiet_hours_end) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id) DO UPDATE SET email_enabled = $2, sms_enabled = $3, push_enabled = $4, quiet_hours_start = $5, quiet_hours_end = $6', [userId, prefs.emailEnabled ?? true, prefs.smsEnabled ?? true, prefs.pushEnabled ?? true, prefs.quietHoursStart, prefs.quietHoursEnd]);\n}\n\nexport function isQuietHours(prefs: UserNotificationPrefs): boolean {\n  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;\n  const now = new Date();\n  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;\n  return current >= prefs.quietHoursStart && current <= prefs.quietHoursEnd;\n}",
  },
    "Adding user notification preferences with quiet hours support.",
    6000, day2 + 180_000);
  s2Turns.push(s2t3.turn);

  s2Turns.push(userToolResult(s2t3.toolId, "File written successfully.", false, 50, day2 + 210_000));
  const s2t4 = assistantToolUse("bash", { command: "npm test -- --grep 'notification' 2>&1" },
    "Running all notification tests.",
    5000, day2 + 240_000);
  s2Turns.push(s2t4.turn);

  s2Turns.push(userToolResult(s2t4.toolId,
    "  NotificationService\n    ✓ sends email notification (23ms)\n    ✓ sends SMS notification (15ms)\n    ✓ sends push notification (18ms)\n    ✓ throws on invalid channel (5ms)\n  Templates\n    ✓ renders welcome template (3ms)\n    ✓ renders OTP template (2ms)\n    ✓ returns undefined for unknown template (1ms)\n  Preferences\n    ✓ returns defaults for new user (12ms)\n    ✓ respects quiet hours (5ms)\n    ✓ updates preferences (18ms)\n\n  10 passing (105ms)",
    false, 4000, day2 + 270_000));
  s2Turns.push(assistantText(
    "All 10 notification tests pass — 4 original + 3 template + 3 preferences. The notification system now supports templates with variable interpolation and per-user channel preferences with quiet hours.",
    4000, day2 + 300_000));

  const session2: SessionTranscript = {
    id: "cost-4-session-2",
    label: "Multi-session: Notification templates and preferences",
    projectPath: PROJECT_PATH,
    turns: s2Turns,
    metadata: {
      totalTokens: 35_000,
      description: "Session 2/3: Add notification templates, user preferences, and quiet hours.",
    },
  };

  // Session 3: Fix delivery bugs (~2 days later)
  resetToolIds();
  const s3Turns: ConversationTurn[] = [];
  const day3 = new Date("2025-05-17T10:00:00Z").getTime();

  s3Turns.push(userText(
    "Users are reporting they're getting duplicate notifications. Some also get notifications during their quiet hours. Can you investigate?",
    150, day3));
  const s3t1 = assistantToolUse("bash", { command: "grep -n 'notify' src/notifications/index.ts" },
    "Let me look at the notification dispatch logic for potential duplicate sends.",
    4000, day3 + 60_000);
  s3Turns.push(s3t1.turn);

  s3Turns.push(userToolResult(s3t1.toolId,
    "12:  async notify(channel: NotificationChannel, recipient: string, message: { subject?: string; title?: string; body: string }) {\n13:    switch (channel) {\n14:      case 'email': return this.email.send(recipient, message.subject || '', message.body);\n15:      case 'sms': return this.sms.send(recipient, message.body);\n16:      case 'push': return this.push.send(recipient, message.title || '', message.body);\n17:    }",
    false, 3000, day3 + 90_000));
  const s3t2 = assistantToolUse("bash", { command: "grep -rn 'notify\\|NotificationService' src/routes/ src/services/ --include='*.ts'" },
    "Let me find all call sites to check for duplicate dispatch.",
    5000, day3 + 120_000);
  s3Turns.push(s3t2.turn);

  s3Turns.push(userToolResult(s3t2.toolId,
    "src/routes/orders.ts:45:    await notificationService.notify('email', user.email, { subject: 'Order confirmed', body: confirmationHtml });\nsrc/routes/orders.ts:46:    await notificationService.notify('email', user.email, { subject: 'Order confirmed', body: confirmationHtml });\nsrc/services/auth-service.ts:23:    await notificationService.notify('sms', user.phone, { body: `Your OTP is ${otp}` });\nsrc/services/message-service.ts:78:    await notificationService.notify('push', deviceToken, { title: 'New message', body: preview });",
    false, 4000, day3 + 150_000));
  s3Turns.push(assistantText(
    "Found it! There's a duplicate `notify()` call on lines 45-46 of `orders.ts` — the email confirmation is sent twice. Also, the notification service doesn't check user preferences before sending. Let me fix both issues.",
    5000, day3 + 180_000));

  s3Turns.push(userText("Yes, please fix both.", 40, day3 + 240_000));
  const s3t3 = assistantToolUse("write", {
    path: "src/notifications/index.ts",
    content: "import { EmailNotifier } from './email';\nimport { SMSNotifier } from './sms';\nimport { PushNotifier } from './push';\nimport { getUserPrefs, isQuietHours } from './preferences';\n\nexport type NotificationChannel = 'email' | 'sms' | 'push';\n\nexport class NotificationService {\n  private email = new EmailNotifier();\n  private sms = new SMSNotifier();\n  private push = new PushNotifier();\n\n  async notify(channel: NotificationChannel, recipient: string, message: { subject?: string; title?: string; body: string }, userId?: string) {\n    // Check user preferences if userId is provided\n    if (userId) {\n      const prefs = await getUserPrefs(userId);\n      if (isQuietHours(prefs)) return; // Skip during quiet hours\n      if (channel === 'email' && !prefs.emailEnabled) return;\n      if (channel === 'sms' && !prefs.smsEnabled) return;\n      if (channel === 'push' && !prefs.pushEnabled) return;\n    }\n    switch (channel) {\n      case 'email': return this.email.send(recipient, message.subject || '', message.body);\n      case 'sms': return this.sms.send(recipient, message.body);\n      case 'push': return this.push.send(recipient, message.title || '', message.body);\n    }\n  }\n}",
  },
    "Adding preference checks to the notification dispatch.",
    6000, day3 + 270_000);
  s3Turns.push(s3t3.turn);

  s3Turns.push(userToolResult(s3t3.toolId, "File written successfully.", false, 50, day3 + 300_000));
  const s3t4 = assistantToolUse("bash", { command: "npm test -- --grep 'notification' 2>&1" },
    "Running all notification tests to verify the fixes.",
    5000, day3 + 330_000);
  s3Turns.push(s3t4.turn);

  s3Turns.push(userToolResult(s3t4.toolId,
    "  NotificationService\n    ✓ sends email notification (23ms)\n    ✓ sends SMS notification (15ms)\n    ✓ sends push notification (18ms)\n    ✓ throws on invalid channel (5ms)\n    ✓ skips notification during quiet hours (8ms)\n    ✓ respects email disabled preference (6ms)\n    ✓ respects sms disabled preference (5ms)\n  Templates\n    ✓ renders welcome template (3ms)\n    ✓ renders OTP template (2ms)\n    ✓ returns undefined for unknown template (1ms)\n  Preferences\n    ✓ returns defaults for new user (12ms)\n    ✓ respects quiet hours (5ms)\n    ✓ updates preferences (18ms)\n\n  13 passing (123ms)",
    false, 4000, day3 + 360_000));
  s3Turns.push(assistantText(
    "All 13 tests pass (3 new tests for preference-based filtering). Fixed both issues:\n1. ✅ Removed duplicate email send in `orders.ts`\n2. ✅ Added preference + quiet hours checks in `NotificationService.notify()`",
    4000, day3 + 390_000));

  const session3: SessionTranscript = {
    id: "cost-4-session-3",
    label: "Multi-session: Fix duplicate/quiet-hours notification bugs",
    projectPath: PROJECT_PATH,
    turns: s3Turns,
    metadata: {
      totalTokens: 35_000,
      description: "Session 3/3: Fix duplicate notifications and quiet hours enforcement.",
    },
  };

  return [session1, session2, session3];
}

function buildCost4Questions(): EvalQuestion[] {
  const S = "cost-4-multi";
  return [
    costQuestion(`${S}-q1`, S, "cost-4-session-1,cost-4-session-2,cost-4-session-3",
      "What was the per-session cost for each of the 3 sessions with Lore enabled?",
      "Verified via cost-verifier: per-session totalCostWithLore from each session's CostMetrics.",
      ["per-session-cost", "multi-session"]),
    costQuestion(`${S}-q2`, S, "cost-4-session-1,cost-4-session-2,cost-4-session-3",
      "What was the cumulative cost across all 3 sessions (Lore vs baseline)?",
      "Verified via cost-verifier: sum(lore_sessions) vs sum(baseline_sessions).",
      ["cumulative-cost", "multi-session"], "medium"),
    costQuestion(`${S}-q3`, S, "cost-4-session-2,cost-4-session-3",
      "How much did sessions 2 and 3 save from recall-based context vs re-reading files that were already known from earlier sessions?",
      "Verified via cost-verifier: estimated savings from recall replacing re-exploration in sessions 2 and 3.",
      ["recall-savings", "multi-session"], "hard"),
    costQuestion(`${S}-q4`, S, "cost-4-session-1,cost-4-session-2,cost-4-session-3",
      "What is the LTM/knowledge overhead amortized across all 3 sessions?",
      "Verified via cost-verifier: sum(breakdown.curation) / 3 across all sessions.",
      ["ltm-overhead", "multi-session"], "medium"),
    costQuestion(`${S}-q5`, S, "cost-4-session-1,cost-4-session-2,cost-4-session-3",
      "How many total distillation and curation API calls were made across all 3 sessions?",
      "Verified via cost-verifier: count of records where callType in ('distillation', 'curation') across all sessions.",
      ["api-call-count", "multi-session"]),
  ];
}

// ============================================================================
// COST-5: Batch API Savings
// ============================================================================

function buildCost5Session(): SessionTranscript {
  resetToolIds();
  const turns: ConversationTurn[] = [];

  // A moderately long session that will trigger background work:
  // distillation after idle periods, and curation when enough context accumulates.

  turns.push(userText(
    "I need to build a data pipeline that processes CSV files, transforms the data, and loads it into PostgreSQL. Let's use Node.js streams for efficiency.",
    200, ts(0)));
  const t1 = assistantToolUse("write", {
    path: "src/pipeline/csv-reader.ts",
    content: "import { createReadStream } from 'fs';\nimport { parse } from 'csv-parse';\nimport { Transform } from 'stream';\n\nexport function createCSVReader(filePath: string) {\n  return createReadStream(filePath).pipe(parse({ columns: true, skip_empty_lines: true }));\n}\n\nexport class DataTransformer extends Transform {\n  constructor(private transformFn: (row: Record<string, string>) => Record<string, unknown>) {\n    super({ objectMode: true });\n  }\n  _transform(chunk: Record<string, string>, _encoding: string, callback: Function) {\n    try {\n      callback(null, this.transformFn(chunk));\n    } catch (err) {\n      callback(err);\n    }\n  }\n}",
  },
    "I'll create a streaming CSV reader with a configurable transform step.",
    5000, ts(1));
  turns.push(t1.turn);

  turns.push(userToolResult(t1.toolId, "File written successfully.", false, 50, ts(1.5)));

  // Idle gap (simulates user reading/thinking — triggers distillation)
  const t2 = assistantToolUse("write", {
    path: "src/pipeline/db-writer.ts",
    content: "import { Writable } from 'stream';\nimport { db } from '../db';\n\nexport class DBWriter extends Writable {\n  private batch: Record<string, unknown>[] = [];\n  private batchSize: number;\n  private tableName: string;\n\n  constructor(tableName: string, batchSize = 1000) {\n    super({ objectMode: true });\n    this.tableName = tableName;\n    this.batchSize = batchSize;\n  }\n\n  async _write(chunk: Record<string, unknown>, _encoding: string, callback: Function) {\n    this.batch.push(chunk);\n    if (this.batch.length >= this.batchSize) {\n      await this.flush();\n    }\n    callback();\n  }\n\n  async _final(callback: Function) {\n    if (this.batch.length > 0) await this.flush();\n    callback();\n  }\n\n  private async flush() {\n    const columns = Object.keys(this.batch[0]);\n    const values = this.batch.map((row, i) =>\n      `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`\n    ).join(', ');\n    const params = this.batch.flatMap(row => columns.map(c => row[c]));\n    await db.query(`INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES ${values}`, params);\n    this.batch = [];\n  }\n}",
  },
    "Now the DB writer with batch insertion for performance.",
    6000, ts(5));  // 4 minute gap — should trigger background distillation
  turns.push(t2.turn);

  turns.push(userToolResult(t2.toolId, "File written successfully.", false, 50, ts(5.5)));
  turns.push(assistantText(
    "Created the streaming pipeline components:\n1. `csv-reader.ts` — Reads CSV with configurable transform\n2. `db-writer.ts` — Batched DB writer (default 1000 rows/batch)\n\nNow let's wire them together.",
    4000, ts(6)));

  // Another idle gap
  turns.push(userText(
    "Add error handling and a progress reporter. I want to see how many rows are processed per second.",
    120, ts(10)));  // 4 minute gap — triggers more background work
  const t3 = assistantToolUse("write", {
    path: "src/pipeline/progress.ts",
    content: "import { Transform } from 'stream';\n\nexport class ProgressReporter extends Transform {\n  private count = 0;\n  private startTime = Date.now();\n  private lastReport = 0;\n  private reportInterval: number;\n\n  constructor(reportIntervalMs = 5000) {\n    super({ objectMode: true });\n    this.reportInterval = reportIntervalMs;\n  }\n\n  _transform(chunk: unknown, _encoding: string, callback: Function) {\n    this.count++;\n    const now = Date.now();\n    if (now - this.lastReport >= this.reportInterval) {\n      const elapsed = (now - this.startTime) / 1000;\n      const rate = this.count / elapsed;\n      console.log(`Processed ${this.count} rows (${rate.toFixed(0)} rows/sec)`);\n      this.lastReport = now;\n    }\n    callback(null, chunk);\n  }\n\n  _final(callback: Function) {\n    const elapsed = (Date.now() - this.startTime) / 1000;\n    console.log(`Pipeline complete: ${this.count} rows in ${elapsed.toFixed(1)}s (${(this.count / elapsed).toFixed(0)} rows/sec)`);\n    callback();\n  }\n}",
  },
    "Adding a progress reporter that logs throughput every 5 seconds.",
    5000, ts(10.5));
  turns.push(t3.turn);

  turns.push(userToolResult(t3.toolId, "File written successfully.", false, 50, ts(11)));
  const t4 = assistantToolUse("write", {
    path: "src/pipeline/index.ts",
    content: "import { pipeline } from 'stream/promises';\nimport { createCSVReader, DataTransformer } from './csv-reader';\nimport { DBWriter } from './db-writer';\nimport { ProgressReporter } from './progress';\n\nexport interface PipelineConfig {\n  inputPath: string;\n  tableName: string;\n  transform: (row: Record<string, string>) => Record<string, unknown>;\n  batchSize?: number;\n}\n\nexport async function runPipeline(config: PipelineConfig): Promise<{ rowCount: number; duration: number }> {\n  const startTime = Date.now();\n  const reader = createCSVReader(config.inputPath);\n  const transformer = new DataTransformer(config.transform);\n  const progress = new ProgressReporter();\n  const writer = new DBWriter(config.tableName, config.batchSize);\n\n  try {\n    await pipeline(reader, transformer, progress, writer);\n    return { rowCount: (progress as any).count, duration: Date.now() - startTime };\n  } catch (err) {\n    console.error('Pipeline failed:', err);\n    throw err;\n  }\n}",
  },
    "Wiring everything together with Node.js `stream/promises.pipeline` for proper error propagation.",
    5000, ts(11.5));
  turns.push(t4.turn);

  turns.push(userToolResult(t4.toolId, "File written successfully.", false, 50, ts(12)));
  const t5 = assistantToolUse("bash", { command: "npm test -- --grep 'pipeline' 2>&1" },
    "Running pipeline tests.",
    5000, ts(12.5));
  turns.push(t5.turn);

  turns.push(userToolResult(t5.toolId,
    "  Data Pipeline\n    ✓ processes CSV file end-to-end (145ms)\n    ✓ handles malformed rows (23ms)\n    ✓ respects batch size (89ms)\n    ✓ reports progress (5012ms)\n    ✓ handles empty file (8ms)\n\n  5 passing (5.3s)",
    false, 3000, ts(13)));

  // Another idle gap — should trigger curation
  turns.push(assistantText(
    "All 5 pipeline tests pass. The streaming pipeline is complete with:\n- CSV reading with column detection\n- Configurable row transformation\n- Batched DB insertion (default 1000 rows)\n- Progress reporting with rows/sec throughput\n- Proper error propagation via `stream/promises.pipeline`",
    4000, ts(13.5)));

  turns.push(userText(
    "Looks great. Can you also add retry logic for transient DB errors during batch inserts?",
    100, ts(18)));  // 4.5 minute gap — triggers more background work
  const t6 = assistantToolUse("write", {
    path: "src/pipeline/db-writer.ts",
    content: "import { Writable } from 'stream';\nimport { db } from '../db';\n\nconst MAX_RETRIES = 3;\nconst RETRY_DELAY_MS = 1000;\n\nexport class DBWriter extends Writable {\n  private batch: Record<string, unknown>[] = [];\n  private batchSize: number;\n  private tableName: string;\n\n  constructor(tableName: string, batchSize = 1000) {\n    super({ objectMode: true });\n    this.tableName = tableName;\n    this.batchSize = batchSize;\n  }\n\n  async _write(chunk: Record<string, unknown>, _encoding: string, callback: Function) {\n    this.batch.push(chunk);\n    if (this.batch.length >= this.batchSize) {\n      try { await this.flush(); } catch (err) { return callback(err); }\n    }\n    callback();\n  }\n\n  async _final(callback: Function) {\n    try {\n      if (this.batch.length > 0) await this.flush();\n      callback();\n    } catch (err) { callback(err); }\n  }\n\n  private async flush(attempt = 1): Promise<void> {\n    const columns = Object.keys(this.batch[0]);\n    const values = this.batch.map((row, i) =>\n      `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`\n    ).join(', ');\n    const params = this.batch.flatMap(row => columns.map(c => row[c]));\n    try {\n      await db.query(`INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES ${values}`, params);\n      this.batch = [];\n    } catch (err: any) {\n      if (attempt < MAX_RETRIES && (err.code === '40001' || err.code === '40P01' || err.code === '08006')) {\n        console.warn(`DB write failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`);\n        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));\n        return this.flush(attempt + 1);\n      }\n      throw err;\n    }\n  }\n}",
  },
    "Adding retry logic with exponential backoff for transient DB errors (serialization failures, deadlocks, connection lost).",
    6000, ts(18.5));
  turns.push(t6.turn);

  turns.push(userToolResult(t6.toolId, "File written successfully.", false, 50, ts(19)));
  const t7 = assistantToolUse("bash", { command: "npm test -- --grep 'pipeline' 2>&1" },
    "Re-running tests with the retry logic.",
    4000, ts(19.5));
  turns.push(t7.turn);

  turns.push(userToolResult(t7.toolId,
    "  Data Pipeline\n    ✓ processes CSV file end-to-end (148ms)\n    ✓ handles malformed rows (23ms)\n    ✓ respects batch size (92ms)\n    ✓ reports progress (5008ms)\n    ✓ handles empty file (8ms)\n    ✓ retries on serialization failure (3045ms)\n    ✓ retries on deadlock (2038ms)\n    ✓ fails after max retries (3125ms)\n\n  8 passing (13.5s)",
    false, 3000, ts(20)));
  turns.push(assistantText(
    "All 8 tests pass (3 new retry tests). The pipeline now handles:\n- Serialization failures (40001) — retry\n- Deadlocks (40P01) — retry\n- Connection lost (08006) — retry\n- Max 3 retries with linear backoff (1s, 2s, 3s)\n- Non-transient errors fail immediately",
    4000, ts(20.5)));

  return {
    id: "cost-5-session",
    label: "Session with idle gaps triggering background work",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: 70_000,
      description:
        "A session with deliberate idle gaps (4+ minutes between some turns) " +
        "that trigger background distillation and curation work. " +
        "Measures whether background work uses the batch API for 50% savings.",
    },
  };
}

function buildCost5Questions(): EvalQuestion[] {
  const S = "cost-5-batch";
  const REF = "cost-5-session";
  return [
    costQuestion(`${S}-q1`, S, REF,
      "How many background distillation API calls were made during this session?",
      "Verified via cost-verifier: count of records where callType === 'distillation'.",
      ["distillation-calls", "batch"]),
    costQuestion(`${S}-q2`, S, REF,
      "How many background curation API calls were made during this session?",
      "Verified via cost-verifier: count of records where callType === 'curation'.",
      ["curation-calls", "batch"]),
    costQuestion(`${S}-q3`, S, REF,
      "What percentage of background API calls used the batch API (50% cost tier)?",
      "Verified via cost-verifier: batchEligibleCalls / totalBackgroundCalls * 100.",
      ["batch-pct", "batch"], "medium"),
    costQuestion(`${S}-q4`, S, REF,
      "What was the total dollar savings from batch API usage?",
      "Verified via cost-verifier: counterfactual.batchSavings — difference between standard and batch pricing for eligible calls.",
      ["batch-savings", "batch"], "medium"),
    costQuestion(`${S}-q5`, S, REF,
      "Did batch API queuing introduce noticeable latency in background work completion?",
      "Verified via cost-verifier: measure time between idle trigger and distillation completion. Batch latency should not significantly delay knowledge availability.",
      ["batch-latency", "batch"], "hard"),
  ];
}

// ============================================================================
// Exported scenarios
// ============================================================================

export const scenarios: ScenarioDefinition[] = [
  {
    id: "cost-1-accuracy",
    name: "COST-1: Cost Tracking Accuracy",
    dimension: DIMENSION,
    applicableBaselines: ["lore"],
    sessions: [buildCost1Session()],
    questions: buildCost1Questions(),
  },
  {
    id: "cost-2-short",
    name: "COST-2: Net Cost Impact (Short Session)",
    dimension: DIMENSION,
    applicableBaselines: [
      "lore",
      "lore-context-only",
      "lore-memory-only",
      "tail-window",
    ],
    sessions: [buildCost2Session()],
    questions: buildCost2Questions(),
  },
  {
    id: "cost-3-long",
    name: "COST-3: Net Cost Impact (Long Session)",
    dimension: DIMENSION,
    applicableBaselines: [
      "lore",
      "lore-context-only",
      "lore-memory-only",
      "tail-window",
      "compaction",
    ],
    sessions: [buildCost3Session()],
    questions: buildCost3Questions(),
  },
  {
    id: "cost-4-multi",
    name: "COST-4: Net Cost Impact (Multi-Session)",
    dimension: DIMENSION,
    applicableBaselines: [
      "lore",
      "lore-context-only",
      "lore-memory-only",
      "tail-window",
    ],
    sessions: buildCost4Sessions(),
    questions: buildCost4Questions(),
  },
  {
    id: "cost-5-batch",
    name: "COST-5: Batch API Savings",
    dimension: DIMENSION,
    applicableBaselines: ["lore"],
    sessions: [buildCost5Session()],
    questions: buildCost5Questions(),
  },
];
