/**
 * Scenario Inflator for the Lore eval suite.
 *
 * Inflates compact scenario transcripts with realistic filler turns so that
 * total token counts exceed the model context window, forcing Lore's
 * compression/distillation pipeline to engage. Filler content avoids keywords
 * from scenario questions to prevent accidental recall contamination.
 *
 * Public API: `inflateScenario(scenario, targetTokens)`
 */

import type {
  ConversationTurn,
  SessionTranscript,
  ScenarioDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

/** Category of filler template. */
type FillerCategory = "feature" | "test" | "refactor" | "debug";

/** A filler template function: given a topic, returns a user+assistant pair. */
type FillerTemplate = (topic: string) => ConversationTurn[];

interface FillerEntry {
  category: FillerCategory;
  /** Keywords this template uses — matched against protected set. */
  keywords: string[];
  generate: FillerTemplate;
}

/** Tokens-per-char approximation (same as multi-session-recall scenario). */
const CHARS_PER_TOKEN = 4;

/** Minimum tokens per filler exchange. */
const MIN_FILLER_TOKENS = 1800;

/** Target tokens per filler exchange (2-4K range). */
const TARGET_FILLER_TOKENS = 3000;

/** Topics used for filler generation — generic enough to avoid domain clash. */
const FILLER_TOPICS = [
  "inventory",
  "scheduler",
  "metrics",
  "notifications",
  "analytics",
  "billing",
  "permissions",
  "migrations",
  "cache",
  "webhooks",
  "audit-log",
  "pagination",
  "rate-limit",
  "health-check",
  "export",
  "onboarding",
  "search-index",
  "batch-jobs",
  "file-storage",
  "i18n",
] as const;

// ---------------------------------------------------------------------------
// Token Estimation Utilities
// ---------------------------------------------------------------------------

/** Estimate token count from text content (chars / 4, min 50). */
function estimateTokensFromText(text: string): number {
  return Math.max(50, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Estimate total tokens for a turn array. */
function estimateTurnTokens(turns: ConversationTurn[]): number {
  return turns.reduce((sum, t) => {
    if (t.tokens) return sum + t.tokens;
    const chars = t.content.reduce((s, p) => {
      if (p.type === "text") return s + p.text.length;
      if (p.type === "tool_result") return s + p.content.length;
      if (p.type === "tool_use")
        return s + JSON.stringify(p.input).length + 40;
      return s;
    }, 0);
    return sum + Math.max(50, Math.ceil(chars / CHARS_PER_TOKEN));
  }, 0);
}

/** Stamp token estimates onto turns that lack them. */
function stampTokens(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.map((t) => {
    if (t.tokens != null) return t;
    const chars = t.content.reduce((s, p) => {
      if (p.type === "text") return s + p.text.length;
      if (p.type === "tool_result") return s + p.content.length;
      if (p.type === "tool_use")
        return s + JSON.stringify(p.input).length + 40;
      return s;
    }, 0);
    return { ...t, tokens: Math.max(50, Math.ceil(chars / CHARS_PER_TOKEN)) };
  });
}

// ---------------------------------------------------------------------------
// Turn Helpers (matching existing scenario patterns)
// ---------------------------------------------------------------------------

let _toolCallId = 0;
function nextToolId(): string {
  return `toolu_eval_fill_${String(++_toolCallId).padStart(5, "0")}`;
}

function userText(text: string, timestamp?: number): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    tokens: estimateTokensFromText(text),
    timestamp,
    isFiller: true,
  };
}

function assistantText(text: string, timestamp?: number): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    tokens: estimateTokensFromText(text),
    timestamp,
    isFiller: true,
  };
}

function assistantToolUse(
  name: string,
  input: unknown,
  preamble?: string,
  timestamp?: number,
): { turn: ConversationTurn; id: string } {
  const id = nextToolId();
  const parts: ConversationTurn["content"] = [];
  if (preamble) parts.push({ type: "text", text: preamble });
  parts.push({ type: "tool_use", id, name, input });
  const chars =
    (preamble?.length ?? 0) + JSON.stringify(input).length + 40;
  return {
    id,
    turn: {
      role: "assistant",
      content: parts,
      tokens: Math.max(50, Math.ceil(chars / CHARS_PER_TOKEN)),
      timestamp,
      isFiller: true,
    },
  };
}

function userToolResult(
  toolUseId: string,
  content: string,
  isError = false,
  timestamp?: number,
): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
    tokens: estimateTokensFromText(content),
    timestamp,
    isFiller: true,
  };
}

// ---------------------------------------------------------------------------
// Filler Templates — Feature Category (4 templates)
// ---------------------------------------------------------------------------

const featureServiceEndpoint: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/service.ts`,
      content: `import { db } from "../db";
import { logger } from "../logger";
import { AppError, NotFoundError, ValidationError } from "../errors";
import type { ${capitalize(topic)}Config, ${capitalize(topic)}Record, Create${capitalize(topic)}Input } from "./${topic}.types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ${capitalize(topic)}Config = {
  maxRetries: 3,
  timeoutMs: 5000,
  batchSize: 100,
  enableNotifications: true,
  cacheTtlSeconds: 300,
};

let config: ${capitalize(topic)}Config = { ...DEFAULT_CONFIG };

export function configure(overrides: Partial<${capitalize(topic)}Config>): void {
  config = { ...config, ...overrides };
  logger.info(\`[${topic}] Configuration updated\`, { config });
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export async function create(input: Create${capitalize(topic)}Input): Promise<${capitalize(topic)}Record> {
  if (!input.name || input.name.trim().length === 0) {
    throw new ValidationError("Name is required");
  }
  if (input.name.length > 255) {
    throw new ValidationError("Name must be 255 characters or fewer");
  }

  const existing = await db.${topic}.findFirst({ where: { name: input.name } });
  if (existing) {
    throw new ValidationError(\`A ${topic} record with name "\${input.name}" already exists\`);
  }

  const record = await db.${topic}.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      status: "active",
      priority: input.priority ?? "medium",
      metadata: input.metadata ?? {},
      createdBy: input.userId,
    },
  });

  logger.info(\`[${topic}] Created record\`, { id: record.id, name: record.name });

  if (config.enableNotifications) {
    await notifyCreated(record).catch((err) => {
      logger.warn(\`[${topic}] Notification failed\`, { error: err.message });
    });
  }

  return record;
}

export async function findById(id: string): Promise<${capitalize(topic)}Record> {
  const record = await db.${topic}.findUnique({ where: { id } });
  if (!record) throw new NotFoundError(\`${capitalize(topic)} \${id} not found\`);
  return record;
}

export async function list(opts: {
  page?: number;
  pageSize?: number;
  status?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}): Promise<{ items: ${capitalize(topic)}Record[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const where = opts.status ? { status: opts.status } : {};
  const orderBy = { [opts.sortBy ?? "createdAt"]: opts.sortOrder ?? "desc" };

  const [items, total] = await Promise.all([
    db.${topic}.findMany({ where, orderBy, skip, take: pageSize }),
    db.${topic}.count({ where }),
  ]);

  return { items, total };
}

export async function update(
  id: string,
  changes: Partial<Pick<${capitalize(topic)}Record, "name" | "description" | "status" | "priority" | "metadata">>,
): Promise<${capitalize(topic)}Record> {
  const existing = await findById(id);
  if (existing.status === "archived" && changes.status !== "active") {
    throw new ValidationError("Cannot modify an archived record — restore it first");
  }

  const record = await db.${topic}.update({ where: { id }, data: changes });
  logger.info(\`[${topic}] Updated record\`, { id, changes: Object.keys(changes) });
  return record;
}

export async function remove(id: string): Promise<void> {
  await findById(id); // ensure exists
  await db.${topic}.update({ where: { id }, data: { status: "archived", archivedAt: new Date() } });
  logger.info(\`[${topic}] Archived record\`, { id });
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

async function notifyCreated(record: ${capitalize(topic)}Record): Promise<void> {
  // Placeholder — would publish to message queue in production
  logger.debug(\`[${topic}] Would notify about new record \${record.id}\`);
}
`,
    },
    `I'll create the ${topic} service with full CRUD operations, validation, and notification hooks.`,
  );
  return [
    userText(
      `Can you implement the ${topic} service? I need standard CRUD endpoints with validation, ` +
        `pagination for list, soft-delete via archiving, and notification hooks for create events.`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/service.ts`),
    assistantText(
      `Done. The ${topic} service has:\n\n` +
        `- \`create()\` — validates name (required, max 255, unique), fires notification\n` +
        `- \`findById()\` — throws NotFoundError if missing\n` +
        `- \`list()\` — paginated with status filter and sort\n` +
        `- \`update()\` — blocks modifications on archived records\n` +
        `- \`remove()\` — soft-delete via status="archived"\n` +
        `- \`configure()\` — runtime config overrides\n\n` +
        `Want me to add the route handler and types file next?`,
    ),
  ];
};

const featureTypesFile: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/${topic}.types.ts`,
      content: `/**
 * Types for the ${topic} module.
 */

export interface ${capitalize(topic)}Config {
  maxRetries: number;
  timeoutMs: number;
  batchSize: number;
  enableNotifications: boolean;
  cacheTtlSeconds: number;
}

export type ${capitalize(topic)}Status = "active" | "paused" | "archived" | "error";
export type ${capitalize(topic)}Priority = "low" | "medium" | "high" | "critical";

export interface ${capitalize(topic)}Record {
  id: string;
  name: string;
  description: string | null;
  status: ${capitalize(topic)}Status;
  priority: ${capitalize(topic)}Priority;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Create${capitalize(topic)}Input {
  name: string;
  description?: string;
  priority?: ${capitalize(topic)}Priority;
  metadata?: Record<string, unknown>;
  userId: string;
}

export interface Update${capitalize(topic)}Input {
  name?: string;
  description?: string | null;
  status?: ${capitalize(topic)}Status;
  priority?: ${capitalize(topic)}Priority;
  metadata?: Record<string, unknown>;
}

export interface ${capitalize(topic)}ListQuery {
  page?: number;
  pageSize?: number;
  status?: ${capitalize(topic)}Status;
  sortBy?: keyof ${capitalize(topic)}Record;
  sortOrder?: "asc" | "desc";
  search?: string;
}

export interface ${capitalize(topic)}ListResult {
  items: ${capitalize(topic)}Record[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ${capitalize(topic)}Event {
  type: "created" | "updated" | "archived" | "restored";
  recordId: string;
  timestamp: Date;
  actor: string;
  changes?: Partial<${capitalize(topic)}Record>;
}
`,
    },
    `Let me create the types for the ${topic} module.`,
  );
  return [
    userText(
      `Add the TypeScript types for the ${topic} module — config, record, ` +
        `input/output shapes, list query, and event types.`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/${topic}.types.ts`),
    assistantText(
      `Types created. Includes:\n` +
        `- \`${capitalize(topic)}Config\` for runtime configuration\n` +
        `- \`${capitalize(topic)}Record\` as the main entity\n` +
        `- Input/output types for create, update, and list\n` +
        `- \`${capitalize(topic)}Event\` for audit logging\n\n` +
        `These are imported by the service module.`,
    ),
  ];
};

const featureRouteHandler: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/routes.ts`,
      content: `import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import * as service from "./service";
import { requireAuth } from "../auth/middleware";
import { logger } from "../logger";

const router = Router();

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["active", "paused", "archived", "error"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["active", "paused", "archived", "error"]).optional(),
  sortBy: z.string().default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.use(requireAuth);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const record = await service.create({
      ...body,
      userId: (req as any).userId,
    });
    logger.info(\`[${topic}:routes] Created \${record.id}\`);
    res.status(201).json(record);
  }),
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const result = await service.list(query);
    res.json(result);
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const record = await service.findById(req.params.id);
    res.json(record);
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const record = await service.update(req.params.id, body);
    res.json(record);
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await service.remove(req.params.id);
    res.status(204).end();
  }),
);

export default router;
`,
    },
    `Now I'll create the Express route handler with Zod validation.`,
  );
  return [
    userText(
      `Create the route handler for the ${topic} endpoints. Use Zod for ` +
        `request validation, wrap async handlers properly, and apply auth middleware.`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/routes.ts`),
    assistantText(
      `Route handler created with:\n` +
        `- Zod schemas for create, update, and list query validation\n` +
        `- \`asyncHandler\` wrapper to catch promise rejections\n` +
        `- \`requireAuth\` middleware applied to all routes\n` +
        `- Standard REST: POST /, GET /, GET /:id, PATCH /:id, DELETE /:id`,
    ),
  ];
};

const featureWorkerQueue: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/worker.ts`,
      content: `import { Queue, Worker, type Job } from "bullmq";
import { redis } from "../redis";
import { logger } from "../logger";
import { db } from "../db";

// ---------------------------------------------------------------------------
// Queue Setup
// ---------------------------------------------------------------------------

const QUEUE_NAME = "${topic}-processing";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 5000;

export const ${topic}Queue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BACKOFF_MS },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800, count: 5000 },
  },
});

// ---------------------------------------------------------------------------
// Job Types
// ---------------------------------------------------------------------------

interface ProcessJobData {
  recordId: string;
  action: "compute" | "sync" | "cleanup";
  triggeredBy: string;
  payload?: Record<string, unknown>;
}

interface SyncJobData {
  batchIds: string[];
  destination: "warehouse" | "analytics" | "backup";
  dryRun: boolean;
}

type JobData = ProcessJobData | SyncJobData;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function isProcessJob(data: JobData): data is ProcessJobData {
  return "recordId" in data;
}

async function handleProcess(job: Job<ProcessJobData>): Promise<void> {
  const { recordId, action } = job.data;
  logger.info(\`[${topic}:worker] Processing \${action} for \${recordId}\`, {
    attempt: job.attemptsMade + 1,
  });

  const record = await db.${topic}.findUnique({ where: { id: recordId } });
  if (!record) {
    logger.warn(\`[${topic}:worker] Record \${recordId} not found, skipping\`);
    return; // Don't retry — record was deleted
  }

  switch (action) {
    case "compute": {
      // Simulate CPU-intensive computation
      const result = await computeMetrics(record);
      await db.${topic}.update({
        where: { id: recordId },
        data: { metadata: { ...record.metadata as object, lastComputed: result } },
      });
      break;
    }
    case "sync": {
      await syncToExternal(record);
      break;
    }
    case "cleanup": {
      if (record.status === "archived") {
        const age = Date.now() - new Date(record.archivedAt!).getTime();
        if (age > 30 * 24 * 3600 * 1000) {
          await db.${topic}.delete({ where: { id: recordId } });
          logger.info(\`[${topic}:worker] Hard-deleted archived record \${recordId}\`);
        }
      }
      break;
    }
  }
}

async function handleSync(job: Job<SyncJobData>): Promise<void> {
  const { batchIds, destination, dryRun } = job.data;
  logger.info(\`[${topic}:worker] Syncing \${batchIds.length} records to \${destination}\`, {
    dryRun,
  });

  for (const id of batchIds) {
    const record = await db.${topic}.findUnique({ where: { id } });
    if (!record) continue;
    if (!dryRun) {
      await pushToDestination(record, destination);
    }
  }
}

const worker = new Worker<JobData>(
  QUEUE_NAME,
  async (job) => {
    if (isProcessJob(job.data)) {
      await handleProcess(job as Job<ProcessJobData>);
    } else {
      await handleSync(job as Job<SyncJobData>);
    }
  },
  {
    connection: redis,
    concurrency: 5,
    limiter: { max: 20, duration: 60_000 },
  },
);

worker.on("failed", (job, err) => {
  logger.error(\`[${topic}:worker] Job \${job?.id} failed\`, {
    error: err.message,
    attempt: job?.attemptsMade,
    data: job?.data,
  });
});

worker.on("completed", (job) => {
  logger.debug(\`[${topic}:worker] Job \${job.id} completed\`);
});

// ---------------------------------------------------------------------------
// Stubs (would be real implementations)
// ---------------------------------------------------------------------------

async function computeMetrics(_record: unknown): Promise<Record<string, number>> {
  return { score: Math.random(), processedAt: Date.now() };
}

async function syncToExternal(_record: unknown): Promise<void> {
  // External API call placeholder
}

async function pushToDestination(_record: unknown, _dest: string): Promise<void> {
  // Destination-specific push placeholder
}

export { worker };
`,
    },
    `I'll implement the background worker using BullMQ for the ${topic} module.`,
  );
  return [
    userText(
      `Add a background job worker for the ${topic} module. Use BullMQ with ` +
        `Redis. Need processing, syncing, and cleanup job types with retry logic.`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/worker.ts`),
    assistantText(
      `Worker created with:\n` +
        `- BullMQ queue with exponential backoff (3 attempts)\n` +
        `- Two job types: process (compute/sync/cleanup) and batch sync\n` +
        `- Concurrency of 5, rate-limited to 20 jobs/minute\n` +
        `- Auto-cleanup of completed (24h) and failed (7d) jobs\n` +
        `- Proper error logging on failure events`,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Filler Templates — Test Category (4 templates)
// ---------------------------------------------------------------------------

const testUnitSuite: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `npx vitest run tests/${topic}/service.test.ts --reporter=verbose`,
  });
  return [
    userText(`Run the unit tests for the ${topic} service.`),
    t1.turn,
    userToolResult(
      t1.id,
      ` ✓ tests/${topic}/service.test.ts (18 tests | 4 suites)
   ✓ ${capitalize(topic)}Service > create
     ✓ creates a record with valid input (4ms)
     ✓ trims whitespace from name (2ms)
     ✓ sets default priority to medium (1ms)
     ✓ throws ValidationError for empty name (1ms)
     ✓ throws ValidationError for name exceeding 255 chars (1ms)
     ✓ throws ValidationError for duplicate name (3ms)
     ✓ fires notification on successful create (5ms)
   ✓ ${capitalize(topic)}Service > findById
     ✓ returns record when found (1ms)
     ✓ throws NotFoundError when not found (1ms)
   ✓ ${capitalize(topic)}Service > list
     ✓ returns paginated results with defaults (3ms)
     ✓ respects page and pageSize params (2ms)
     ✓ filters by status (2ms)
     ✓ sorts by specified field and order (2ms)
     ✓ clamps pageSize to 1-100 range (1ms)
   ✓ ${capitalize(topic)}Service > update and remove
     ✓ updates allowed fields (2ms)
     ✓ blocks modification of archived records (1ms)
     ✓ soft-deletes by setting status to archived (2ms)
     ✓ sets archivedAt timestamp on removal (1ms)

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  14:22:07
   Duration  347ms (transform 89ms, setup 42ms, collect 31ms, tests 185ms)`,
    ),
    assistantText(
      `All 18 tests pass across 4 suites. The ${topic} service has ` +
        `good coverage of validation, CRUD operations, and edge cases. ` +
        `Duration is 347ms which is reasonable.`,
    ),
  ];
};

const testIntegrationSuite: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `npx vitest run tests/${topic}/integration.test.ts --reporter=verbose`,
  });
  return [
    userText(
      `Run the integration tests for ${topic} — I want to make sure the ` +
        `routes work end-to-end with the database.`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      ` ✓ tests/${topic}/integration.test.ts (14 tests | 3 suites)
   ✓ ${capitalize(topic)} API Integration > POST /${topic}
     ✓ creates a record and returns 201 (12ms)
     ✓ returns 400 for invalid body (3ms)
     ✓ returns 401 without auth token (2ms)
     ✓ returns 409 for duplicate name (8ms)
   ✓ ${capitalize(topic)} API Integration > GET /${topic}
     ✓ lists records with pagination (6ms)
     ✓ filters by status query param (4ms)
     ✓ returns empty array for no matches (3ms)
     ✓ defaults to page 1 size 20 desc (3ms)
   ✓ ${capitalize(topic)} API Integration > GET/PATCH/DELETE /${topic}/:id
     ✓ returns single record by id (3ms)
     ✓ returns 404 for nonexistent id (2ms)
     ✓ patches record fields (5ms)
     ✓ returns 400 for invalid status value (2ms)
     ✓ soft-deletes and returns 204 (4ms)
     ✓ returns 404 when deleting nonexistent id (2ms)

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  14:23:41
   Duration  1.24s (transform 112ms, setup 389ms, collect 48ms, tests 691ms)

stdout | tests/${topic}/integration.test.ts > beforeAll
  Using test database: /tmp/test-db-${topic}-integration-8a3f.sqlite`,
    ),
    assistantText(
      `All 14 integration tests pass. The setup creates an isolated SQLite ` +
        `test database. Tests cover all HTTP verbs, auth enforcement, ` +
        `validation errors, and 404 handling. Total time 1.24s which ` +
        `includes DB setup.`,
    ),
  ];
};

const testWriteSuite: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `tests/${topic}/worker.test.ts`,
      content: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ${topic}Queue, worker } from "../../src/${topic}/worker";
import { db } from "../../src/db";

vi.mock("../../src/db");
vi.mock("../../src/redis", () => ({
  redis: { duplicate: () => ({ connect: vi.fn() }) },
}));

describe("${capitalize(topic)} Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await worker.close();
  });

  describe("process jobs", () => {
    it("computes metrics for an active record", async () => {
      const mockRecord = {
        id: "rec-001",
        status: "active",
        metadata: {},
        archivedAt: null,
      };
      vi.mocked(db.${topic}.findUnique).mockResolvedValue(mockRecord as any);
      vi.mocked(db.${topic}.update).mockResolvedValue({ ...mockRecord, metadata: { lastComputed: {} } } as any);

      const job = { data: { recordId: "rec-001", action: "compute", triggeredBy: "test" }, attemptsMade: 0 };
      await worker.processJob(job as any);

      expect(db.${topic}.findUnique).toHaveBeenCalledWith({ where: { id: "rec-001" } });
      expect(db.${topic}.update).toHaveBeenCalled();
    });

    it("skips missing records without throwing", async () => {
      vi.mocked(db.${topic}.findUnique).mockResolvedValue(null);

      const job = { data: { recordId: "missing", action: "compute", triggeredBy: "test" }, attemptsMade: 0 };
      await expect(worker.processJob(job as any)).resolves.not.toThrow();
    });

    it("hard-deletes records archived for over 30 days", async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      const mockRecord = {
        id: "rec-old",
        status: "archived",
        archivedAt: oldDate,
      };
      vi.mocked(db.${topic}.findUnique).mockResolvedValue(mockRecord as any);
      vi.mocked(db.${topic}.delete).mockResolvedValue(mockRecord as any);

      const job = { data: { recordId: "rec-old", action: "cleanup", triggeredBy: "cron" }, attemptsMade: 0 };
      await worker.processJob(job as any);

      expect(db.${topic}.delete).toHaveBeenCalledWith({ where: { id: "rec-old" } });
    });

    it("does not delete recently archived records", async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 3600 * 1000);
      const mockRecord = {
        id: "rec-recent",
        status: "archived",
        archivedAt: recentDate,
      };
      vi.mocked(db.${topic}.findUnique).mockResolvedValue(mockRecord as any);

      const job = { data: { recordId: "rec-recent", action: "cleanup", triggeredBy: "cron" }, attemptsMade: 0 };
      await worker.processJob(job as any);

      expect(db.${topic}.delete).not.toHaveBeenCalled();
    });
  });

  describe("sync jobs", () => {
    it("syncs batch of records to warehouse", async () => {
      const records = [
        { id: "a", status: "active" },
        { id: "b", status: "active" },
      ];
      vi.mocked(db.${topic}.findUnique)
        .mockResolvedValueOnce(records[0] as any)
        .mockResolvedValueOnce(records[1] as any);

      const job = {
        data: { batchIds: ["a", "b"], destination: "warehouse", dryRun: false },
        attemptsMade: 0,
      };
      await worker.processJob(job as any);

      expect(db.${topic}.findUnique).toHaveBeenCalledTimes(2);
    });

    it("skips missing records during sync", async () => {
      vi.mocked(db.${topic}.findUnique)
        .mockResolvedValueOnce({ id: "a" } as any)
        .mockResolvedValueOnce(null);

      const job = {
        data: { batchIds: ["a", "gone"], destination: "analytics", dryRun: false },
        attemptsMade: 0,
      };
      await expect(worker.processJob(job as any)).resolves.not.toThrow();
    });

    it("does not push when dryRun is true", async () => {
      vi.mocked(db.${topic}.findUnique).mockResolvedValue({ id: "a" } as any);

      const job = {
        data: { batchIds: ["a"], destination: "backup", dryRun: true },
        attemptsMade: 0,
      };
      await worker.processJob(job as any);
      // No assertion on push — dryRun should prevent side effects
    });
  });
});
`,
    },
    `I'll write the unit tests for the ${topic} worker module.`,
  );
  return [
    userText(
      `Write unit tests for the ${topic} background worker. Mock the DB and ` +
        `Redis connections. Cover compute, cleanup (including the 30-day ` +
        `retention check), and sync job types.`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: tests/${topic}/worker.test.ts`),
    assistantText(
      `Worker tests written with 7 test cases:\n` +
        `- Compute: verifies DB lookup and update\n` +
        `- Missing record: ensures no throw (skip, don't retry)\n` +
        `- Cleanup: hard-deletes records archived >30 days\n` +
        `- Cleanup: preserves recently archived records\n` +
        `- Sync: processes batch of records\n` +
        `- Sync: skips missing records in batch\n` +
        `- Sync: respects dryRun flag`,
    ),
  ];
};

const testCoverageReport: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `npx vitest run tests/${topic}/ --coverage --reporter=verbose`,
  });
  return [
    userText(
      `Run the full test suite for ${topic} with coverage.`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      ` ✓ tests/${topic}/service.test.ts (18 tests)
 ✓ tests/${topic}/integration.test.ts (14 tests)
 ✓ tests/${topic}/worker.test.ts (7 tests)
 ✓ tests/${topic}/routes.test.ts (12 tests)

 Test Files  4 passed (4)
      Tests  51 passed (51)
   Start at  14:30:18
   Duration  3.81s

 % Coverage report from v8
 -----------------------|---------|----------|---------|---------|-------------------
 File                   | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
 -----------------------|---------|----------|---------|---------|-------------------
 All files              |   91.23 |    84.61 |   88.89 |   91.23 |
  src/${topic}/           |         |          |         |         |
   service.ts           |   94.44 |    90.00 |  100.00 |   94.44 | 78,112
   ${topic}.types.ts     |  100.00 |   100.00 |  100.00 |  100.00 |
   routes.ts            |   89.47 |    83.33 |   80.00 |   89.47 | 54-57,89
   worker.ts            |   85.71 |    75.00 |   83.33 |   85.71 | 94-97,121-124
 -----------------------|---------|----------|---------|---------|-------------------`,
    ),
    assistantText(
      `All 51 tests pass across 4 files. Coverage summary:\n` +
        `- **service.ts**: 94% statements, 90% branches\n` +
        `- **types**: 100% (type-only file)\n` +
        `- **routes**: 89% — uncovered lines are the error-boundary middleware fallback\n` +
        `- **worker**: 86% — the external push stubs aren't fully exercised\n\n` +
        `Overall: 91% statement coverage, 85% branch coverage. Good shape.`,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Filler Templates — Refactor Category (4 templates)
// ---------------------------------------------------------------------------

const refactorExtractHelper: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/validators.ts`,
      content: `import { z } from "zod";
import type { ${capitalize(topic)}Priority, ${capitalize(topic)}Status } from "./${topic}.types";

// ---------------------------------------------------------------------------
// Shared Validators — extracted from routes.ts and service.ts
// ---------------------------------------------------------------------------

/** Reusable name validator: non-empty, max 255, trimmed. */
export const nameSchema = z
  .string()
  .min(1, "Name is required")
  .max(255, "Name must be 255 characters or fewer")
  .transform((s) => s.trim());

/** Reusable description validator. */
export const descriptionSchema = z
  .string()
  .max(2000, "Description must be 2000 characters or fewer")
  .transform((s) => s.trim())
  .nullable()
  .optional();

/** Shared status enum validator. */
export const statusSchema = z.enum(["active", "paused", "archived", "error"]);

/** Shared priority enum validator. */
export const prioritySchema = z.enum(["low", "medium", "high", "critical"]);

/** Pagination query validator — reused across list endpoints. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1, "Page size must be at least 1")
    .max(100, "Page size must be at most 100")
    .default(20),
  sortBy: z.string().default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/** Validate and clamp pagination values (for service layer). */
export function normalizePagination(opts: {
  page?: number;
  pageSize?: number;
}): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** Type guard for valid status string. */
export function isValidStatus(s: string): s is ${capitalize(topic)}Status {
  return ["active", "paused", "archived", "error"].includes(s);
}

/** Type guard for valid priority string. */
export function isValidPriority(s: string): s is ${capitalize(topic)}Priority {
  return ["low", "medium", "high", "critical"].includes(s);
}
`,
    },
    `I'll extract the duplicated validation logic into a shared validators module.`,
  );
  return [
    userText(
      `The ${topic} module has validation logic duplicated across routes.ts and ` +
        `service.ts. Can you extract it into a shared validators file?`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/validators.ts`),
    assistantText(
      `Extracted shared validation into \`validators.ts\`:\n\n` +
        `**Before:** Zod schemas duplicated in routes.ts + manual checks in service.ts\n` +
        `**After:** Single source for name, description, status, priority, and pagination schemas\n\n` +
        `Also added \`normalizePagination()\` helper and type guards. ` +
        `Now both routes.ts and service.ts import from this module.`,
    ),
  ];
};

const refactorRenameSymbols: FillerTemplate = (topic) => {
  const oldName = `${topic}Manager`;
  const newName = `${topic}Service`;
  const t1 = assistantToolUse("bash", {
    command: `grep -rn "${oldName}" src/${topic}/ tests/${topic}/`,
  });
  const t2 = assistantToolUse("bash", {
    command: `sed -i 's/${oldName}/${newName}/g' src/${topic}/index.ts src/${topic}/service.ts tests/${topic}/service.test.ts`,
  });
  return [
    userText(
      `The ${topic} module still uses the old "${oldName}" naming. Rename it ` +
        `to "${newName}" everywhere — files, class names, imports, tests.`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      `src/${topic}/index.ts:3:export { ${oldName} } from "./service";
src/${topic}/index.ts:4:export type { ${oldName}Options } from "./service";
src/${topic}/service.ts:12:export class ${oldName} {
src/${topic}/service.ts:45:  // ${oldName} handles lifecycle
tests/${topic}/service.test.ts:5:import { ${oldName} } from "../../src/${topic}/service";
tests/${topic}/service.test.ts:8:describe("${oldName}", () => {
tests/${topic}/service.test.ts:14:  const svc = new ${oldName}(config);
tests/${topic}/service.test.ts:31:  const svc = new ${oldName}(config);`,
    ),
    t2.turn,
    userToolResult(
      t2.id,
      `(no output — files modified)`,
    ),
    assistantText(
      `Renamed \`${oldName}\` → \`${newName}\` across 3 files (8 occurrences):\n` +
        `- \`index.ts\`: export name + type export\n` +
        `- \`service.ts\`: class declaration + comment\n` +
        `- \`service.test.ts\`: import, describe block, and 2 instantiation sites\n\n` +
        `No backward-compat aliases — all call sites updated directly.`,
    ),
  ];
};

const refactorSplitModule: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/queries.ts`,
      content: `import { db } from "../db";
import type { ${capitalize(topic)}Record, ${capitalize(topic)}ListQuery, ${capitalize(topic)}ListResult } from "./${topic}.types";
import { normalizePagination } from "./validators";

// ---------------------------------------------------------------------------
// Read Queries — extracted from service.ts for separation of concerns
// ---------------------------------------------------------------------------

/**
 * Find a single record by ID.
 * Returns null instead of throwing — let the caller decide error behavior.
 */
export async function findById(id: string): Promise<${capitalize(topic)}Record | null> {
  return db.${topic}.findUnique({ where: { id } });
}

/**
 * Find a single record by name (case-insensitive).
 */
export async function findByName(name: string): Promise<${capitalize(topic)}Record | null> {
  return db.${topic}.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

/**
 * List records with pagination, filtering, and sorting.
 */
export async function list(query: ${capitalize(topic)}ListQuery): Promise<${capitalize(topic)}ListResult> {
  const { page, pageSize, skip } = normalizePagination(query);

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { description: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const orderBy = {
    [query.sortBy ?? "createdAt"]: query.sortOrder ?? "desc",
  };

  const [items, total] = await Promise.all([
    db.${topic}.findMany({ where, orderBy, skip, take: pageSize }),
    db.${topic}.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Count records by status — useful for dashboard widgets.
 */
export async function countByStatus(): Promise<Record<string, number>> {
  const results = await db.${topic}.groupBy({
    by: ["status"],
    _count: { status: true },
  });
  return Object.fromEntries(
    results.map((r) => [r.status, r._count.status]),
  );
}

/**
 * Find records that were last updated before a cutoff date.
 * Used by the cleanup worker to identify stale entries.
 */
export async function findStale(beforeDate: Date): Promise<${capitalize(topic)}Record[]> {
  return db.${topic}.findMany({
    where: { updatedAt: { lt: beforeDate }, status: { not: "archived" } },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
}
`,
    },
    `I'll extract the read queries into their own module for cleaner separation of concerns.`,
  );
  return [
    userText(
      `The ${topic} service.ts is getting large. Can you split out the read ` +
        `queries (findById, findByName, list, etc.) into a separate queries.ts module?`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/queries.ts`),
    assistantText(
      `Extracted read operations into \`queries.ts\`:\n\n` +
        `- \`findById()\` — returns null instead of throwing (caller decides)\n` +
        `- \`findByName()\` — case-insensitive lookup\n` +
        `- \`list()\` — uses shared \`normalizePagination()\`, supports text search\n` +
        `- \`countByStatus()\` — aggregate for dashboards\n` +
        `- \`findStale()\` — for cleanup worker\n\n` +
        `service.ts now only has write operations (create/update/remove). ` +
        `Both modules import from queries.ts when needed.`,
    ),
  ];
};

const refactorErrorHandling: FillerTemplate = (topic) => {
  const t1 = assistantToolUse(
    "write",
    {
      path: `src/${topic}/errors.ts`,
      content: `// ---------------------------------------------------------------------------
// Domain-specific errors for the ${topic} module
// ---------------------------------------------------------------------------

export class ${capitalize(topic)}Error extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "${capitalize(topic)}Error";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class ${capitalize(topic)}NotFoundError extends ${capitalize(topic)}Error {
  constructor(id: string) {
    super(
      \`${capitalize(topic)} record "\${id}" not found\`,
      "${topic.toUpperCase()}_NOT_FOUND",
      404,
      { id },
    );
    this.name = "${capitalize(topic)}NotFoundError";
  }
}

export class ${capitalize(topic)}ValidationError extends ${capitalize(topic)}Error {
  constructor(message: string, field?: string) {
    super(
      message,
      "${topic.toUpperCase()}_VALIDATION_ERROR",
      400,
      field ? { field } : undefined,
    );
    this.name = "${capitalize(topic)}ValidationError";
  }
}

export class ${capitalize(topic)}ConflictError extends ${capitalize(topic)}Error {
  constructor(field: string, value: string) {
    super(
      \`A ${topic} record with \${field} "\${value}" already exists\`,
      "${topic.toUpperCase()}_CONFLICT",
      409,
      { field, value },
    );
    this.name = "${capitalize(topic)}ConflictError";
  }
}

export class ${capitalize(topic)}StateError extends ${capitalize(topic)}Error {
  constructor(currentStatus: string, attemptedAction: string) {
    super(
      \`Cannot \${attemptedAction} a ${topic} record with status "\${currentStatus}"\`,
      "${topic.toUpperCase()}_INVALID_STATE",
      422,
      { currentStatus, attemptedAction },
    );
    this.name = "${capitalize(topic)}StateError";
  }
}

/**
 * Error handler middleware for ${topic} routes.
 * Converts domain errors to JSON responses; rethrows unknown errors.
 */
export function ${topic}ErrorHandler(
  err: Error,
  _req: unknown,
  res: any,
  next: (err?: Error) => void,
): void {
  if (err instanceof ${capitalize(topic)}Error) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  next(err);
}
`,
    },
    `I'll create domain-specific error classes for the ${topic} module to replace the generic throws.`,
  );
  return [
    userText(
      `The ${topic} module throws generic Error objects everywhere. Can you ` +
        `create proper domain error classes with status codes, error codes, ` +
        `and a toJSON method for API responses?`,
    ),
    t1.turn,
    userToolResult(t1.id, `File written: src/${topic}/errors.ts`),
    assistantText(
      `Created domain-specific error hierarchy:\n\n` +
        `- \`${capitalize(topic)}Error\` — base class with code, statusCode, details, toJSON()\n` +
        `- \`${capitalize(topic)}NotFoundError\` — 404\n` +
        `- \`${capitalize(topic)}ValidationError\` — 400\n` +
        `- \`${capitalize(topic)}ConflictError\` — 409 (duplicate name)\n` +
        `- \`${capitalize(topic)}StateError\` — 422 (invalid status transition)\n` +
        `- \`${topic}ErrorHandler()\` — Express middleware that serializes domain errors\n\n` +
        `Now service.ts should throw these instead of plain \`Error\` or ` +
        `the generic \`AppError\` class.`,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Filler Templates — Debug Category (3 templates)
// ---------------------------------------------------------------------------

const debugStackTrace: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `cat /tmp/${topic}-crash.log`,
  });
  return [
    userText(
      `The ${topic} service crashed in production. Here's the error from the monitoring dashboard:\n\n` +
        `\`\`\`\nTypeError: Cannot read properties of undefined (reading 'id')\n` +
        `    at processRecord (src/${topic}/service.ts:87:42)\n` +
        `    at async Promise.all (index 3)\n` +
        `    at async batchProcess (src/${topic}/worker.ts:56:18)\n` +
        `    at async Worker.handleJob (node_modules/bullmq/dist/classes/worker.js:312:9)\n\`\`\`\n\n` +
        `Can you investigate?`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      `[2025-05-14T08:22:17.234Z] ERROR ${topic}-worker: Unhandled error in job batch-proc-4821
  TypeError: Cannot read properties of undefined (reading 'id')
    at processRecord (file:///app/src/${topic}/service.ts:87:42)
    at async Promise.all (index 3)
    at async batchProcess (file:///app/src/${topic}/worker.ts:56:18)
    at async Worker.handleJob (file:///app/node_modules/bullmq/dist/cjs/classes/worker.js:312:9)

  Context:
    jobId: batch-proc-4821
    batchSize: 12
    failedIndex: 3
    input[3]: { "externalId": "ext-9f3a", "source": "import", "data": null }

[2025-05-14T08:22:17.235Z] WARN ${topic}-worker: Job batch-proc-4821 failed attempt 1/3
[2025-05-14T08:22:22.301Z] ERROR ${topic}-worker: Unhandled error in job batch-proc-4821 (retry 2)
  TypeError: Cannot read properties of undefined (reading 'id')
    at processRecord (file:///app/src/${topic}/service.ts:87:42)
    ...same stack...

[2025-05-14T08:22:32.455Z] ERROR ${topic}-worker: Job batch-proc-4821 permanently failed after 3 attempts`,
    ),
    assistantText(
      `Found the bug. The crash is at \`service.ts:87\` in \`processRecord()\` ` +
        `where it does \`record.data.id\` — but the import batch item at index 3 ` +
        `has \`"data": null\`.\n\n` +
        `**Root cause:** The external import API can return \`null\` for the ` +
        `\`data\` field when a record was soft-deleted on their side. Our code ` +
        `assumes \`data\` is always an object.\n\n` +
        `**Fix:**\n` +
        `\`\`\`typescript\n` +
        `// Before (line 87):\n` +
        `const internalId = record.data.id;\n\n` +
        `// After:\n` +
        `if (!record.data) {\n` +
        `  logger.warn(\`Skipping record with null data\`, { externalId: record.externalId });\n` +
        `  return null;\n` +
        `}\n` +
        `const internalId = record.data.id;\n` +
        `\`\`\`\n\n` +
        `Also, \`batchProcess()\` should use \`Promise.allSettled()\` instead of ` +
        `\`Promise.all()\` so one bad record doesn't kill the entire batch. ` +
        `Want me to apply both fixes?`,
    ),
  ];
};

const debugMemoryLeak: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `node --expose-gc -e "
const { ${topic}Cache } = require('./src/${topic}/cache');
const cache = new ${topic}Cache();
const used = () => process.memoryUsage().heapUsed / 1024 / 1024;
console.log('Baseline:', used().toFixed(1), 'MB');
for (let i = 0; i < 50000; i++) {
  cache.set('key-' + i, { data: 'x'.repeat(200), ts: Date.now() });
}
console.log('After 50k inserts:', used().toFixed(1), 'MB');
global.gc();
console.log('After GC:', used().toFixed(1), 'MB');
cache.prune();
global.gc();
console.log('After prune + GC:', used().toFixed(1), 'MB');
"`,
  });
  return [
    userText(
      `The ${topic} service memory keeps climbing in production — it hit 1.8GB ` +
        `yesterday before the OOM killer got it. I think there's a memory leak ` +
        `in the cache layer. Can you investigate?`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      `Baseline: 14.2 MB
After 50k inserts: 287.6 MB
After GC: 286.9 MB
After prune + GC: 42.3 MB`,
    ),
    assistantText(
      `Confirmed — the ${topic} cache leaks memory because entries are never ` +
        `evicted automatically. The \`prune()\` method works (drops from 287MB ` +
        `→ 42MB) but it's never called on a schedule.\n\n` +
        `**Issues found:**\n\n` +
        `1. **No TTL eviction**: \`.set()\` stores entries with a \`ts\` field but ` +
        `\`.get()\` never checks if it's expired. Stale entries accumulate indefinitely.\n\n` +
        `2. **No size cap**: The Map grows without bound. With 200-byte values, ` +
        `50K entries = ~287MB. Production likely has 200K+ entries after a week.\n\n` +
        `3. **\`prune()\` isn't scheduled**: It exists but nothing calls it. The ` +
        `constructor should set up a \`setInterval\` for periodic cleanup.\n\n` +
        `**Recommended fix:**\n\n` +
        `\`\`\`typescript\n` +
        `// In cache constructor:\n` +
        `this.maxEntries = opts.maxEntries ?? 10_000;\n` +
        `this.ttlMs = opts.ttlMs ?? 300_000; // 5 minutes\n` +
        `this.pruneInterval = setInterval(() => this.prune(), 60_000);\n\n` +
        `// In .get():\n` +
        `const entry = this.store.get(key);\n` +
        `if (!entry) return undefined;\n` +
        `if (Date.now() - entry.ts > this.ttlMs) {\n` +
        `  this.store.delete(key);\n` +
        `  return undefined;\n` +
        `}\n` +
        `return entry.data;\n\n` +
        `// In .set() — LRU eviction if over cap:\n` +
        `if (this.store.size >= this.maxEntries) {\n` +
        `  const oldest = this.store.keys().next().value;\n` +
        `  this.store.delete(oldest);\n` +
        `}\n` +
        `\`\`\`\n\n` +
        `Want me to apply these changes?`,
    ),
  ];
};

const debugConnectionPool: FillerTemplate = (topic) => {
  const t1 = assistantToolUse("bash", {
    command: `curl -s http://localhost:3000/${topic}/health | jq .`,
  });
  const t2 = assistantToolUse("bash", {
    command: `psql -c "SELECT count(*), state FROM pg_stat_activity WHERE application_name = '${topic}-svc' GROUP BY state;"`,
  });
  return [
    userText(
      `The ${topic} API is returning 503s intermittently. The logs show ` +
        `"connection pool exhausted" errors. Can you check the health endpoint ` +
        `and the database connections?`,
    ),
    t1.turn,
    userToolResult(
      t1.id,
      `{
  "status": "degraded",
  "uptime": 847291,
  "checks": {
    "database": {
      "status": "unhealthy",
      "latency": 12847,
      "error": "Timed out waiting for available connection (pool size: 10, active: 10, idle: 0, waiting: 47)"
    },
    "redis": {
      "status": "healthy",
      "latency": 2
    },
    "memory": {
      "status": "healthy",
      "heapUsed": "312MB",
      "heapTotal": "512MB",
      "rss": "418MB"
    }
  }
}`,
    ),
    t2.turn,
    userToolResult(
      t2.id,
      ` count | state
-------+------------------
    10 | active
    37 | idle in transaction
     3 | idle
(3 rows)`,
    ),
    assistantText(
      `Found the issue. **37 connections are stuck in "idle in transaction"** ` +
        `state, exhausting the pool.\n\n` +
        `**Root cause:** The ${topic} batch processor opens a transaction ` +
        `with \`db.$transaction()\` but doesn't close it when an item in the ` +
        `batch throws. The transaction stays open until the connection timeout ` +
        `(default: 5 minutes in Prisma), blocking pool slots.\n\n` +
        `**Evidence:**\n` +
        `- Pool has 10 slots, all 10 are active\n` +
        `- 37 connections idle-in-transaction = abandoned transactions from previous batches\n` +
        `- 47 requests queued waiting for a connection\n` +
        `- Health check DB latency: 12.8s (normally <10ms)\n\n` +
        `**Fix (two parts):**\n\n` +
        `1. **Wrap batch items in try/catch inside the transaction:**\n` +
        `\`\`\`typescript\n` +
        `await db.$transaction(async (tx) => {\n` +
        `  for (const item of batch) {\n` +
        `    try {\n` +
        `      await processItem(tx, item);\n` +
        `    } catch (err) {\n` +
        `      logger.error(\`Batch item failed\`, { item, error: err });\n` +
        `      failedItems.push({ item, error: err });\n` +
        `    }\n` +
        `  }\n` +
        `});\n` +
        `\`\`\`\n\n` +
        `2. **Add transaction timeout to Prisma config:**\n` +
        `\`\`\`prisma\n` +
        `datasource db {\n` +
        `  provider = "postgresql"\n` +
        `  url = env("DATABASE_URL")\n` +
        `}\n` +
        `generator client {\n` +
        `  provider = "prisma-client-js"\n` +
        `  previewFeatures = ["interactiveTransactions"]\n` +
        `}\n` +
        `// In code: db.$transaction(fn, { timeout: 30_000 })\n` +
        `\`\`\`\n\n` +
        `Should I apply both fixes and also increase the pool size to 20 as a safety margin?`,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Template Registry
// ---------------------------------------------------------------------------

const FILLER_TEMPLATES: FillerEntry[] = [
  // Feature (4)
  {
    category: "feature",
    keywords: ["service", "crud", "create", "endpoint", "validation", "notification"],
    generate: featureServiceEndpoint,
  },
  {
    category: "feature",
    keywords: ["types", "interface", "config", "schema", "event"],
    generate: featureTypesFile,
  },
  {
    category: "feature",
    keywords: ["route", "handler", "zod", "middleware", "express", "api"],
    generate: featureRouteHandler,
  },
  {
    category: "feature",
    keywords: ["worker", "queue", "bullmq", "redis", "job", "retry", "background"],
    generate: featureWorkerQueue,
  },
  // Test (4)
  {
    category: "test",
    keywords: ["unit", "test", "vitest", "suite", "pass"],
    generate: testUnitSuite,
  },
  {
    category: "test",
    keywords: ["integration", "api", "database", "end-to-end"],
    generate: testIntegrationSuite,
  },
  {
    category: "test",
    keywords: ["write", "test", "mock", "vi", "worker"],
    generate: testWriteSuite,
  },
  {
    category: "test",
    keywords: ["coverage", "report", "statements", "branches"],
    generate: testCoverageReport,
  },
  // Refactor (4)
  {
    category: "refactor",
    keywords: ["extract", "validator", "shared", "duplicate"],
    generate: refactorExtractHelper,
  },
  {
    category: "refactor",
    keywords: ["rename", "symbol", "manager", "class", "grep", "sed"],
    generate: refactorRenameSymbols,
  },
  {
    category: "refactor",
    keywords: ["split", "module", "queries", "separation", "concerns"],
    generate: refactorSplitModule,
  },
  {
    category: "refactor",
    keywords: ["error", "handling", "domain", "hierarchy", "status", "code"],
    generate: refactorErrorHandling,
  },
  // Debug (3)
  {
    category: "debug",
    keywords: ["crash", "stack", "trace", "undefined", "null", "production"],
    generate: debugStackTrace,
  },
  {
    category: "debug",
    keywords: ["memory", "leak", "heap", "oom", "gc", "cache", "eviction"],
    generate: debugMemoryLeak,
  },
  {
    category: "debug",
    keywords: ["connection", "pool", "database", "transaction", "503", "timeout"],
    generate: debugConnectionPool,
  },
];

// ---------------------------------------------------------------------------
// Utility: capitalize
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// extractProtectedKeywords — extracts words from scenario questions
// ---------------------------------------------------------------------------

/**
 * Extract keywords from scenario questions and reference answers that
 * filler content must not contain, to avoid recall contamination.
 *
 * Returns a lowercase Set of words (3+ chars, stop-words removed).
 */
export function extractProtectedKeywords(
  scenario: ScenarioDefinition,
): Set<string> {
  const STOP_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "from", "have", "has",
    "was", "were", "been", "are", "its", "will", "would", "could",
    "should", "can", "does", "did", "not", "but", "also", "about",
    "what", "when", "where", "which", "how", "who", "why", "than",
    "then", "into", "some", "any", "all", "each", "they", "them",
    "their", "there", "here", "other", "more", "most", "very",
    "just", "only", "even", "still", "after", "before", "between",
    "through", "during", "use", "used", "using", "user", "code",
    "file", "line", "test", "tests", "make", "like", "need",
    "new", "see", "set", "get", "way", "let", "ask",
  ]);

  const words = new Set<string>();

  for (const q of scenario.questions) {
    const sources = [q.question, q.referenceAnswer];
    for (const src of sources) {
      // Extract words, lowercased, 3+ chars, not stop words
      const matches = src.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g);
      if (matches) {
        for (const w of matches) {
          if (!STOP_WORDS.has(w)) words.add(w);
        }
      }
    }
  }

  return words;
}

// ---------------------------------------------------------------------------
// generateFillerTurns — pick templates avoiding protected keywords
// ---------------------------------------------------------------------------

/**
 * Generate a batch of filler turns that collectively produce approximately
 * `targetTokens` tokens. Avoids templates whose keywords overlap with
 * the protected set.
 */
export function generateFillerTurns(
  targetTokens: number,
  protectedKeywords: Set<string>,
  rng: () => number = Math.random,
): ConversationTurn[] {
  // Filter templates whose keywords don't clash with protected set
  const eligible = FILLER_TEMPLATES.filter(
    (t) => !t.keywords.some((kw) => protectedKeywords.has(kw.toLowerCase())),
  );

  if (eligible.length === 0) {
    // Fallback: use all templates if filtering is too aggressive
    eligible.push(...FILLER_TEMPLATES);
  }

  const turns: ConversationTurn[] = [];
  let accumulatedTokens = 0;
  let topicIndex = 0;

  // Track which template indices we've used to avoid exact repeats
  const usedTemplateIndices = new Set<number>();
  // Track which topics we've used to get variety
  const usedTopics = new Set<string>();

  // Safety: cap iterations to prevent infinite loops
  const maxIterations = Math.ceil(targetTokens / 100) + eligible.length * FILLER_TOPICS.length;
  let iterations = 0;

  while (accumulatedTokens < targetTokens && iterations < maxIterations) {
    iterations++;

    // Pick a template — prefer unused ones, then cycle
    let templateIdx: number;
    if (usedTemplateIndices.size < eligible.length) {
      // Find an unused template index
      do {
        templateIdx = Math.floor(rng() * eligible.length);
      } while (usedTemplateIndices.has(templateIdx));
    } else {
      // All used — reset and pick randomly
      usedTemplateIndices.clear();
      templateIdx = Math.floor(rng() * eligible.length);
    }
    usedTemplateIndices.add(templateIdx);

    // Pick a topic — avoid reuse until we exhaust the list
    let topic: string;
    if (usedTopics.size >= FILLER_TOPICS.length) {
      usedTopics.clear();
    }
    do {
      topicIndex = (topicIndex + 1) % FILLER_TOPICS.length;
      topic = FILLER_TOPICS[topicIndex];
    } while (usedTopics.has(topic));
    usedTopics.add(topic);

    const template = eligible[templateIdx];
    const fillerTurns = template.generate(topic);
    const fillerTokens = estimateTurnTokens(fillerTurns);

    // Stamp tokens on each turn
    const stamped = stampTokens(fillerTurns);
    turns.push(...stamped);
    accumulatedTokens += fillerTokens;
  }

  return turns;
}

// ---------------------------------------------------------------------------
// inflateSession — interleave filler between key turns
// ---------------------------------------------------------------------------

/**
 * Inflate a single session by interleaving filler turns between the
 * existing "key" turns. Filler is inserted at even intervals to simulate
 * a realistic coding session where important facts are surrounded by
 * routine work.
 *
 * @param session      Original session transcript
 * @param fillerTokens Total filler tokens to inject into this session
 * @param protected    Keywords to avoid in filler content
 * @param baseTime     Base timestamp for the session (ms)
 * @param rng          Deterministic RNG for reproducibility
 */
export function inflateSession(
  session: SessionTranscript,
  fillerTokens: number,
  protectedKeywords: Set<string>,
  baseTime: number,
  rng: () => number = Math.random,
): SessionTranscript {
  if (fillerTokens <= 0) return session;

  const keyTurns = session.turns;
  const fillerTurns = generateFillerTurns(
    fillerTokens,
    protectedKeywords,
    rng,
  );

  if (fillerTurns.length === 0) return session;

  // Determine injection points: distribute filler evenly between key turns.
  // We inject filler BETWEEN key turns, not at the very start or end.
  // The last chunk of key turns stays together (so the final question context
  // is preserved).
  const numSlots = Math.max(1, keyTurns.length - 1);
  const fillerChunks: ConversationTurn[][] = Array.from(
    { length: numSlots },
    () => [],
  );

  // Distribute filler turns round-robin across slots
  for (let i = 0; i < fillerTurns.length; i++) {
    fillerChunks[i % numSlots].push(fillerTurns[i]);
  }

  // Interleave: key turn, then filler chunk, then next key turn...
  const inflated: ConversationTurn[] = [];
  const MINUTE = 60_000;
  let currentTime = baseTime;

  for (let i = 0; i < keyTurns.length; i++) {
    // Add key turn with timestamp
    inflated.push({
      ...keyTurns[i],
      timestamp: keyTurns[i].timestamp ?? currentTime,
    });
    currentTime += 2 * MINUTE;

    // Add filler chunk (if any) after this key turn (not after the last)
    if (i < numSlots && fillerChunks[i].length > 0) {
      for (const ft of fillerChunks[i]) {
        inflated.push({ ...ft, timestamp: currentTime });
        currentTime += 1.5 * MINUTE;
      }
      // Time gap after filler block to simulate context switch
      currentTime += 3 * MINUTE;
    }
  }

  const totalTokens = estimateTurnTokens(inflated);

  return {
    ...session,
    turns: inflated,
    metadata: {
      ...session.metadata,
      totalTokens,
      description:
        session.metadata.description + ` [inflated: +${fillerTokens} tokens filler]`,
    },
  };
}

// ---------------------------------------------------------------------------
// inflateScenario — distribute filler across sessions, public API
// ---------------------------------------------------------------------------

/**
 * Inflate a scenario's sessions so total token count reaches `targetTokens`.
 * Filler is distributed proportionally across sessions based on their
 * current size.
 *
 * @param scenario     The scenario definition to inflate
 * @param targetTokens Target total tokens across all sessions (e.g. 450_000)
 * @param seed         Optional seed for deterministic RNG
 * @returns            New ScenarioDefinition with inflated sessions
 */
export function inflateScenario(
  scenario: ScenarioDefinition,
  targetTokens: number,
  seed?: number,
): ScenarioDefinition {
  // Simple seeded PRNG (mulberry32)
  function mulberry32(s: number): () => number {
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rng = seed != null ? mulberry32(seed) : Math.random;
  const protectedKeywords = extractProtectedKeywords(scenario);

  // Compute current total tokens across all sessions
  const currentTokens = scenario.sessions.reduce(
    (sum, s) => sum + s.metadata.totalTokens,
    0,
  );

  if (currentTokens >= targetTokens) {
    // Already at or above target — no inflation needed
    return scenario;
  }

  const tokensNeeded = targetTokens - currentTokens;

  // Distribute filler proportionally to session size (bigger sessions get more)
  const sessionWeights = scenario.sessions.map((s) => s.metadata.totalTokens);
  const totalWeight = sessionWeights.reduce((a, b) => a + b, 0);

  // Base timestamp for sessions, spaced hours apart
  const baseSessionTime = Date.now() - scenario.sessions.length * 3_600_000;

  const inflatedSessions = scenario.sessions.map((session, i) => {
    // Proportional share, with a floor so every session gets some filler
    const weight = totalWeight > 0 ? sessionWeights[i] / totalWeight : 1 / scenario.sessions.length;
    const sessionFillerTokens = Math.max(
      TARGET_FILLER_TOKENS, // at least one exchange worth
      Math.round(tokensNeeded * weight),
    );

    const sessionBaseTime = baseSessionTime + i * 3_600_000;

    return inflateSession(
      session,
      sessionFillerTokens,
      protectedKeywords,
      sessionBaseTime,
      rng,
    );
  });

  return {
    ...scenario,
    sessions: inflatedSessions,
  };
}
