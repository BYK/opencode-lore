/**
 * Context Management eval scenarios (CM-1, CM-2, CM-3).
 *
 * Dimension 1: Can Lore maintain access to information across a long coding
 * session as context grows beyond the model's window?
 */
import type {
  ScenarioDefinition,
  SessionTranscript,
  ConversationTurn,
  EvalQuestion,
  BaselineMode,
  PlantedFact,
} from "../types";
import { RUBRICS } from "../judge";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PROJECT_PATH = "/tmp/eval-project-cm";
const APPLICABLE_BASELINES: BaselineMode[] = [
  "lore",
  "lore-context-only",
  "lore-memory-only",
  "tail-window",
  "compaction",
];

let _toolId = 0;
function toolId(): string {
  return `toolu_eval_${(++_toolId).toString(36).padStart(6, "0")}`;
}

/** Shorthand: user text turn. */
function userText(text: string, tokens = 300, ts?: number): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    tokens,
    timestamp: ts,
  };
}

/** Shorthand: assistant text turn. */
function assistantText(
  text: string,
  tokens = 600,
  ts?: number,
): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    tokens,
    timestamp: ts,
  };
}

/** User turn containing a tool_result. */
function userToolResult(
  toolUseId: string,
  content: string,
  tokens = 3000,
  isError = false,
  ts?: number,
): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    tokens,
    timestamp: ts,
  };
}

/** Assistant turn that calls a tool. */
function assistantToolUse(
  preText: string,
  name: string,
  input: unknown,
  id?: string,
  tokens = 800,
  ts?: number,
): { turn: ConversationTurn; id: string } {
  const tid = id ?? toolId();
  return {
    turn: {
      role: "assistant",
      content: [
        { type: "text", text: preText },
        { type: "tool_use", id: tid, name, input },
      ],
      tokens,
      timestamp: ts,
    },
    id: tid,
  };
}

// ---------------------------------------------------------------------------
// Timestamps (spaced ~2-5 min apart to mimic real coding)
// ---------------------------------------------------------------------------

const T0 = Date.now() - 3_600_000; // 1 hour ago
function ts(minutesAfterT0: number): number {
  return T0 + minutesAfterT0 * 60_000;
}

// =========================================================================
// CM-1: Long Session Early Detail Retention
// =========================================================================

function buildCM1Transcript(): SessionTranscript {
  const turns: ConversationTurn[] = [];

  // -----------------------------------------------------------------------
  // Phase 1: Investigation (turns 0-9, ~30K tokens)
  // -----------------------------------------------------------------------

  // Turn 0 (user): Bug report
  turns.push(
    userText(
      `I got a Sentry alert for our file-upload service. Here's the issue:\n\n` +
      `Sentry Issue ID: UPLOAD-SVC-4821\n` +
      `Title: "TemporaryUploadError: ENOSPC — no space left on device"\n` +
      `Environment: production (us-east-1)\n` +
      `First seen: 2025-05-14T03:22:17Z\n` +
      `Events: 847 in the last 6 hours\n\n` +
      `User report from Sarah Chen (sarah.chen@acmecorp.com):\n` +
      `"I can't upload any files since this morning. Getting a 500 error every time. ` +
      `I'm trying to upload a 2MB CSV for the Q2 analytics report."\n\n` +
      `Can you investigate?`,
      500,
      ts(0),
    ),
  );

  // Turn 1 (assistant): Let me check
  const t1 = assistantToolUse(
    "Let me start by checking the disk usage on the upload service and looking at the error logs.",
    "bash",
    { command: "df -h /data/uploads && du -sh /data/uploads/tmp/" },
    undefined,
    400,
    ts(1),
  );
  turns.push(t1.turn);

  // Turn 2 (user): tool result — disk usage
  turns.push(
    userToolResult(
      t1.id,
      `Filesystem      Size  Used Avail Use% Mounted on\n` +
      `/dev/nvme1n1     100G   98G  2.0G  98% /data/uploads\n\n` +
      `94G\t/data/uploads/tmp/`,
      3000,
      false,
      ts(1),
    ),
  );

  // Turn 3 (assistant): tmp dir is huge, check what's in it
  const t3 = assistantToolUse(
    "The `/data/uploads/tmp/` directory is consuming 94GB out of 100GB. " +
    "These are likely stale temporary upload chunks that weren't cleaned up. Let me check what's in there.",
    "bash",
    { command: "ls -la /data/uploads/tmp/ | head -50 && echo '---' && ls /data/uploads/tmp/ | wc -l" },
    undefined,
    600,
    ts(2),
  );
  turns.push(t3.turn);

  // Turn 4 (user): tool result — file listing
  turns.push(
    userToolResult(
      t3.id,
      `total 98566144\n` +
      `drwxrwxrwx 2 upload-svc upload-svc 4096 May 14 09:30 .\n` +
      `drwxr-xr-x 5 upload-svc upload-svc 4096 Jan 12 00:00 ..\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 5242880 Mar 01 14:22 chunk_a3f8b2c1_001.part\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 5242880 Mar 01 14:22 chunk_a3f8b2c1_002.part\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 5242880 Mar 01 14:23 chunk_a3f8b2c1_003.part\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 10485760 Mar 03 09:15 chunk_b7d4e9f0_001.part\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 10485760 Mar 03 09:15 chunk_b7d4e9f0_002.part\n` +
      `-rw-r--r-- 1 upload-svc upload-svc 5242880 Mar 05 11:40 chunk_c2a1f8e3_001.part\n` +
      `... (truncated)\n` +
      `---\n` +
      `247891`,
      4000,
      false,
      ts(2),
    ),
  );

  // Turn 5 (assistant): 247K stale chunks, check the cleanup job
  const t5 = assistantToolUse(
    "There are 247,891 stale chunk files dating back to March. The cleanup cron job isn't working. " +
    "Let me check the cleanup configuration and the cron schedule.",
    "bash",
    { command: "cat /etc/cron.d/upload-cleanup && echo '===' && cat /opt/upload-svc/config/cleanup.yaml" },
    undefined,
    700,
    ts(3),
  );
  turns.push(t5.turn);

  // Turn 6 (user): tool result — cleanup config
  turns.push(
    userToolResult(
      t5.id,
      `# /etc/cron.d/upload-cleanup\n` +
      `# Cleanup stale upload chunks older than 24h\n` +
      `0 3 * * * upload-svc /opt/upload-svc/bin/cleanup-chunks --max-age 24h --dir /data/uploads/tmp/ >> /var/log/upload-cleanup.log 2>&1\n` +
      `===\n` +
      `# cleanup.yaml\n` +
      `cleanup:\n` +
      `  enabled: true\n` +
      `  max_age_hours: 24\n` +
      `  target_dir: /data/uploads/tmp/\n` +
      `  batch_size: 1000\n` +
      `  dry_run: false\n` +
      `  # Added 2025-02-28 — skip files matching active sessions\n` +
      `  skip_pattern: "chunk_*_active"\n`,
      3500,
      false,
      ts(3),
    ),
  );

  // Turn 7 (assistant): Config looks fine, check the logs
  const t7 = assistantToolUse(
    "The cron config looks correct — runs at 3 AM daily, removes chunks older than 24h. " +
    "But 247K files accumulated since March, so it must be failing. Let me check the cleanup logs.",
    "bash",
    { command: "tail -100 /var/log/upload-cleanup.log" },
    undefined,
    500,
    ts(4),
  );
  turns.push(t7.turn);

  // Turn 8 (user): tool result — cleanup log showing the error
  turns.push(
    userToolResult(
      t7.id,
      `2025-02-28 03:00:01 [INFO] Starting cleanup run...\n` +
      `2025-02-28 03:00:01 [INFO] Scanning /data/uploads/tmp/ for files older than 24h\n` +
      `2025-02-28 03:00:02 [INFO] Found 312 files to delete\n` +
      `2025-02-28 03:00:02 [INFO] Deleted 312 files (1.5GB freed)\n` +
      `2025-03-01 03:00:01 [INFO] Starting cleanup run...\n` +
      `2025-03-01 03:00:01 [ERROR] Failed to acquire lock: /var/run/upload-svc/cleanup.lock — Resource temporarily unavailable\n` +
      `2025-03-01 03:00:01 [ERROR] Another cleanup process may be running. Aborting.\n` +
      `2025-03-02 03:00:01 [INFO] Starting cleanup run...\n` +
      `2025-03-02 03:00:01 [ERROR] Failed to acquire lock: /var/run/upload-svc/cleanup.lock — Resource temporarily unavailable\n` +
      `2025-03-02 03:00:01 [ERROR] Another cleanup process may be running. Aborting.\n` +
      `... (same error repeated daily through 2025-05-14)\n` +
      `2025-05-14 03:00:01 [INFO] Starting cleanup run...\n` +
      `2025-05-14 03:00:01 [ERROR] Failed to acquire lock: /var/run/upload-svc/cleanup.lock — Resource temporarily unavailable\n`,
      5000,
      false,
      ts(4),
    ),
  );

  // Turn 9 (assistant): Found root cause — stale lock file
  const t9 = assistantToolUse(
    "Found the root cause! The cleanup has been failing since March 1st because of a stale lock file at " +
    "`/var/run/upload-svc/cleanup.lock`. The lock was never released after the Feb 28 run " +
    "(likely the process was killed mid-cleanup). Every subsequent run sees the lock and aborts.\n\n" +
    "My initial hypothesis was that the cron job was misconfigured or disabled, but actually the " +
    "cron is running fine — it's the stale lock preventing execution.\n\n" +
    "Let me check the lock file and also look at the dependency versions to understand the locking mechanism.",
    "bash",
    { command: "ls -la /var/run/upload-svc/cleanup.lock && cat /var/run/upload-svc/cleanup.lock && echo '===' && cat /opt/upload-svc/package.json | grep -A5 'dependencies'" },
    undefined,
    900,
    ts(5),
  );
  turns.push(t9.turn);

  // Turn 10 (user): tool result — lock file details
  turns.push(
    userToolResult(
      t9.id,
      `-rw-r--r-- 1 upload-svc upload-svc 6 Feb 28 03:00 /var/run/upload-svc/cleanup.lock\n` +
      `28451\n` +
      `===\n` +
      `  "dependencies": {\n` +
      `    "proper-lockfile": "4.1.2",\n` +
      `    "express": "4.18.2",\n` +
      `    "multer": "1.4.5-lts.1",\n` +
      `    "aws-sdk": "2.1540.0",\n` +
      `    "winston": "3.11.0"\n` +
      `  },`,
      3000,
      false,
      ts(5),
    ),
  );

  // Turn 11 (assistant): Explain the issue and plan fix
  turns.push(
    assistantText(
      "Here's the complete picture:\n\n" +
      "**Root Cause**: A stale lock file at `/var/run/upload-svc/cleanup.lock` (PID 28451, from Feb 28) " +
      "is preventing the daily cleanup cron from running. The `proper-lockfile@4.1.2` library uses " +
      "PID-based stale detection, but it only checks if the PID is alive on the *same machine*. " +
      "Since this is running in a container that was restarted, PID 28451 doesn't exist, yet " +
      "the library still considers the lock valid because the file exists.\n\n" +
      "**Impact**: 247,891 stale chunk files accumulating since March 1st, consuming 94GB of the 100GB disk. " +
      "New uploads fail with ENOSPC.\n\n" +
      "**Fix plan**:\n" +
      "1. Immediate: Remove the stale lock file and run cleanup manually\n" +
      "2. Code fix: Switch from file-based locking to advisory locking (flock) which is automatically " +
      "released on process exit\n" +
      "3. Add a staleness check: if lock file age > 1 hour, remove and re-acquire\n" +
      "4. Add disk usage monitoring alert at 80% threshold\n\n" +
      "Let me start with the immediate fix.",
      1200,
      ts(6),
    ),
  );

  // -----------------------------------------------------------------------
  // Phase 2: Root Cause Analysis (turns 12-19, ~40K tokens)
  // -----------------------------------------------------------------------

  // Turn 12 (user): go ahead with the fix
  turns.push(
    userText(
      "Good analysis! Let's go with that plan. Start with the immediate fix, then we'll update the code.",
      200,
      ts(8),
    ),
  );

  // Turn 13 (assistant): Remove lock, run cleanup
  const t13 = assistantToolUse(
    "Let me remove the stale lock and run the cleanup manually.",
    "bash",
    { command: "rm /var/run/upload-svc/cleanup.lock && /opt/upload-svc/bin/cleanup-chunks --max-age 24h --dir /data/uploads/tmp/ --verbose 2>&1 | tail -20" },
    undefined,
    500,
    ts(8),
  );
  turns.push(t13.turn);

  // Turn 14 (user): tool result — cleanup output
  turns.push(
    userToolResult(
      t13.id,
      `2025-05-14 09:35:02 [INFO] Lock acquired successfully\n` +
      `2025-05-14 09:35:02 [INFO] Scanning /data/uploads/tmp/ for files older than 24h\n` +
      `2025-05-14 09:35:15 [INFO] Found 247,342 files to delete (549 recent files skipped)\n` +
      `2025-05-14 09:35:15 [INFO] Batch 1/248: deleting 1000 files...\n` +
      `... (batch processing)\n` +
      `2025-05-14 09:42:30 [INFO] Batch 248/248: deleting 342 files...\n` +
      `2025-05-14 09:42:31 [INFO] Cleanup complete: deleted 247,342 files, freed 93.2GB\n` +
      `2025-05-14 09:42:31 [INFO] Lock released`,
      4000,
      false,
      ts(10),
    ),
  );

  // Turn 15 (assistant): Great, now look at code
  const t15 = assistantToolUse(
    "Cleanup freed 93.2GB. Now let me look at the cleanup code to fix the locking mechanism. " +
    "I considered two approaches:\n" +
    "1. **Advisory locking with flock()** — OS automatically releases on process exit\n" +
    "2. **Lock file with staleness check** — check lock age, remove if stale\n\n" +
    "I'm going with approach 1 (flock) because it's more robust — the OS guarantees release " +
    "even on SIGKILL, whereas approach 2 has a race condition window.",
    "read",
    { path: "/opt/upload-svc/src/cleanup.ts" },
    undefined,
    800,
    ts(12),
  );
  turns.push(t15.turn);

  // Turn 16 (user): tool result — cleanup source code
  turns.push(
    userToolResult(
      t15.id,
      `import { lock, unlock } from 'proper-lockfile';\n` +
      `import { readdir, stat, unlink } from 'fs/promises';\n` +
      `import { join } from 'path';\n` +
      `import { logger } from './logger';\n\n` +
      `interface CleanupConfig {\n` +
      `  maxAgeHours: number;\n` +
      `  targetDir: string;\n` +
      `  batchSize: number;\n` +
      `  dryRun: boolean;\n` +
      `  skipPattern?: string;\n` +
      `}\n\n` +
      `export async function runCleanup(config: CleanupConfig): Promise<void> {\n` +
      `  const lockPath = '/var/run/upload-svc/cleanup.lock';\n\n` +
      `  try {\n` +
      `    await lock(lockPath, { retries: 0 });\n` +
      `    logger.info('Lock acquired successfully');\n` +
      `  } catch (err) {\n` +
      `    logger.error(\`Failed to acquire lock: \${lockPath} — \${(err as Error).message}\`);\n` +
      `    logger.error('Another cleanup process may be running. Aborting.');\n` +
      `    return;\n` +
      `  }\n\n` +
      `  try {\n` +
      `    const cutoff = Date.now() - config.maxAgeHours * 3600_000;\n` +
      `    const files = await readdir(config.targetDir);\n` +
      `    const staleFiles = [];\n\n` +
      `    for (const file of files) {\n` +
      `      if (config.skipPattern && file.includes(config.skipPattern.replace('*', ''))) continue;\n` +
      `      const filePath = join(config.targetDir, file);\n` +
      `      const stats = await stat(filePath);\n` +
      `      if (stats.mtimeMs < cutoff) staleFiles.push(filePath);\n` +
      `    }\n\n` +
      `    logger.info(\`Found \${staleFiles.length} files to delete\`);\n\n` +
      `    for (let i = 0; i < staleFiles.length; i += config.batchSize) {\n` +
      `      const batch = staleFiles.slice(i, i + config.batchSize);\n` +
      `      const batchNum = Math.floor(i / config.batchSize) + 1;\n` +
      `      const totalBatches = Math.ceil(staleFiles.length / config.batchSize);\n` +
      `      logger.info(\`Batch \${batchNum}/\${totalBatches}: deleting \${batch.length} files...\`);\n\n` +
      `      if (!config.dryRun) {\n` +
      `        await Promise.all(batch.map(f => unlink(f)));\n` +
      `      }\n` +
      `    }\n\n` +
      `    logger.info('Cleanup complete');\n` +
      `  } finally {\n` +
      `    await unlock(lockPath);\n` +
      `    logger.info('Lock released');\n` +
      `  }\n` +
      `}\n`,
      6000,
      false,
      ts(12),
    ),
  );

  // Turn 17 (assistant): Analyze and discuss middleware test failure
  const t17 = assistantToolUse(
    "I see the issue in the code. The `proper-lockfile` library writes the PID to the lock file, " +
    "but in a container environment, the PID namespace is different after restart.\n\n" +
    "Before I fix this, let me also check if there are existing tests — there was a mention in " +
    "the issue tracker of a failing middleware test related to upload size validation.",
    "bash",
    { command: "cd /opt/upload-svc && npm test -- --grep 'upload middleware' 2>&1 | tail -30" },
    undefined,
    600,
    ts(14),
  );
  turns.push(t17.turn);

  // Turn 18 (user): tool result — test output with middleware failure
  turns.push(
    userToolResult(
      t17.id,
      `> upload-svc@2.4.1 test\n> jest --grep 'upload middleware'\n\n` +
      `PASS src/__tests__/upload.test.ts\n` +
      `  Upload middleware\n` +
      `    ✓ accepts files under 50MB (45ms)\n` +
      `    ✓ rejects files over 50MB with 413 (12ms)\n` +
      `    ✓ handles multipart form data (67ms)\n` +
      `    ✗ validates temp directory is writable (23ms)\n\n` +
      `  ● Upload middleware > validates temp directory is writable\n\n` +
      `    Expected: 503\n` +
      `    Received: 500\n\n` +
      `    The middleware should return 503 Service Unavailable when the temp\n` +
      `    directory is not writable (disk full), but it's returning a generic\n` +
      `    500 Internal Server Error. The root cause is that the ENOSPC error\n` +
      `    from multer is not being caught by the error handler in\n` +
      `    src/middleware/upload-handler.ts:47 — the catch block only handles\n` +
      `    MulterError instances, not system-level errors.\n\n` +
      `Tests: 1 failed, 3 passed, 4 total`,
      5000,
      false,
      ts(14),
    ),
  );

  // Turn 19 (assistant): Read the middleware
  const t19 = assistantToolUse(
    "The failing test reveals another issue: the upload middleware doesn't properly handle ENOSPC errors. " +
    "The root cause of the test failure is that `src/middleware/upload-handler.ts:47` only catches " +
    "`MulterError` instances but not system-level errors like ENOSPC. We need to fix both the " +
    "cleanup locking AND this error handling.",
    "read",
    { path: "/opt/upload-svc/src/middleware/upload-handler.ts" },
    undefined,
    700,
    ts(16),
  );
  turns.push(t19.turn);

  // Turn 20 (user): tool result — upload handler source
  turns.push(
    userToolResult(
      t19.id,
      `import multer, { MulterError } from 'multer';\n` +
      `import { Request, Response, NextFunction } from 'express';\n` +
      `import { logger } from '../logger';\n\n` +
      `const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB\n\n` +
      `const storage = multer.diskStorage({\n` +
      `  destination: '/data/uploads/tmp/',\n` +
      `  filename: (req, file, cb) => {\n` +
      `    const chunkId = req.headers['x-chunk-id'] || crypto.randomUUID();\n` +
      `    cb(null, \`chunk_\${chunkId}_\${Date.now()}.part\`);\n` +
      `  },\n` +
      `});\n\n` +
      `const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });\n\n` +
      `export function uploadHandler() {\n` +
      `  return (req: Request, res: Response, next: NextFunction) => {\n` +
      `    upload.single('file')(req, res, (err) => {\n` +
      `      if (err) {\n` +
      `        if (err instanceof MulterError) {\n` +
      `          if (err.code === 'LIMIT_FILE_SIZE') {\n` +
      `            return res.status(413).json({ error: 'File too large', maxSize: '50MB' });\n` +
      `          }\n` +
      `          return res.status(400).json({ error: err.message });\n` +
      `        }\n` +
      `        // BUG: System errors like ENOSPC fall through to generic 500\n` +
      `        logger.error('Upload error:', err);\n` +
      `        return res.status(500).json({ error: 'Internal server error' });\n` +
      `      }\n` +
      `      next();\n` +
      `    });\n` +
      `  };\n` +
      `}\n`,
      5000,
      false,
      ts(16),
    ),
  );

  // Turn 21 (assistant): Now fix the error handling
  turns.push(
    assistantText(
      "I can see the bug clearly now. Line 47 in `upload-handler.ts` is the generic error handler " +
      "that catches everything that isn't a `MulterError`. System-level errors like ENOSPC need " +
      "to return 503 (Service Unavailable), not 500.\n\n" +
      "Let me also check if there's a database migration that was recently applied, since I noticed " +
      "the version bumped from 2.3.x to 2.4.1.",
      800,
      ts(17),
    ),
  );

  // -----------------------------------------------------------------------
  // Phase 3: Implementation (turns 22-33, ~60K tokens)
  // -----------------------------------------------------------------------

  // Turn 22 (user): check migration
  turns.push(
    userText(
      "Yes, there was a migration in 2.4.0 that added an `upload_sessions` table. It was reverted " +
      "in 2.4.1 because it caused a deadlock when concurrent uploads tried to insert session " +
      "records. The rollback migration is `20250510_revert_upload_sessions.sql`. Can you check " +
      "that the revert was applied correctly?",
      400,
      ts(18),
    ),
  );

  // Turn 23 (assistant): check migration
  const t23 = assistantToolUse(
    "Let me verify the migration status.",
    "bash",
    { command: "cat /opt/upload-svc/migrations/20250510_revert_upload_sessions.sql && echo '===' && psql -h localhost -U upload_svc -d uploads -c '\\dt upload_sessions' 2>&1" },
    undefined,
    500,
    ts(19),
  );
  turns.push(t23.turn);

  // Turn 24 (user): migration result
  turns.push(
    userToolResult(
      t23.id,
      `-- 20250510_revert_upload_sessions.sql\n` +
      `-- Revert: Drop upload_sessions table added in 2.4.0\n` +
      `-- Reason: Deadlock on concurrent inserts (see incident INC-2847)\n` +
      `DROP TABLE IF EXISTS upload_sessions;\n` +
      `DROP INDEX IF EXISTS idx_upload_sessions_user_id;\n` +
      `DROP INDEX IF EXISTS idx_upload_sessions_created_at;\n` +
      `===\n` +
      `Did not find any relation named "upload_sessions".`,
      3000,
      false,
      ts(19),
    ),
  );

  // Turn 25 (assistant): Good, migration reverted. Now fix the cleanup code
  const t25 = assistantToolUse(
    "The migration revert is confirmed — the `upload_sessions` table was properly dropped. " +
    "Now let me implement the two fixes:\n" +
    "1. Replace `proper-lockfile` with `flock` (advisory locking)\n" +
    "2. Fix the ENOSPC error handling in the upload middleware\n\n" +
    "Starting with the cleanup code fix:",
    "write",
    {
      path: "/opt/upload-svc/src/cleanup.ts",
      content:
        `import { open } from 'fs/promises';\n` +
        `import { readdir, stat, unlink } from 'fs/promises';\n` +
        `import { join } from 'path';\n` +
        `import { logger } from './logger';\n` +
        `import { flock } from './flock';\n\n` +
        `interface CleanupConfig {\n` +
        `  maxAgeHours: number;\n` +
        `  targetDir: string;\n` +
        `  batchSize: number;\n` +
        `  dryRun: boolean;\n` +
        `  skipPattern?: string;\n` +
        `}\n\n` +
        `export async function runCleanup(config: CleanupConfig): Promise<void> {\n` +
        `  const lockPath = '/var/run/upload-svc/cleanup.lock';\n` +
        `  const lockFd = await open(lockPath, 'w');\n\n` +
        `  try {\n` +
        `    // Advisory lock — automatically released on process exit or fd close\n` +
        `    const acquired = await flock(lockFd.fd, 'LOCK_EX | LOCK_NB');\n` +
        `    if (!acquired) {\n` +
        `      logger.error('Another cleanup process is running. Aborting.');\n` +
        `      await lockFd.close();\n` +
        `      return;\n` +
        `    }\n\n` +
        `    const cutoff = Date.now() - config.maxAgeHours * 3600_000;\n` +
        `    // ... rest of cleanup logic\n` +
        `  } finally {\n` +
        `    await lockFd.close(); // releases the advisory lock\n` +
        `    logger.info('Lock released');\n` +
        `  }\n` +
        `}\n`,
    },
    undefined,
    1500,
    ts(20),
  );
  turns.push(t25.turn);

  // Turn 26 (user): file written
  turns.push(
    userToolResult(t25.id, "File written: /opt/upload-svc/src/cleanup.ts", 200, false, ts(20)),
  );

  // Turn 27 (assistant): Now fix upload handler, mention config env var
  const t27 = assistantToolUse(
    "Now let me fix the upload handler to properly handle ENOSPC. I also need to update the " +
    "`config/production.env` file to add the `DISK_USAGE_ALERT_THRESHOLD=80` environment variable " +
    "for the new monitoring alert.",
    "write",
    {
      path: "/opt/upload-svc/src/middleware/upload-handler.ts",
      content:
        `import multer, { MulterError } from 'multer';\n` +
        `import { Request, Response, NextFunction } from 'express';\n` +
        `import { logger } from '../logger';\n\n` +
        `const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB\n\n` +
        `const storage = multer.diskStorage({\n` +
        `  destination: '/data/uploads/tmp/',\n` +
        `  filename: (req, file, cb) => {\n` +
        `    const chunkId = req.headers['x-chunk-id'] || crypto.randomUUID();\n` +
        `    cb(null, \`chunk_\${chunkId}_\${Date.now()}.part\`);\n` +
        `  },\n` +
        `});\n\n` +
        `const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });\n\n` +
        `function isSystemResourceError(err: NodeJS.ErrnoException): boolean {\n` +
        `  return err.code === 'ENOSPC' || err.code === 'EMFILE' || err.code === 'ENFILE';\n` +
        `}\n\n` +
        `export function uploadHandler() {\n` +
        `  return (req: Request, res: Response, next: NextFunction) => {\n` +
        `    upload.single('file')(req, res, (err) => {\n` +
        `      if (err) {\n` +
        `        if (err instanceof MulterError) {\n` +
        `          if (err.code === 'LIMIT_FILE_SIZE') {\n` +
        `            return res.status(413).json({ error: 'File too large', maxSize: '50MB' });\n` +
        `          }\n` +
        `          return res.status(400).json({ error: err.message });\n` +
        `        }\n` +
        `        // System-level errors → 503 Service Unavailable\n` +
        `        if (isSystemResourceError(err as NodeJS.ErrnoException)) {\n` +
        `          logger.error('System resource error during upload:', err);\n` +
        `          return res.status(503).json({\n` +
        `            error: 'Service temporarily unavailable',\n` +
        `            detail: 'Upload storage is full or unavailable',\n` +
        `          });\n` +
        `        }\n` +
        `        logger.error('Upload error:', err);\n` +
        `        return res.status(500).json({ error: 'Internal server error' });\n` +
        `      }\n` +
        `      next();\n` +
        `    });\n` +
        `  };\n` +
        `}\n`,
    },
    undefined,
    1800,
    ts(22),
  );
  turns.push(t27.turn);

  // Turn 28 (user): written
  turns.push(
    userToolResult(t27.id, "File written: /opt/upload-svc/src/middleware/upload-handler.ts", 200, false, ts(22)),
  );

  // Turn 29 (assistant): update env config
  const t29 = assistantToolUse(
    "Good. Now let me add the disk usage monitoring alert threshold to the production config.",
    "write",
    {
      path: "/opt/upload-svc/config/production.env",
      content:
        `# Production environment configuration\n` +
        `NODE_ENV=production\n` +
        `PORT=3000\n` +
        `UPLOAD_DIR=/data/uploads\n` +
        `TEMP_DIR=/data/uploads/tmp\n` +
        `MAX_FILE_SIZE=52428800\n` +
        `DB_HOST=pg-primary.internal\n` +
        `DB_NAME=uploads\n` +
        `# Added 2025-05-14: Disk usage alert threshold\n` +
        `DISK_USAGE_ALERT_THRESHOLD=80\n` +
        `DISK_USAGE_CHECK_INTERVAL=300\n`,
    },
    undefined,
    600,
    ts(23),
  );
  turns.push(t29.turn);

  // Turn 30 (user): written
  turns.push(
    userToolResult(t29.id, "File written: /opt/upload-svc/config/production.env", 200, false, ts(23)),
  );

  // Turn 31 (assistant): run tests
  const t31 = assistantToolUse(
    "Let me run the tests now to verify both fixes.",
    "bash",
    { command: "cd /opt/upload-svc && npm test 2>&1" },
    undefined,
    500,
    ts(24),
  );
  turns.push(t31.turn);

  // Turn 32 (user): test results
  turns.push(
    userToolResult(
      t31.id,
      `> upload-svc@2.4.1 test\n> jest\n\n` +
      `PASS src/__tests__/cleanup.test.ts\n` +
      `  Cleanup\n` +
      `    ✓ acquires advisory lock before cleanup (15ms)\n` +
      `    ✓ skips if lock is held by another process (8ms)\n` +
      `    ✓ releases lock on process exit (12ms)\n` +
      `    ✓ deletes files older than maxAge (45ms)\n` +
      `    ✓ respects batch size (23ms)\n` +
      `    ✓ skips files matching skipPattern (11ms)\n\n` +
      `PASS src/__tests__/upload.test.ts\n` +
      `  Upload middleware\n` +
      `    ✓ accepts files under 50MB (42ms)\n` +
      `    ✓ rejects files over 50MB with 413 (11ms)\n` +
      `    ✓ handles multipart form data (63ms)\n` +
      `    ✓ validates temp directory is writable (19ms)\n` +
      `    ✓ returns 503 on ENOSPC (14ms)\n` +
      `    ✓ returns 503 on EMFILE (12ms)\n\n` +
      `PASS src/__tests__/integration.test.ts\n` +
      `  Integration\n` +
      `    ✓ full upload → process → store flow (234ms)\n` +
      `    ✓ concurrent uploads don't deadlock (189ms)\n` +
      `    ✗ handles upload cancellation gracefully (67ms)\n\n` +
      `  ● Integration > handles upload cancellation gracefully\n\n` +
      `    Timeout — Async callback was not invoked within 5000ms.\n` +
      `    The AbortController signal is not being forwarded to the\n` +
      `    storage cleanup routine in src/routes/upload.ts:89.\n\n` +
      `Tests: 1 failed, 14 passed, 15 total\n` +
      `Time: 3.42s`,
      6000,
      false,
      ts(25),
    ),
  );

  // Turn 33 (assistant): middleware test passes, new failure in integration
  turns.push(
    assistantText(
      "The middleware test now passes (returns 503 on ENOSPC as expected). However, there's a " +
      "new integration test failure: `handles upload cancellation gracefully` is timing out. " +
      "The issue is that the `AbortController` signal isn't being forwarded to the storage cleanup " +
      "routine in `src/routes/upload.ts:89`.\n\n" +
      "This is a pre-existing issue unrelated to our fix, but let me fix it while we're here.",
      700,
      ts(26),
    ),
  );

  // -----------------------------------------------------------------------
  // Phase 4: Testing & PR (turns 34-39, ~20K tokens)
  // -----------------------------------------------------------------------

  // Turn 34 (user): yes, fix it and also let's check the linting
  turns.push(
    userText(
      "Go ahead, fix the abort issue too. Then run the linter before we commit.",
      200,
      ts(28),
    ),
  );

  // Turn 35 (assistant): fix abort
  const t35 = assistantToolUse(
    "Let me fix the abort signal forwarding.",
    "read",
    { path: "/opt/upload-svc/src/routes/upload.ts" },
    undefined,
    400,
    ts(29),
  );
  turns.push(t35.turn);

  // Turn 36 (user): upload route source
  turns.push(
    userToolResult(
      t35.id,
      `import { Router } from 'express';\n` +
      `import { uploadHandler } from '../middleware/upload-handler';\n` +
      `import { processUpload, cleanupTempFile } from '../services/upload-service';\n` +
      `import { logger } from '../logger';\n\n` +
      `const router = Router();\n\n` +
      `router.post('/upload', uploadHandler(), async (req, res) => {\n` +
      `  const tempPath = req.file?.path;\n` +
      `  if (!tempPath) return res.status(400).json({ error: 'No file provided' });\n\n` +
      `  try {\n` +
      `    const result = await processUpload(tempPath, {\n` +
      `      userId: req.user?.id,\n` +
      `      originalName: req.file!.originalname,\n` +
      `      mimeType: req.file!.mimetype,\n` +
      `    });\n` +
      `    res.json({ id: result.id, url: result.publicUrl });\n` +
      `  } catch (err) {\n` +
      `    logger.error('Upload processing failed:', err);\n` +
      `    res.status(500).json({ error: 'Upload processing failed' });\n` +
      `  } finally {\n` +
      `    // BUG: No abort signal check — cleanup runs even if request was cancelled\n` +
      `    // and processUpload may still be running\n` +
      `    await cleanupTempFile(tempPath);\n` +
      `  }\n` +
      `});\n\n` +
      `export default router;\n`,
      5000,
      false,
      ts(29),
    ),
  );

  // Turn 37 (assistant): fix and lint
  const t37 = assistantToolUse(
    "I see the issue. The `finally` block doesn't check if the request was aborted. " +
    "Also, `processUpload` doesn't receive an `AbortSignal`. Let me fix both and run the linter.",
    "bash",
    { command: "cd /opt/upload-svc && npx eslint src/ --fix 2>&1 | tail -15" },
    undefined,
    600,
    ts(30),
  );
  turns.push(t37.turn);

  // Turn 38 (user): lint output
  turns.push(
    userToolResult(
      t37.id,
      `/opt/upload-svc/src/middleware/upload-handler.ts\n` +
      `  32:9  warning  Unexpected any. Specify a more specific type  @typescript-eslint/no-explicit-any\n\n` +
      `/opt/upload-svc/src/cleanup.ts\n` +
      `  1:10  error  'open' is defined but never used  @typescript-eslint/no-unused-vars\n\n` +
      `✖ 2 problems (1 error, 1 warning)\n` +
      `  1 error and 0 warnings potentially fixable with the \`--fix\` flag.\n\n` +
      `Fixed: removed unused 'open' import from cleanup.ts`,
      3000,
      false,
      ts(30),
    ),
  );

  // Turn 39 (assistant): create test file
  const t39 = assistantToolUse(
    "The linting error was the unused `open` import in cleanup.ts — already auto-fixed. " +
    "Now let me create the new test file for the abort signal fix.",
    "write",
    {
      path: "/opt/upload-svc/src/__tests__/upload-abort.test.ts",
      content:
        `import request from 'supertest';\n` +
        `import { createApp } from '../app';\n\n` +
        `describe('Upload abort handling', () => {\n` +
        `  it('should cancel processing on client abort', async () => {\n` +
        `    const app = createApp();\n` +
        `    const ac = new AbortController();\n` +
        `    const req = request(app)\n` +
        `      .post('/upload')\n` +
        `      .attach('file', Buffer.from('test'), 'test.txt')\n` +
        `      .set('signal', ac.signal as any);\n\n` +
        `    // Abort mid-request\n` +
        `    setTimeout(() => ac.abort(), 50);\n` +
        `    const res = await req;\n` +
        `    expect(res.status).toBe(499); // Client closed\n` +
        `  });\n\n` +
        `  it('should clean up temp file on abort', async () => {\n` +
        `    // ... verify tempFile is removed even if processUpload was aborted\n` +
        `  });\n` +
        `});\n`,
    },
    undefined,
    800,
    ts(32),
  );
  turns.push(t39.turn);

  // Turn 40 (user): written
  turns.push(
    userToolResult(t39.id, "File written: /opt/upload-svc/src/__tests__/upload-abort.test.ts", 200, false, ts(32)),
  );

  // Turn 41 (assistant): run final tests
  const t41 = assistantToolUse(
    "Now let me run the full test suite to verify everything passes.",
    "bash",
    { command: "cd /opt/upload-svc && npm test 2>&1" },
    undefined,
    500,
    ts(33),
  );
  turns.push(t41.turn);

  // Turn 42 (user): all tests pass
  turns.push(
    userToolResult(
      t41.id,
      `> upload-svc@2.4.1 test\n> jest\n\n` +
      `PASS src/__tests__/cleanup.test.ts (6 tests)\n` +
      `PASS src/__tests__/upload.test.ts (6 tests)\n` +
      `PASS src/__tests__/integration.test.ts (3 tests)\n` +
      `PASS src/__tests__/upload-abort.test.ts (2 tests)\n\n` +
      `Tests: 17 passed, 17 total\n` +
      `Time: 4.17s`,
      3000,
      false,
      ts(34),
    ),
  );

  // Turn 43 (assistant): create PR
  const t43 = assistantToolUse(
    "All 17 tests pass. Let me create the commit and PR.",
    "bash",
    { command: "cd /opt/upload-svc && git add -A && git commit -m 'fix: resolve stale lock file blocking temp cleanup & handle ENOSPC properly' && git push origin fix/upload-cleanup-lock && gh pr create --title 'fix: resolve stale temp file accumulation and ENOSPC handling' --body 'Fixes UPLOAD-SVC-4821\n\n## Changes\n- Replace proper-lockfile with flock advisory locking\n- Handle ENOSPC/EMFILE → 503 in upload middleware\n- Fix abort signal forwarding in upload route\n- Add disk usage monitoring threshold (80%)\n\n## Root Cause\nStale lock file from Feb 28 prevented daily cleanup cron from running, accumulating 247K temp files (94GB).' --base main" },
    undefined,
    700,
    ts(35),
  );
  turns.push(t43.turn);

  // Turn 44 (user): PR created
  turns.push(
    userToolResult(
      t43.id,
      `[fix/upload-cleanup-lock e3a1f7b] fix: resolve stale lock file blocking temp cleanup & handle ENOSPC properly\n` +
      ` 5 files changed, 87 insertions(+), 23 deletions(-)\n` +
      ` create mode 100644 src/__tests__/upload-abort.test.ts\n\n` +
      `Creating pull request for fix/upload-cleanup-lock into main\n\n` +
      `https://github.com/acmecorp/upload-svc/pull/342`,
      2000,
      false,
      ts(36),
    ),
  );

  // Turn 45 (assistant): summary
  turns.push(
    assistantText(
      "Done! PR #342 is created on branch `fix/upload-cleanup-lock`.\n\n" +
      "**Summary of changes**:\n" +
      "1. **Cleanup locking** — Replaced `proper-lockfile` PID-based locking with `flock()` advisory " +
      "locking that auto-releases on process exit/crash\n" +
      "2. **ENOSPC handling** — Upload middleware now returns 503 instead of 500 for system resource errors\n" +
      "3. **Abort signal** — Upload route now forwards `AbortSignal` to processing and cleanup\n" +
      "4. **Monitoring** — Added `DISK_USAGE_ALERT_THRESHOLD=80` to production config\n\n" +
      "All 17 tests pass.",
      800,
      ts(37),
    ),
  );

  return {
    id: "cm-1-session",
    label: "Bug investigation: temp file accumulation (UPLOAD-SVC-4821)",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: turns.reduce((sum, t) => sum + (t.tokens ?? 0), 0),
      description:
        "~40-turn session investigating disk-full errors caused by stale cleanup lock. " +
        "Phases: investigation, root cause analysis, implementation, testing & PR.",
    },
  };
}

// ---------------------------------------------------------------------------
// CM-1 questions
// ---------------------------------------------------------------------------

function buildCM1Questions(): EvalQuestion[] {
  const base = {
    dimension: "context" as const,
    scenario: "cm-1-early-detail",
    sessionRef: "cm-1-session",
    rubric: RUBRICS.contextRetention,
    metadata: { tags: ["context-retention"] },
  };

  return [
    // Easy (late-session, turns 38-45)
    {
      ...base,
      id: "cm-1-e1",
      question: "What test file was created for the upload abort handling?",
      referenceAnswer:
        "src/__tests__/upload-abort.test.ts — tests that upload processing is cancelled " +
        "on client abort and that temp files are cleaned up even when processUpload is aborted.",
      metadata: { ...base.metadata, turnIndex: 39, cumulativeTokens: 60000, difficulty: "easy" },
    },
    {
      ...base,
      id: "cm-1-e2",
      question: "What was the final PR title?",
      referenceAnswer:
        "fix: resolve stale temp file accumulation and ENOSPC handling",
      metadata: { ...base.metadata, turnIndex: 43, cumulativeTokens: 65000, difficulty: "easy" },
    },
    {
      ...base,
      id: "cm-1-e3",
      question: "How many tests passed in the last full test run?",
      referenceAnswer:
        "17 tests passed (6 in cleanup.test.ts, 6 in upload.test.ts, 3 in integration.test.ts, " +
        "2 in upload-abort.test.ts). Total time: 4.17s.",
      metadata: { ...base.metadata, turnIndex: 42, cumulativeTokens: 63000, difficulty: "easy" },
    },
    {
      ...base,
      id: "cm-1-e4",
      question: "What branch name was used for the PR?",
      referenceAnswer: "fix/upload-cleanup-lock",
      metadata: { ...base.metadata, turnIndex: 43, cumulativeTokens: 65000, difficulty: "easy" },
    },
    {
      ...base,
      id: "cm-1-e5",
      question: "What linting error was auto-fixed in the last commit?",
      referenceAnswer:
        "An unused 'open' import in cleanup.ts (src/cleanup.ts line 1:10, " +
        "@typescript-eslint/no-unused-vars error). It was auto-fixed by eslint --fix.",
      metadata: { ...base.metadata, turnIndex: 37, cumulativeTokens: 58000, difficulty: "easy" },
    },

    // Medium (mid-session, turns 17-28)
    {
      ...base,
      id: "cm-1-m1",
      question: "What was the root cause of the failing test in the upload middleware?",
      referenceAnswer:
        "The catch block in src/middleware/upload-handler.ts:47 only handled MulterError " +
        "instances. System-level errors like ENOSPC fell through to the generic 500 handler " +
        "instead of returning 503 Service Unavailable.",
      metadata: { ...base.metadata, turnIndex: 18, cumulativeTokens: 35000, difficulty: "medium" },
    },
    {
      ...base,
      id: "cm-1-m2",
      question: "Which database migration was reverted and why?",
      referenceAnswer:
        "The migration in version 2.4.0 that added an 'upload_sessions' table was reverted " +
        "in 2.4.1 via '20250510_revert_upload_sessions.sql' because it caused a deadlock " +
        "when concurrent uploads tried to insert session records (incident INC-2847).",
      metadata: { ...base.metadata, turnIndex: 22, cumulativeTokens: 40000, difficulty: "medium" },
    },
    {
      ...base,
      id: "cm-1-m3",
      question:
        "What alternative approach was considered before choosing flock advisory locking for the cleanup fix?",
      referenceAnswer:
        "Two approaches were considered: (1) advisory locking with flock() where the OS " +
        "automatically releases the lock on process exit, and (2) lock file with staleness " +
        "check where the lock age is checked and removed if stale. Approach 1 (flock) was " +
        "chosen because it's more robust — the OS guarantees release even on SIGKILL, " +
        "whereas approach 2 has a race condition window.",
      metadata: { ...base.metadata, turnIndex: 15, cumulativeTokens: 30000, difficulty: "medium" },
    },
    {
      ...base,
      id: "cm-1-m4",
      question: "What exact error message appeared when the integration test failed?",
      referenceAnswer:
        "Timeout — Async callback was not invoked within 5000ms. The AbortController signal " +
        "is not being forwarded to the storage cleanup routine in src/routes/upload.ts:89.",
      metadata: { ...base.metadata, turnIndex: 32, cumulativeTokens: 50000, difficulty: "medium" },
    },
    {
      ...base,
      id: "cm-1-m5",
      question: "Which config file needed the disk usage environment variable change?",
      referenceAnswer:
        "config/production.env — DISK_USAGE_ALERT_THRESHOLD=80 and DISK_USAGE_CHECK_INTERVAL=300 " +
        "were added to /opt/upload-svc/config/production.env.",
      metadata: { ...base.metadata, turnIndex: 29, cumulativeTokens: 45000, difficulty: "medium" },
    },

    // Hard (early-session, turns 0-10)
    {
      ...base,
      id: "cm-1-h1",
      question: "What was the exact Sentry issue ID that triggered this investigation?",
      referenceAnswer: "UPLOAD-SVC-4821",
      metadata: { ...base.metadata, turnIndex: 0, cumulativeTokens: 500, difficulty: "hard" },
    },
    {
      ...base,
      id: "cm-1-h2",
      question:
        "What stack trace line or error pointed to the root cause of the stale lock?",
      referenceAnswer:
        "The cleanup log showed 'Failed to acquire lock: /var/run/upload-svc/cleanup.lock — " +
        "Resource temporarily unavailable' repeating daily from March 1 through May 14. " +
        "The lock file contained PID 28451 from the Feb 28 03:00 run.",
      metadata: { ...base.metadata, turnIndex: 8, cumulativeTokens: 12000, difficulty: "hard" },
    },
    {
      ...base,
      id: "cm-1-h3",
      question: "Which user reported the bug and what was their exact error message?",
      referenceAnswer:
        'Sarah Chen (sarah.chen@acmecorp.com) reported: "I can\'t upload any files since ' +
        "this morning. Getting a 500 error every time. I'm trying to upload a 2MB CSV for " +
        'the Q2 analytics report."',
      metadata: { ...base.metadata, turnIndex: 0, cumulativeTokens: 500, difficulty: "hard" },
    },
    {
      ...base,
      id: "cm-1-h4",
      question: "What was the first hypothesis about the bug's cause, and why was it wrong?",
      referenceAnswer:
        "The initial hypothesis was that the cron job was misconfigured or disabled. This was " +
        "wrong because the cron was actually running fine every day at 3 AM — the real issue was " +
        "a stale lock file at /var/run/upload-svc/cleanup.lock (PID 28451 from Feb 28) that " +
        "prevented the cleanup from executing. The proper-lockfile library's PID-based stale " +
        "detection didn't work in the containerized environment.",
      metadata: { ...base.metadata, turnIndex: 9, cumulativeTokens: 15000, difficulty: "hard" },
    },
    {
      ...base,
      id: "cm-1-h5",
      question: "What version of the proper-lockfile dependency was pinned in the lockfile?",
      referenceAnswer:
        "proper-lockfile version 4.1.2 (shown in package.json dependencies alongside " +
        "express 4.18.2, multer 1.4.5-lts.1, aws-sdk 2.1540.0, and winston 3.11.0).",
      metadata: { ...base.metadata, turnIndex: 10, cumulativeTokens: 18000, difficulty: "hard" },
    },
  ];
}

// =========================================================================
// CM-2: Tool Output Deduplication
// =========================================================================

function buildCM2Transcript(): SessionTranscript {
  const turns: ConversationTurn[] = [];

  // Turn 0 (user): Start working on failing tests
  turns.push(
    userText(
      "I'm working on fixing the test suite for our payment service. There are several failing " +
      "tests. Let me run the full suite first to see the current state.",
      300,
      ts(0),
    ),
  );

  // --- Test run 1 ---
  const tr1 = assistantToolUse(
    "Let me run the full pytest suite to see the current state.",
    "bash",
    { command: "cd /opt/payment-svc && python -m pytest tests/ -v 2>&1" },
    undefined,
    400,
    ts(1),
  );
  turns.push(tr1.turn);

  turns.push(
    userToolResult(
      tr1.id,
      `============================= test session starts ==============================\n` +
      `platform linux -- Python 3.11.8, pytest-8.1.1\n` +
      `collected 24 items\n\n` +
      `tests/test_auth.py::test_login_success PASSED\n` +
      `tests/test_auth.py::test_login_invalid_password PASSED\n` +
      `tests/test_auth.py::test_token_refresh PASSED\n` +
      `tests/test_auth.py::test_token_expiry FAILED\n` +
      `tests/test_payments.py::test_create_payment PASSED\n` +
      `tests/test_payments.py::test_payment_validation PASSED\n` +
      `tests/test_payments.py::test_duplicate_payment FAILED\n` +
      `tests/test_payments.py::test_refund PASSED\n` +
      `tests/test_payments.py::test_partial_refund FAILED\n` +
      `tests/test_users.py::test_create_user PASSED\n` +
      `tests/test_users.py::test_update_profile PASSED\n` +
      `tests/test_users.py::test_delete_user PASSED\n` +
      `tests/test_users.py::test_user_preferences FAILED\n` +
      `tests/test_webhooks.py::test_webhook_delivery PASSED\n` +
      `tests/test_webhooks.py::test_webhook_retry PASSED\n` +
      `tests/test_webhooks.py::test_webhook_signature PASSED\n` +
      `tests/test_webhooks.py::test_webhook_timeout FAILED\n` +
      `tests/test_integration.py::test_full_payment_flow PASSED\n` +
      `tests/test_integration.py::test_concurrent_payments PASSED\n` +
      `tests/test_integration.py::test_payment_with_webhook FAILED\n` +
      `tests/test_integration.py::test_idempotency PASSED\n` +
      `tests/test_integration.py::test_rate_limiting PASSED\n` +
      `tests/test_integration.py::test_error_recovery PASSED\n` +
      `tests/test_integration.py::test_audit_trail PASSED\n\n` +
      `================================= FAILURES ==================================\n` +
      `___________________________ test_token_expiry ________________________________\n` +
      `    AssertionError: Token should expire after 3600s, but expiry was 7200s\n` +
      `    File "tests/test_auth.py", line 45\n` +
      `___________________________ test_duplicate_payment ___________________________\n` +
      `    AssertionError: Expected 409 Conflict, got 201 Created\n` +
      `    Duplicate payment with same idempotency key was accepted\n` +
      `    File "tests/test_payments.py", line 78\n` +
      `___________________________ test_partial_refund ______________________________\n` +
      `    AssertionError: Refund amount $45.00 exceeds remaining $30.00\n` +
      `    File "tests/test_payments.py", line 112\n` +
      `___________________________ test_user_preferences ____________________________\n` +
      `    AssertionError: Expected currency 'EUR', got 'USD'\n` +
      `    File "tests/test_users.py", line 67\n` +
      `___________________________ test_webhook_timeout _____________________________\n` +
      `    TimeoutError: Webhook delivery timed out after 30s\n` +
      `    Expected timeout to be 10s (configured value)\n` +
      `    File "tests/test_webhooks.py", line 89\n` +
      `___________________________ test_payment_with_webhook ________________________\n` +
      `    AssertionError: Webhook not received within 5s after payment\n` +
      `    File "tests/test_integration.py", line 134\n\n` +
      `======================== 6 failed, 18 passed, 24 total ======================`,
      8000,
      false,
      ts(2),
    ),
  );

  // Turn 2 (assistant): analyze failures, read config
  const t2 = assistantToolUse(
    "6 failures across 4 test files. Let me start by reading the config file since " +
    "several failures seem related to configuration values (token expiry, timeout, currency defaults).",
    "read",
    { path: "/opt/payment-svc/config/test.yaml" },
    undefined,
    500,
    ts(3),
  );
  turns.push(t2.turn);

  // Config file read (will be read again later — same content)
  const configContent =
    `# test.yaml — Payment service test configuration\n` +
    `auth:\n` +
    `  token_expiry_seconds: 3600\n` +
    `  refresh_window_seconds: 300\n` +
    `  secret_key: "test-secret-key-do-not-use-in-prod"\n\n` +
    `payments:\n` +
    `  currency: USD\n` +
    `  max_amount: 10000.00\n` +
    `  idempotency_window_seconds: 86400\n` +
    `  stripe_api_key: "sk_test_fake_key_12345"\n\n` +
    `webhooks:\n` +
    `  timeout_seconds: 10\n` +
    `  max_retries: 3\n` +
    `  retry_delay_seconds: 5\n` +
    `  signing_secret: "whsec_test_secret"\n\n` +
    `users:\n` +
    `  default_currency: EUR\n` +
    `  default_locale: en-US\n\n` +
    `database:\n` +
    `  url: "postgresql://test:test@localhost:5432/payment_test"\n` +
    `  pool_size: 5\n`;

  turns.push(
    userToolResult(t2.id, configContent, 4000, false, ts(3)),
  );

  // Turn 3 (assistant): fix token expiry
  const t3fix = assistantToolUse(
    "I see — the config says `token_expiry_seconds: 3600` but the test is getting 7200s. " +
    "The code must be overriding it. Let me check the auth module.",
    "read",
    { path: "/opt/payment-svc/src/auth.py" },
    undefined,
    500,
    ts(4),
  );
  turns.push(t3fix.turn);

  turns.push(
    userToolResult(
      t3fix.id,
      `from config import get_config\n\n` +
      `# BUG: hardcoded 7200 instead of reading from config\n` +
      `TOKEN_EXPIRY = 7200  # should be get_config('auth.token_expiry_seconds')\n\n` +
      `def create_token(user_id: str) -> dict:\n` +
      `    expiry = TOKEN_EXPIRY\n` +
      `    # ... token creation logic\n` +
      `    return {"token": token, "expires_in": expiry}\n`,
      3000,
      false,
      ts(4),
    ),
  );

  // Turn 4 (assistant): fix it
  const t4fix = assistantToolUse(
    "Found it — hardcoded 7200 instead of reading from config. Let me fix that.",
    "write",
    {
      path: "/opt/payment-svc/src/auth.py",
      content:
        `from config import get_config\n\n` +
        `def create_token(user_id: str) -> dict:\n` +
        `    expiry = get_config('auth.token_expiry_seconds', default=3600)\n` +
        `    # ... token creation logic\n` +
        `    return {"token": token, "expires_in": expiry}\n`,
    },
    undefined,
    600,
    ts(5),
  );
  turns.push(t4fix.turn);

  turns.push(
    userToolResult(t4fix.id, "File written: /opt/payment-svc/src/auth.py", 200, false, ts(5)),
  );

  // --- Test run 2 ---
  const tr2 = assistantToolUse(
    "Let me run the tests again to see if the token expiry fix resolved that failure.",
    "bash",
    { command: "cd /opt/payment-svc && python -m pytest tests/ -v 2>&1" },
    undefined,
    400,
    ts(6),
  );
  turns.push(tr2.turn);

  turns.push(
    userToolResult(
      tr2.id,
      `============================= test session starts ==============================\n` +
      `platform linux -- Python 3.11.8, pytest-8.1.1\n` +
      `collected 24 items\n\n` +
      `tests/test_auth.py::test_login_success PASSED\n` +
      `tests/test_auth.py::test_login_invalid_password PASSED\n` +
      `tests/test_auth.py::test_token_refresh PASSED\n` +
      `tests/test_auth.py::test_token_expiry PASSED\n` +
      `tests/test_payments.py::test_create_payment PASSED\n` +
      `tests/test_payments.py::test_payment_validation PASSED\n` +
      `tests/test_payments.py::test_duplicate_payment FAILED\n` +
      `tests/test_payments.py::test_refund PASSED\n` +
      `tests/test_payments.py::test_partial_refund FAILED\n` +
      `tests/test_users.py::test_create_user PASSED\n` +
      `tests/test_users.py::test_update_profile PASSED\n` +
      `tests/test_users.py::test_delete_user PASSED\n` +
      `tests/test_users.py::test_user_preferences FAILED\n` +
      `tests/test_webhooks.py::test_webhook_delivery PASSED\n` +
      `tests/test_webhooks.py::test_webhook_retry PASSED\n` +
      `tests/test_webhooks.py::test_webhook_signature PASSED\n` +
      `tests/test_webhooks.py::test_webhook_timeout FAILED\n` +
      `tests/test_integration.py::test_full_payment_flow PASSED\n` +
      `tests/test_integration.py::test_concurrent_payments PASSED\n` +
      `tests/test_integration.py::test_payment_with_webhook FAILED\n` +
      `tests/test_integration.py::test_idempotency PASSED\n` +
      `tests/test_integration.py::test_rate_limiting PASSED\n` +
      `tests/test_integration.py::test_error_recovery PASSED\n` +
      `tests/test_integration.py::test_audit_trail PASSED\n\n` +
      `================================= FAILURES ==================================\n` +
      `___________________________ test_duplicate_payment ___________________________\n` +
      `    AssertionError: Expected 409 Conflict, got 201 Created\n` +
      `    Duplicate payment with same idempotency key was accepted\n` +
      `    File "tests/test_payments.py", line 78\n` +
      `___________________________ test_partial_refund ______________________________\n` +
      `    AssertionError: Refund amount $45.00 exceeds remaining $30.00\n` +
      `    File "tests/test_payments.py", line 112\n` +
      `___________________________ test_user_preferences ____________________________\n` +
      `    AssertionError: Expected currency 'EUR', got 'USD'\n` +
      `    File "tests/test_users.py", line 67\n` +
      `___________________________ test_webhook_timeout _____________________________\n` +
      `    TimeoutError: Webhook delivery timed out after 30s\n` +
      `    Expected timeout to be 10s (configured value)\n` +
      `    File "tests/test_webhooks.py", line 89\n` +
      `___________________________ test_payment_with_webhook ________________________\n` +
      `    AssertionError: Webhook not received within 5s after payment\n` +
      `    File "tests/test_integration.py", line 134\n\n` +
      `======================== 5 failed, 19 passed, 24 total ======================`,
      8000,
      false,
      ts(7),
    ),
  );

  // Turn 6 (assistant): one down, fix duplicate payment
  const t6fix = assistantToolUse(
    "Token expiry test is now passing (19 passed, 5 failed — down from 6). " +
    "Let me fix the duplicate payment and partial refund issues next. " +
    "First, let me read the payments module.",
    "read",
    { path: "/opt/payment-svc/src/payments.py" },
    undefined,
    500,
    ts(8),
  );
  turns.push(t6fix.turn);

  turns.push(
    userToolResult(
      t6fix.id,
      `from db import get_db\nfrom config import get_config\n\n` +
      `class PaymentService:\n` +
      `    def create_payment(self, amount, currency, idempotency_key=None):\n` +
      `        # BUG: idempotency check uses wrong column\n` +
      `        if idempotency_key:\n` +
      `            existing = get_db().query(\n` +
      `                "SELECT * FROM payments WHERE reference_id = ?", idempotency_key\n` +
      `            )\n` +
      `            # Should query idempotency_key column, not reference_id\n` +
      `            if existing:\n` +
      `                return existing, 200\n` +
      `        payment = self._process_payment(amount, currency)\n` +
      `        return payment, 201\n\n` +
      `    def refund(self, payment_id, amount):\n` +
      `        payment = get_db().query("SELECT * FROM payments WHERE id = ?", payment_id)\n` +
      `        # BUG: doesn't subtract previous refunds from available amount\n` +
      `        if amount > payment['amount']:\n` +
      `            raise ValueError("Refund exceeds payment amount")\n` +
      `        # Should check: amount > payment['amount'] - payment['total_refunded']\n` +
      `        return self._process_refund(payment_id, amount)\n`,
      5000,
      false,
      ts(8),
    ),
  );

  // Turn 7 (assistant): fix both payment bugs
  const t7fix = assistantToolUse(
    "Two bugs:\n1. Idempotency check queries `reference_id` instead of `idempotency_key` column\n" +
    "2. Refund doesn't subtract previous refunds from available amount\n\nFixing both:",
    "write",
    {
      path: "/opt/payment-svc/src/payments.py",
      content:
        `from db import get_db\nfrom config import get_config\n\n` +
        `class PaymentService:\n` +
        `    def create_payment(self, amount, currency, idempotency_key=None):\n` +
        `        if idempotency_key:\n` +
        `            existing = get_db().query(\n` +
        `                "SELECT * FROM payments WHERE idempotency_key = ?", idempotency_key\n` +
        `            )\n` +
        `            if existing:\n` +
        `                return existing, 409  # Conflict\n` +
        `        payment = self._process_payment(amount, currency)\n` +
        `        return payment, 201\n\n` +
        `    def refund(self, payment_id, amount):\n` +
        `        payment = get_db().query("SELECT * FROM payments WHERE id = ?", payment_id)\n` +
        `        available = payment['amount'] - payment.get('total_refunded', 0)\n` +
        `        if amount > available:\n` +
        `            raise ValueError(f"Refund amount {amount} exceeds remaining {available}")\n` +
        `        return self._process_refund(payment_id, amount)\n`,
    },
    undefined,
    800,
    ts(9),
  );
  turns.push(t7fix.turn);

  turns.push(
    userToolResult(t7fix.id, "File written: /opt/payment-svc/src/payments.py", 200, false, ts(9)),
  );

  // Turn 8 (user): also fix user prefs
  turns.push(
    userText(
      "Good. The user preferences failure is because the default currency in the User model " +
      "is hardcoded to USD instead of reading from config. Can you check?",
      300,
      ts(10),
    ),
  );

  // Turn 9 (assistant): read config again
  const t9read = assistantToolUse(
    "Let me re-read the config to confirm the expected default currency.",
    "read",
    { path: "/opt/payment-svc/config/test.yaml" },
    undefined,
    400,
    ts(11),
  );
  turns.push(t9read.turn);

  // Same config content — this is the deliberate duplication
  turns.push(
    userToolResult(t9read.id, configContent, 4000, false, ts(11)),
  );

  // Turn 10 (assistant): fix user model
  const t10fix = assistantToolUse(
    "Config confirms `users.default_currency: EUR`. Let me fix the User model.",
    "write",
    {
      path: "/opt/payment-svc/src/users.py",
      content:
        `from config import get_config\n\n` +
        `class User:\n` +
        `    def __init__(self, **kwargs):\n` +
        `        self.currency = kwargs.get(\n` +
        `            'currency',\n` +
        `            get_config('users.default_currency', default='USD')\n` +
        `        )\n`,
    },
    undefined,
    600,
    ts(12),
  );
  turns.push(t10fix.turn);

  turns.push(
    userToolResult(t10fix.id, "File written: /opt/payment-svc/src/users.py", 200, false, ts(12)),
  );

  // --- Test run 3 ---
  const tr3 = assistantToolUse(
    "Let me run the tests again.",
    "bash",
    { command: "cd /opt/payment-svc && python -m pytest tests/ -v 2>&1" },
    undefined,
    400,
    ts(13),
  );
  turns.push(tr3.turn);

  turns.push(
    userToolResult(
      tr3.id,
      `============================= test session starts ==============================\n` +
      `platform linux -- Python 3.11.8, pytest-8.1.1\n` +
      `collected 24 items\n\n` +
      `tests/test_auth.py::test_login_success PASSED\n` +
      `tests/test_auth.py::test_login_invalid_password PASSED\n` +
      `tests/test_auth.py::test_token_refresh PASSED\n` +
      `tests/test_auth.py::test_token_expiry PASSED\n` +
      `tests/test_payments.py::test_create_payment PASSED\n` +
      `tests/test_payments.py::test_payment_validation PASSED\n` +
      `tests/test_payments.py::test_duplicate_payment PASSED\n` +
      `tests/test_payments.py::test_refund PASSED\n` +
      `tests/test_payments.py::test_partial_refund PASSED\n` +
      `tests/test_users.py::test_create_user PASSED\n` +
      `tests/test_users.py::test_update_profile PASSED\n` +
      `tests/test_users.py::test_delete_user PASSED\n` +
      `tests/test_users.py::test_user_preferences PASSED\n` +
      `tests/test_webhooks.py::test_webhook_delivery PASSED\n` +
      `tests/test_webhooks.py::test_webhook_retry PASSED\n` +
      `tests/test_webhooks.py::test_webhook_signature PASSED\n` +
      `tests/test_webhooks.py::test_webhook_timeout FAILED\n` +
      `tests/test_integration.py::test_full_payment_flow PASSED\n` +
      `tests/test_integration.py::test_concurrent_payments PASSED\n` +
      `tests/test_integration.py::test_payment_with_webhook FAILED\n` +
      `tests/test_integration.py::test_idempotency PASSED\n` +
      `tests/test_integration.py::test_rate_limiting PASSED\n` +
      `tests/test_integration.py::test_error_recovery PASSED\n` +
      `tests/test_integration.py::test_audit_trail PASSED\n\n` +
      `================================= FAILURES ==================================\n` +
      `___________________________ test_webhook_timeout _____________________________\n` +
      `    TimeoutError: Webhook delivery timed out after 30s\n` +
      `    Expected timeout to be 10s (configured value)\n` +
      `    File "tests/test_webhooks.py", line 89\n` +
      `___________________________ test_payment_with_webhook ________________________\n` +
      `    AssertionError: Webhook not received within 5s after payment\n` +
      `    File "tests/test_integration.py", line 134\n\n` +
      `======================== 2 failed, 22 passed, 24 total ======================`,
      8000,
      false,
      ts(14),
    ),
  );

  // Turn 12 (assistant): almost there, fix webhooks
  const t12fix = assistantToolUse(
    "Down to 2 failures (22 passed). Both remaining failures are webhook-related. " +
    "The webhook timeout is 30s but should be 10s (config says `timeout_seconds: 10`). " +
    "Let me check the webhook module.",
    "read",
    { path: "/opt/payment-svc/src/webhooks.py" },
    undefined,
    500,
    ts(15),
  );
  turns.push(t12fix.turn);

  turns.push(
    userToolResult(
      t12fix.id,
      `import httpx\nfrom config import get_config\n\n` +
      `class WebhookDelivery:\n` +
      `    # BUG: timeout hardcoded instead of from config\n` +
      `    TIMEOUT = 30  # should be get_config('webhooks.timeout_seconds')\n\n` +
      `    async def deliver(self, url, payload, signing_secret):\n` +
      `        signature = self._sign(payload, signing_secret)\n` +
      `        try:\n` +
      `            resp = await httpx.post(\n` +
      `                url,\n` +
      `                json=payload,\n` +
      `                headers={"X-Webhook-Signature": signature},\n` +
      `                timeout=self.TIMEOUT\n` +
      `            )\n` +
      `            return resp.status_code == 200\n` +
      `        except httpx.TimeoutException:\n` +
      `            return False\n`,
      4000,
      false,
      ts(15),
    ),
  );

  // Turn 13 (assistant): fix webhooks
  const t13fix = assistantToolUse(
    "Same pattern — hardcoded timeout. Let me also re-read the config once more to make sure " +
    "we have all the webhook settings right.",
    "read",
    { path: "/opt/payment-svc/config/test.yaml" },
    undefined,
    400,
    ts(16),
  );
  turns.push(t13fix.turn);

  // Third read of same config
  turns.push(
    userToolResult(t13fix.id, configContent, 4000, false, ts(16)),
  );

  // Turn 14 (assistant): write fix
  const t14fix = assistantToolUse(
    "Confirmed: `webhooks.timeout_seconds: 10`. Fixing:",
    "write",
    {
      path: "/opt/payment-svc/src/webhooks.py",
      content:
        `import httpx\nfrom config import get_config\n\n` +
        `class WebhookDelivery:\n` +
        `    def __init__(self):\n` +
        `        self.timeout = get_config('webhooks.timeout_seconds', default=10)\n\n` +
        `    async def deliver(self, url, payload, signing_secret):\n` +
        `        signature = self._sign(payload, signing_secret)\n` +
        `        try:\n` +
        `            resp = await httpx.post(\n` +
        `                url,\n` +
        `                json=payload,\n` +
        `                headers={"X-Webhook-Signature": signature},\n` +
        `                timeout=self.timeout\n` +
        `            )\n` +
        `            return resp.status_code == 200\n` +
        `        except httpx.TimeoutException:\n` +
        `            return False\n`,
    },
    undefined,
    700,
    ts(17),
  );
  turns.push(t14fix.turn);

  turns.push(
    userToolResult(t14fix.id, "File written: /opt/payment-svc/src/webhooks.py", 200, false, ts(17)),
  );

  // --- Test run 4 ---
  const tr4 = assistantToolUse(
    "Running tests again to check webhook fixes.",
    "bash",
    { command: "cd /opt/payment-svc && python -m pytest tests/ -v 2>&1" },
    undefined,
    400,
    ts(18),
  );
  turns.push(tr4.turn);

  turns.push(
    userToolResult(
      tr4.id,
      `============================= test session starts ==============================\n` +
      `platform linux -- Python 3.11.8, pytest-8.1.1\n` +
      `collected 24 items\n\n` +
      `tests/test_auth.py::test_login_success PASSED\n` +
      `tests/test_auth.py::test_login_invalid_password PASSED\n` +
      `tests/test_auth.py::test_token_refresh PASSED\n` +
      `tests/test_auth.py::test_token_expiry PASSED\n` +
      `tests/test_payments.py::test_create_payment PASSED\n` +
      `tests/test_payments.py::test_payment_validation PASSED\n` +
      `tests/test_payments.py::test_duplicate_payment PASSED\n` +
      `tests/test_payments.py::test_refund PASSED\n` +
      `tests/test_payments.py::test_partial_refund PASSED\n` +
      `tests/test_users.py::test_create_user PASSED\n` +
      `tests/test_users.py::test_update_profile PASSED\n` +
      `tests/test_users.py::test_delete_user PASSED\n` +
      `tests/test_users.py::test_user_preferences PASSED\n` +
      `tests/test_webhooks.py::test_webhook_delivery PASSED\n` +
      `tests/test_webhooks.py::test_webhook_retry PASSED\n` +
      `tests/test_webhooks.py::test_webhook_signature PASSED\n` +
      `tests/test_webhooks.py::test_webhook_timeout PASSED\n` +
      `tests/test_integration.py::test_full_payment_flow PASSED\n` +
      `tests/test_integration.py::test_concurrent_payments PASSED\n` +
      `tests/test_integration.py::test_payment_with_webhook FAILED\n` +
      `tests/test_integration.py::test_idempotency PASSED\n` +
      `tests/test_integration.py::test_rate_limiting PASSED\n` +
      `tests/test_integration.py::test_error_recovery PASSED\n` +
      `tests/test_integration.py::test_audit_trail PASSED\n\n` +
      `================================= FAILURES ==================================\n` +
      `___________________________ test_payment_with_webhook ________________________\n` +
      `    AssertionError: Webhook not received within 5s after payment\n` +
      `    The payment was created successfully but the webhook event\n` +
      `    was not dispatched. Root cause: PaymentService.create_payment()\n` +
      `    does not emit the 'payment.created' event on the event bus.\n` +
      `    File "tests/test_integration.py", line 134\n\n` +
      `======================== 1 failed, 23 passed, 24 total ======================`,
      8000,
      false,
      ts(19),
    ),
  );

  // Turn 16 (assistant): one left — missing event emission
  const t16fix = assistantToolUse(
    "Down to 1 failure (23 passed). The integration test reveals the payment service isn't " +
    "emitting `payment.created` event on the event bus after creating a payment. " +
    "Let me fix the payments module to emit the event.",
    "write",
    {
      path: "/opt/payment-svc/src/payments.py",
      content:
        `from db import get_db\nfrom config import get_config\nfrom events import event_bus\n\n` +
        `class PaymentService:\n` +
        `    def create_payment(self, amount, currency, idempotency_key=None):\n` +
        `        if idempotency_key:\n` +
        `            existing = get_db().query(\n` +
        `                "SELECT * FROM payments WHERE idempotency_key = ?", idempotency_key\n` +
        `            )\n` +
        `            if existing:\n` +
        `                return existing, 409\n` +
        `        payment = self._process_payment(amount, currency)\n` +
        `        event_bus.emit('payment.created', payment)\n` +
        `        return payment, 201\n\n` +
        `    def refund(self, payment_id, amount):\n` +
        `        payment = get_db().query("SELECT * FROM payments WHERE id = ?", payment_id)\n` +
        `        available = payment['amount'] - payment.get('total_refunded', 0)\n` +
        `        if amount > available:\n` +
        `            raise ValueError(f"Refund amount {amount} exceeds remaining {available}")\n` +
        `        return self._process_refund(payment_id, amount)\n`,
    },
    undefined,
    800,
    ts(20),
  );
  turns.push(t16fix.turn);

  turns.push(
    userToolResult(t16fix.id, "File written: /opt/payment-svc/src/payments.py", 200, false, ts(20)),
  );

  // --- Test run 5 ---
  const tr5 = assistantToolUse(
    "Final test run — let's see if everything passes now.",
    "bash",
    { command: "cd /opt/payment-svc && python -m pytest tests/ -v 2>&1" },
    undefined,
    400,
    ts(21),
  );
  turns.push(tr5.turn);

  turns.push(
    userToolResult(
      tr5.id,
      `============================= test session starts ==============================\n` +
      `platform linux -- Python 3.11.8, pytest-8.1.1\n` +
      `collected 24 items\n\n` +
      `tests/test_auth.py::test_login_success PASSED\n` +
      `tests/test_auth.py::test_login_invalid_password PASSED\n` +
      `tests/test_auth.py::test_token_refresh PASSED\n` +
      `tests/test_auth.py::test_token_expiry PASSED\n` +
      `tests/test_payments.py::test_create_payment PASSED\n` +
      `tests/test_payments.py::test_payment_validation PASSED\n` +
      `tests/test_payments.py::test_duplicate_payment PASSED\n` +
      `tests/test_payments.py::test_refund PASSED\n` +
      `tests/test_payments.py::test_partial_refund PASSED\n` +
      `tests/test_users.py::test_create_user PASSED\n` +
      `tests/test_users.py::test_update_profile PASSED\n` +
      `tests/test_users.py::test_delete_user PASSED\n` +
      `tests/test_users.py::test_user_preferences PASSED\n` +
      `tests/test_webhooks.py::test_webhook_delivery PASSED\n` +
      `tests/test_webhooks.py::test_webhook_retry PASSED\n` +
      `tests/test_webhooks.py::test_webhook_signature PASSED\n` +
      `tests/test_webhooks.py::test_webhook_timeout PASSED\n` +
      `tests/test_integration.py::test_full_payment_flow PASSED\n` +
      `tests/test_integration.py::test_concurrent_payments PASSED\n` +
      `tests/test_integration.py::test_payment_with_webhook PASSED\n` +
      `tests/test_integration.py::test_idempotency PASSED\n` +
      `tests/test_integration.py::test_rate_limiting PASSED\n` +
      `tests/test_integration.py::test_error_recovery PASSED\n` +
      `tests/test_integration.py::test_audit_trail PASSED\n\n` +
      `======================== 24 passed, 0 failed, 24 total ======================`,
      7000,
      false,
      ts(22),
    ),
  );

  // Turn 18 (assistant): all green
  turns.push(
    assistantText(
      "All 24 tests pass! Here's a summary of what was fixed:\n\n" +
      "1. **test_token_expiry**: `auth.py` had hardcoded `TOKEN_EXPIRY = 7200` instead of reading " +
      "from config (`auth.token_expiry_seconds: 3600`)\n" +
      "2. **test_duplicate_payment**: `payments.py` queried `reference_id` instead of `idempotency_key` column\n" +
      "3. **test_partial_refund**: `payments.py` didn't subtract previous refunds from available amount\n" +
      "4. **test_user_preferences**: User model hardcoded USD instead of reading `users.default_currency: EUR`\n" +
      "5. **test_webhook_timeout**: `webhooks.py` hardcoded `TIMEOUT = 30` instead of reading " +
      "`webhooks.timeout_seconds: 10`\n" +
      "6. **test_payment_with_webhook**: `payments.py` wasn't emitting `payment.created` event on the event bus",
      1200,
      ts(23),
    ),
  );

  return {
    id: "cm-2-session",
    label: "Fixing payment service test suite with repetitive test runs",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: turns.reduce((sum, t) => sum + (t.tokens ?? 0), 0),
      description:
        "~25-turn session running pytest 5 times with progressively fewer failures. " +
        "Config file read 3 times (identical). Tests dedup between similar outputs.",
    },
  };
}

// ---------------------------------------------------------------------------
// CM-2 questions
// ---------------------------------------------------------------------------

function buildCM2Questions(): EvalQuestion[] {
  const base = {
    dimension: "context" as const,
    scenario: "cm-2-tool-dedup",
    sessionRef: "cm-2-session",
    rubric: RUBRICS.toolDedup,
    metadata: { tags: ["tool-dedup"], difficulty: "medium" as const },
  };

  return [
    {
      ...base,
      id: "cm-2-q1",
      question: "How many tests were passing in the FIRST test run?",
      referenceAnswer:
        "18 tests passed out of 24 total in the first test run (6 failed: test_token_expiry, " +
        "test_duplicate_payment, test_partial_refund, test_user_preferences, test_webhook_timeout, " +
        "test_payment_with_webhook).",
      metadata: { ...base.metadata, turnIndex: 1, cumulativeTokens: 9000 },
    },
    {
      ...base,
      id: "cm-2-q2",
      question: "What new test started passing between test run 1 and test run 2?",
      referenceAnswer:
        "test_token_expiry in tests/test_auth.py started passing between run 1 and run 2. " +
        "The fix was changing the hardcoded TOKEN_EXPIRY = 7200 to read from config " +
        "(auth.token_expiry_seconds: 3600) in src/auth.py.",
      metadata: { ...base.metadata, turnIndex: 7, cumulativeTokens: 25000 },
    },
    {
      ...base,
      id: "cm-2-q3",
      question: "What was the content of the config file that was read multiple times?",
      referenceAnswer:
        "config/test.yaml was read 3 times with identical content. Key settings: " +
        "auth.token_expiry_seconds=3600, payments.currency=USD, payments.idempotency_window_seconds=86400, " +
        "webhooks.timeout_seconds=10, webhooks.max_retries=3, users.default_currency=EUR, " +
        "database url=postgresql://test:test@localhost:5432/payment_test.",
      metadata: { ...base.metadata, turnIndex: 3, cumulativeTokens: 12000 },
    },
    {
      ...base,
      id: "cm-2-q4",
      question:
        "What error appeared in test_auth.py (test_token_expiry) but NOT in test_users.py (test_user_preferences)?",
      referenceAnswer:
        "test_token_expiry in test_auth.py failed with 'AssertionError: Token should expire after " +
        "3600s, but expiry was 7200s' (a timing/numeric mismatch). test_user_preferences in " +
        "test_users.py failed with 'AssertionError: Expected currency EUR, got USD' " +
        "(a string/config mismatch). The token expiry error is about a numeric timeout value " +
        "being doubled, while the preferences error is about wrong default currency string.",
      metadata: { ...base.metadata, turnIndex: 1, cumulativeTokens: 9000 },
    },
    {
      ...base,
      id: "cm-2-q5",
      question:
        "How many tests were failing in each of the 5 test runs? List the progression.",
      referenceAnswer:
        "Run 1: 6 failed, 18 passed. Run 2: 5 failed, 19 passed (test_token_expiry fixed). " +
        "Run 3: 2 failed, 22 passed (test_duplicate_payment, test_partial_refund, test_user_preferences fixed). " +
        "Run 4: 1 failed, 23 passed (test_webhook_timeout fixed). " +
        "Run 5: 0 failed, 24 passed (test_payment_with_webhook fixed).",
      metadata: { ...base.metadata, turnIndex: 18, cumulativeTokens: 80000 },
    },
    {
      ...base,
      id: "cm-2-q6",
      question: "Which test was the LAST one to be fixed, and what was the root cause?",
      referenceAnswer:
        "test_payment_with_webhook in tests/test_integration.py was the last to be fixed. " +
        "The root cause was that PaymentService.create_payment() was not emitting the " +
        "'payment.created' event on the event bus after creating a payment, so the webhook " +
        "was never dispatched.",
      metadata: { ...base.metadata, turnIndex: 16, cumulativeTokens: 70000 },
    },
    {
      ...base,
      id: "cm-2-q7",
      question:
        "What were the TWO bugs found in the payments.py module that were fixed simultaneously?",
      referenceAnswer:
        "1. Idempotency check: queried 'reference_id' column instead of 'idempotency_key' column, " +
        "so duplicate payments with the same idempotency key were accepted (201 instead of 409). " +
        "2. Partial refund: didn't subtract previous refunds from available amount — checked " +
        "'amount > payment[amount]' instead of 'amount > payment[amount] - payment[total_refunded]', " +
        "allowing refunds exceeding the remaining balance.",
      metadata: { ...base.metadata, turnIndex: 7, cumulativeTokens: 30000 },
    },
    {
      ...base,
      id: "cm-2-q8",
      question:
        "In the webhook module, what was the hardcoded timeout value and what should it have been?",
      referenceAnswer:
        "The webhook timeout was hardcoded as TIMEOUT = 30 (seconds) in the WebhookDelivery class " +
        "in src/webhooks.py. The config file (config/test.yaml) specified webhooks.timeout_seconds: 10. " +
        "The fix was to read from config via get_config('webhooks.timeout_seconds', default=10).",
      metadata: { ...base.metadata, turnIndex: 13, cumulativeTokens: 55000 },
    },
  ];
}

// =========================================================================
// CM-3: Gradient Layer Escalation
// =========================================================================

function buildCM3Transcript(): SessionTranscript {
  const turns: ConversationTurn[] = [];

  // This transcript simulates a very long session implementing a full REST API
  // from scratch: project scaffolding, database, models, routes, auth, tests,
  // deployment config. ~60 turns that would total ~300K tokens when rendered.
  //
  // We plant specific facts at 4 checkpoints:
  //   Checkpoint A (layer 0, turns 0-6):   project scaffolding & DB setup
  //   Checkpoint B (layer 1, turns 14-20): models & business logic
  //   Checkpoint C (layer 2, turns 30-36): auth & middleware
  //   Checkpoint D (layer 3, turns 50-56): deployment & final tests

  // =====================================================================
  // Checkpoint A: Layer 0 — Project Scaffolding & DB (turns 0-14)
  // =====================================================================

  // Turn 0 (user): kick off
  turns.push(
    userText(
      "Let's build a REST API for a task management system. I want to use " +
      "Hono.js as the framework with Drizzle ORM for PostgreSQL. The project " +
      "name should be 'taskflow-api'. Use pnpm as package manager and Vitest " +
      "for testing. The database should be hosted at 'pg.taskflow.internal:5432' " +
      "with database name 'taskflow_prod'.",
      500,
      ts(0),
    ),
  );

  // Turn 1 (assistant): scaffold
  const a1 = assistantToolUse(
    "I'll scaffold the project with Hono.js, Drizzle ORM, and Vitest. Let me start.",
    "bash",
    { command: "mkdir -p taskflow-api/src/{routes,models,middleware,db} && cd taskflow-api && pnpm init" },
    undefined,
    600,
    ts(1),
  );
  turns.push(a1.turn);

  turns.push(
    userToolResult(
      a1.id,
      `Created /home/dev/taskflow-api/package.json`,
      500,
      false,
      ts(1),
    ),
  );

  // Turn 2 (assistant): install deps
  const a2 = assistantToolUse(
    "Installing dependencies.",
    "bash",
    { command: "cd taskflow-api && pnpm add hono drizzle-orm postgres && pnpm add -D drizzle-kit vitest @types/node typescript" },
    undefined,
    500,
    ts(2),
  );
  turns.push(a2.turn);

  turns.push(
    userToolResult(
      a2.id,
      `Packages: +87\n` +
      `Progress: resolved 87, reused 62, downloaded 25, added 87\n` +
      `Dependencies:\n` +
      `+ hono 4.4.2\n+ drizzle-orm 0.31.2\n+ postgres 3.4.4\n` +
      `+ drizzle-kit 0.22.7\n+ vitest 1.6.0\n+ typescript 5.4.5`,
      2000,
      false,
      ts(2),
    ),
  );

  // Turn 3 (assistant): create DB schema
  const a3 = assistantToolUse(
    "Let me create the database schema. I'll set up the connection config and the initial " +
    "schema with users, projects, and tasks tables. The primary key strategy will be " +
    "UUIDv7 (time-sortable) generated via `crypto.randomUUID()` with a custom UUIDv7 " +
    "wrapper. Foreign key cascade deletes on project → tasks.",
    "write",
    {
      path: "taskflow-api/src/db/schema.ts",
      content:
        `import { pgTable, uuid, text, timestamp, boolean, integer, pgEnum } from 'drizzle-orm/pg-core';\n\n` +
        `export const taskStatusEnum = pgEnum('task_status', ['todo', 'in_progress', 'review', 'done', 'cancelled']);\n` +
        `export const priorityEnum = pgEnum('priority', ['p0_critical', 'p1_high', 'p2_medium', 'p3_low']);\n\n` +
        `export const users = pgTable('users', {\n` +
        `  id: uuid('id').primaryKey().defaultRandom(),\n` +
        `  email: text('email').notNull().unique(),\n` +
        `  name: text('name').notNull(),\n` +
        `  avatarUrl: text('avatar_url'),\n` +
        `  createdAt: timestamp('created_at').defaultNow().notNull(),\n` +
        `});\n\n` +
        `export const projects = pgTable('projects', {\n` +
        `  id: uuid('id').primaryKey().defaultRandom(),\n` +
        `  name: text('name').notNull(),\n` +
        `  slug: text('slug').notNull().unique(),\n` +
        `  description: text('description'),\n` +
        `  ownerId: uuid('owner_id').references(() => users.id).notNull(),\n` +
        `  createdAt: timestamp('created_at').defaultNow().notNull(),\n` +
        `});\n\n` +
        `export const tasks = pgTable('tasks', {\n` +
        `  id: uuid('id').primaryKey().defaultRandom(),\n` +
        `  title: text('title').notNull(),\n` +
        `  description: text('description'),\n` +
        `  status: taskStatusEnum('status').default('todo').notNull(),\n` +
        `  priority: priorityEnum('priority').default('p2_medium').notNull(),\n` +
        `  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),\n` +
        `  assigneeId: uuid('assignee_id').references(() => users.id),\n` +
        `  dueDate: timestamp('due_date'),\n` +
        `  estimatedHours: integer('estimated_hours'),\n` +
        `  createdAt: timestamp('created_at').defaultNow().notNull(),\n` +
        `  updatedAt: timestamp('updated_at').defaultNow().notNull(),\n` +
        `});\n`,
    },
    undefined,
    2000,
    ts(3),
  );
  turns.push(a3.turn);

  turns.push(
    userToolResult(a3.id, "File written: taskflow-api/src/db/schema.ts", 200, false, ts(3)),
  );

  // Turn 4 (assistant): DB connection
  const a4 = assistantToolUse(
    "Now the database connection module. Using the `postgres` driver with connection pooling. " +
    "Max pool size 20, idle timeout 30s. The connection string uses the env var " +
    "`DATABASE_URL` with fallback to `postgres://taskflow:taskflow@pg.taskflow.internal:5432/taskflow_prod`.",
    "write",
    {
      path: "taskflow-api/src/db/connection.ts",
      content:
        `import { drizzle } from 'drizzle-orm/postgres-js';\nimport postgres from 'postgres';\nimport * as schema from './schema';\n\n` +
        `const connectionString = process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@pg.taskflow.internal:5432/taskflow_prod';\n\n` +
        `const client = postgres(connectionString, {\n  max: 20,\n  idle_timeout: 30,\n  connect_timeout: 10,\n});\n\n` +
        `export const db = drizzle(client, { schema });\nexport type Database = typeof db;\n`,
    },
    undefined,
    1000,
    ts(4),
  );
  turns.push(a4.turn);

  turns.push(
    userToolResult(a4.id, "File written: taskflow-api/src/db/connection.ts", 200, false, ts(4)),
  );

  // Turn 5 (assistant): drizzle config
  const a5 = assistantToolUse(
    "Creating the Drizzle Kit configuration for migrations.",
    "write",
    {
      path: "taskflow-api/drizzle.config.ts",
      content:
        `import type { Config } from 'drizzle-kit';\n\n` +
        `export default {\n` +
        `  schema: './src/db/schema.ts',\n` +
        `  out: './drizzle',\n` +
        `  driver: 'pg',\n` +
        `  dbCredentials: {\n` +
        `    connectionString: process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@pg.taskflow.internal:5432/taskflow_prod',\n` +
        `  },\n` +
        `} satisfies Config;\n`,
    },
    undefined,
    800,
    ts(5),
  );
  turns.push(a5.turn);

  turns.push(
    userToolResult(a5.id, "File written: taskflow-api/drizzle.config.ts", 200, false, ts(5)),
  );

  // Turn 6 (assistant): run migration
  const a6 = assistantToolUse(
    "Generating and running the initial migration.",
    "bash",
    { command: "cd taskflow-api && npx drizzle-kit generate:pg && npx drizzle-kit push:pg" },
    undefined,
    500,
    ts(6),
  );
  turns.push(a6.turn);

  turns.push(
    userToolResult(
      a6.id,
      `drizzle-kit: v0.22.7\n` +
      `Generated migration: 0000_init.sql\n` +
      `  CREATE TYPE task_status ...\n  CREATE TYPE priority ...\n` +
      `  CREATE TABLE users ...\n  CREATE TABLE projects ...\n  CREATE TABLE tasks ...\n` +
      `Migration 0000_init.sql applied successfully.`,
      3000,
      false,
      ts(6),
    ),
  );

  // Turns 7-13: padding turns for layer 0 → layer 1 transition
  // These add substantial token weight through file content and test output
  for (let i = 7; i <= 13; i++) {
    const padTool = assistantToolUse(
      `Setting up project infrastructure (tsconfig, Vitest config, env validation, ` +
      `error handling utilities, request validation with Zod schemas, pagination helpers, ` +
      `and response formatting utilities). Step ${i - 6} of 7.`,
      "write",
      {
        path: `taskflow-api/src/lib/infra-${i - 6}.ts`,
        content: `// Infrastructure module ${i - 6}\n` +
          `// Contains: ${["tsconfig + path aliases", "vitest.config.ts setup", "env validation with zod",
            "global error handler middleware", "request validation middleware",
            "pagination utility + cursor encoding", "response formatter + HATEOAS links"][i - 7]}\n` +
          `export {};\n`,
      },
      undefined,
      4000,   // large token estimate — simulates substantial file content
      ts(7 + (i - 7) * 2),
    );
    turns.push(padTool.turn);
    turns.push(
      userToolResult(
        padTool.id,
        `File written: taskflow-api/src/lib/infra-${i - 6}.ts`,
        500,
        false,
        ts(7 + (i - 7) * 2),
      ),
    );
  }

  // =====================================================================
  // Checkpoint B: Layer 1 — Models & Business Logic (turns 14-29)
  // =====================================================================

  // Turn 14 (user): now implement models
  turns.push(
    userText(
      "Now let's implement the business logic layer. For the task assignment rules:\n" +
      "- A user can have at most 10 active tasks (status != 'done' and != 'cancelled')\n" +
      "- P0 tasks must have an assignee and a due date\n" +
      "- When a task moves to 'done', auto-set updatedAt to now\n" +
      "- Project slugs must be lowercase alphanumeric with hyphens only, max 50 chars\n" +
      "- The task title has a 200-character limit enforced at the service layer\n\n" +
      "Also, our naming convention for service files is `<entity>.service.ts` and for " +
      "validators `<entity>.validator.ts`.",
      600,
      ts(20),
    ),
  );

  // Turn 15 (assistant): task service
  const b1 = assistantToolUse(
    "Creating the task service with all the business rules you specified. " +
    "The assignment cap of 10 active tasks is enforced via a count query before assignment.",
    "write",
    {
      path: "taskflow-api/src/models/task.service.ts",
      content:
        `import { db } from '../db/connection';\nimport { tasks } from '../db/schema';\n` +
        `import { eq, and, notInArray, count } from 'drizzle-orm';\n\n` +
        `const MAX_ACTIVE_TASKS = 10;\nconst MAX_TITLE_LENGTH = 200;\n\n` +
        `export class TaskService {\n` +
        `  async create(data: NewTask) {\n` +
        `    if (data.title.length > MAX_TITLE_LENGTH) throw new ValidationError('Title exceeds 200 chars');\n` +
        `    if (data.priority === 'p0_critical' && (!data.assigneeId || !data.dueDate)) {\n` +
        `      throw new ValidationError('P0 tasks require assignee and due date');\n` +
        `    }\n` +
        `    if (data.assigneeId) await this.checkAssignmentCap(data.assigneeId);\n` +
        `    return db.insert(tasks).values(data).returning();\n` +
        `  }\n\n` +
        `  async checkAssignmentCap(userId: string) {\n` +
        `    const [result] = await db.select({ count: count() }).from(tasks)\n` +
        `      .where(and(eq(tasks.assigneeId, userId), notInArray(tasks.status, ['done', 'cancelled'])));\n` +
        `    if (result.count >= MAX_ACTIVE_TASKS) throw new ValidationError('User has 10 active tasks (max)');\n` +
        `  }\n` +
        `}\n`,
    },
    undefined,
    2000,
    ts(21),
  );
  turns.push(b1.turn);

  turns.push(
    userToolResult(b1.id, "File written: taskflow-api/src/models/task.service.ts", 200, false, ts(21)),
  );

  // Turns 16-29: more implementation padding — routes, validators, etc.
  const implSteps = [
    { file: "task.validator.ts", desc: "Zod schemas for task CRUD validation" },
    { file: "project.service.ts", desc: "project CRUD with slug validation (lowercase alphanum+hyphens, max 50)" },
    { file: "project.validator.ts", desc: "Zod schemas for project validation" },
    { file: "user.service.ts", desc: "user CRUD with email uniqueness check" },
    { file: "user.validator.ts", desc: "Zod schemas for user validation" },
    { file: "task.routes.ts", desc: "Hono routes for /tasks CRUD" },
    { file: "project.routes.ts", desc: "Hono routes for /projects CRUD" },
    { file: "user.routes.ts", desc: "Hono routes for /users CRUD" },
    { file: "index.ts", desc: "main Hono app with route mounting" },
    { file: "task.test.ts", desc: "Vitest tests for task service (12 test cases)" },
    { file: "project.test.ts", desc: "Vitest tests for project service (8 test cases)" },
    { file: "user.test.ts", desc: "Vitest tests for user service (6 test cases)" },
    { file: "integration.test.ts", desc: "integration tests for full API flow (5 test cases)" },
    { file: "test-utils.ts", desc: "test helpers: DB seeding, cleanup, mock factories" },
  ];

  for (let i = 0; i < implSteps.length; i++) {
    const step = implSteps[i];
    const turnIdx = 16 + i * 2;
    const dir = step.file.includes("test")
      ? "taskflow-api/src/__tests__"
      : step.file.includes("routes") || step.file === "index.ts"
        ? "taskflow-api/src/routes"
        : "taskflow-api/src/models";

    const tool = assistantToolUse(
      `Implementing ${step.desc}.`,
      "write",
      { path: `${dir}/${step.file}`, content: `// ${step.desc}\nexport {};\n` },
      undefined,
      3500,   // simulates substantial file
      ts(22 + i * 2),
    );
    turns.push(tool.turn);
    turns.push(
      userToolResult(
        tool.id,
        `File written: ${dir}/${step.file}`,
        200,
        false,
        ts(22 + i * 2),
      ),
    );
  }

  // =====================================================================
  // Checkpoint C: Layer 2 — Auth & Middleware (turns 30-49)
  // =====================================================================

  // Turn 44 (in our array — mapped to conceptual turn 30 in the narrative)
  turns.push(
    userText(
      "Now let's add authentication. Requirements:\n" +
      "- Use JWT with RS256 algorithm (not HS256 — we need asymmetric for microservices)\n" +
      "- Access tokens expire in 15 minutes, refresh tokens in 7 days\n" +
      "- Store refresh tokens in the database with device fingerprinting\n" +
      "- Rate limit auth endpoints: 5 attempts per minute per IP\n" +
      "- The JWT issuer should be 'taskflow-api.acme.com'\n" +
      "- Use 2048-bit RSA keys stored in /etc/taskflow/keys/",
      600,
      ts(50),
    ),
  );

  const c1 = assistantToolUse(
    "Setting up JWT auth with RS256. Access token TTL 15min, refresh 7 days. " +
    "Issuer: taskflow-api.acme.com. Keys from /etc/taskflow/keys/.",
    "write",
    {
      path: "taskflow-api/src/middleware/auth.ts",
      content:
        `import { verify, sign } from 'jsonwebtoken';\nimport { readFileSync } from 'fs';\n\n` +
        `const PRIVATE_KEY = readFileSync('/etc/taskflow/keys/private.pem');\n` +
        `const PUBLIC_KEY = readFileSync('/etc/taskflow/keys/public.pem');\n` +
        `const ISSUER = 'taskflow-api.acme.com';\n` +
        `const ACCESS_TOKEN_TTL = 15 * 60;   // 15 minutes\n` +
        `const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days\n\n` +
        `export function createAccessToken(userId: string) {\n` +
        `  return sign({ sub: userId }, PRIVATE_KEY, {\n` +
        `    algorithm: 'RS256', expiresIn: ACCESS_TOKEN_TTL, issuer: ISSUER,\n` +
        `  });\n` +
        `}\n\n` +
        `export function verifyToken(token: string) {\n` +
        `  return verify(token, PUBLIC_KEY, { algorithms: ['RS256'], issuer: ISSUER });\n` +
        `}\n`,
    },
    undefined,
    2000,
    ts(51),
  );
  turns.push(c1.turn);

  turns.push(
    userToolResult(c1.id, "File written: taskflow-api/src/middleware/auth.ts", 200, false, ts(51)),
  );

  // Rate limiter
  const c2 = assistantToolUse(
    "Creating the rate limiter middleware. Using a sliding window with Redis as the backing " +
    "store. 5 attempts per minute per IP for auth endpoints. The Redis instance is at " +
    "'redis.taskflow.internal:6379'.",
    "write",
    {
      path: "taskflow-api/src/middleware/rate-limiter.ts",
      content:
        `import { Redis } from 'ioredis';\n\n` +
        `const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis.taskflow.internal:6379');\n\n` +
        `export function rateLimiter(maxAttempts = 5, windowSeconds = 60) {\n` +
        `  return async (c, next) => {\n` +
        `    const key = \`rate:\${c.req.path}:\${c.req.header('x-forwarded-for') ?? c.req.raw.socket?.remoteAddress}\`;\n` +
        `    const current = await redis.incr(key);\n` +
        `    if (current === 1) await redis.expire(key, windowSeconds);\n` +
        `    if (current > maxAttempts) return c.json({ error: 'Rate limited' }, 429);\n` +
        `    await next();\n` +
        `  };\n` +
        `}\n`,
    },
    undefined,
    1500,
    ts(52),
  );
  turns.push(c2.turn);

  turns.push(
    userToolResult(c2.id, "File written: taskflow-api/src/middleware/rate-limiter.ts", 200, false, ts(52)),
  );

  // Turns 48-63 (array indices): more auth & middleware padding
  const authSteps = [
    { file: "refresh-token.ts", desc: "refresh token model with device fingerprinting" },
    { file: "auth.routes.ts", desc: "auth routes: POST /login, POST /refresh, POST /logout" },
    { file: "rbac.ts", desc: "role-based access control middleware (admin, member, viewer)" },
    { file: "cors.ts", desc: "CORS configuration for allowed origins" },
    { file: "request-id.ts", desc: "X-Request-ID generation middleware" },
    { file: "logging.ts", desc: "structured JSON logging middleware with pino" },
    { file: "auth.test.ts", desc: "auth middleware tests (10 test cases)" },
    { file: "rate-limiter.test.ts", desc: "rate limiter tests (6 test cases)" },
    { file: "rbac.test.ts", desc: "RBAC tests (8 test cases)" },
    { file: "e2e-auth.test.ts", desc: "end-to-end auth flow tests (4 test cases)" },
  ];

  for (let i = 0; i < authSteps.length; i++) {
    const step = authSteps[i];
    const dir = step.file.includes("test")
      ? "taskflow-api/src/__tests__"
      : step.file.includes("routes")
        ? "taskflow-api/src/routes"
        : "taskflow-api/src/middleware";

    const tool = assistantToolUse(
      `Implementing ${step.desc}.`,
      "write",
      { path: `${dir}/${step.file}`, content: `// ${step.desc}\nexport {};\n` },
      undefined,
      3500,
      ts(53 + i * 2),
    );
    turns.push(tool.turn);
    turns.push(
      userToolResult(
        tool.id,
        `File written: ${dir}/${step.file}`,
        200,
        false,
        ts(53 + i * 2),
      ),
    );
  }

  // =====================================================================
  // Checkpoint D: Layer 3 — Deployment & Final Tests (turns 50-60)
  // =====================================================================

  turns.push(
    userText(
      "Let's set up the deployment configuration. We're deploying to Kubernetes on GKE. " +
      "Requirements:\n" +
      "- Docker image: `gcr.io/acme-prod/taskflow-api`\n" +
      "- Replicas: 3 (min) to 10 (max) with HPA targeting 70% CPU\n" +
      "- Health check endpoint: GET /healthz (liveness) and GET /readyz (readiness)\n" +
      "- The service should be exposed via Istio VirtualService on `api.taskflow.acme.com`\n" +
      "- Resource limits: 512Mi memory, 500m CPU per pod\n" +
      "- Use a ConfigMap named 'taskflow-config' for non-secret env vars\n" +
      "- Secrets managed via External Secrets Operator pointing to GCP Secret Manager",
      700,
      ts(80),
    ),
  );

  // Dockerfile
  const d1 = assistantToolUse(
    "Creating the multi-stage Dockerfile. Using node:20-alpine for the final image.",
    "write",
    {
      path: "taskflow-api/Dockerfile",
      content:
        `FROM node:20-alpine AS builder\nWORKDIR /app\n` +
        `COPY package.json pnpm-lock.yaml ./\n` +
        `RUN corepack enable && pnpm install --frozen-lockfile\n` +
        `COPY . .\nRUN pnpm build\n\n` +
        `FROM node:20-alpine\nWORKDIR /app\n` +
        `COPY --from=builder /app/dist ./dist\n` +
        `COPY --from=builder /app/node_modules ./node_modules\n` +
        `EXPOSE 3000\nCMD ["node", "dist/index.js"]\n`,
    },
    undefined,
    1500,
    ts(81),
  );
  turns.push(d1.turn);

  turns.push(
    userToolResult(d1.id, "File written: taskflow-api/Dockerfile", 200, false, ts(81)),
  );

  // K8s deployment
  const d2 = assistantToolUse(
    "Creating the Kubernetes deployment manifest with HPA. 3-10 replicas, 70% CPU target. " +
    "Resource limits: 512Mi / 500m. Image: gcr.io/acme-prod/taskflow-api.",
    "write",
    {
      path: "taskflow-api/k8s/deployment.yaml",
      content:
        `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: taskflow-api\n  namespace: taskflow\nspec:\n` +
        `  replicas: 3\n  selector:\n    matchLabels:\n      app: taskflow-api\n  template:\n` +
        `    metadata:\n      labels:\n        app: taskflow-api\n    spec:\n      containers:\n` +
        `      - name: taskflow-api\n        image: gcr.io/acme-prod/taskflow-api:latest\n` +
        `        ports:\n        - containerPort: 3000\n        resources:\n          limits:\n` +
        `            memory: "512Mi"\n            cpu: "500m"\n          requests:\n` +
        `            memory: "256Mi"\n            cpu: "250m"\n        livenessProbe:\n` +
        `          httpGet:\n            path: /healthz\n            port: 3000\n` +
        `          initialDelaySeconds: 10\n          periodSeconds: 30\n        readinessProbe:\n` +
        `          httpGet:\n            path: /readyz\n            port: 3000\n` +
        `          initialDelaySeconds: 5\n          periodSeconds: 10\n` +
        `        envFrom:\n        - configMapRef:\n            name: taskflow-config\n` +
        `        - secretRef:\n            name: taskflow-secrets\n---\n` +
        `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n` +
        `  name: taskflow-api-hpa\n  namespace: taskflow\nspec:\n  scaleTargetRef:\n` +
        `    apiVersion: apps/v1\n    kind: Deployment\n    name: taskflow-api\n` +
        `  minReplicas: 3\n  maxReplicas: 10\n  metrics:\n  - type: Resource\n    resource:\n` +
        `      name: cpu\n      target:\n        type: Utilization\n        averageUtilization: 70\n`,
    },
    undefined,
    3000,
    ts(82),
  );
  turns.push(d2.turn);

  turns.push(
    userToolResult(d2.id, "File written: taskflow-api/k8s/deployment.yaml", 200, false, ts(82)),
  );

  // Istio VirtualService
  const d3 = assistantToolUse(
    "Creating the Istio VirtualService for api.taskflow.acme.com routing.",
    "write",
    {
      path: "taskflow-api/k8s/virtualservice.yaml",
      content:
        `apiVersion: networking.istio.io/v1beta1\nkind: VirtualService\nmetadata:\n` +
        `  name: taskflow-api\n  namespace: taskflow\nspec:\n  hosts:\n` +
        `  - api.taskflow.acme.com\n  gateways:\n  - istio-system/main-gateway\n` +
        `  http:\n  - match:\n    - uri:\n        prefix: /\n    route:\n` +
        `    - destination:\n        host: taskflow-api\n        port:\n          number: 3000\n` +
        `    timeout: 30s\n    retries:\n      attempts: 3\n      retryOn: 5xx\n`,
    },
    undefined,
    1500,
    ts(83),
  );
  turns.push(d3.turn);

  turns.push(
    userToolResult(d3.id, "File written: taskflow-api/k8s/virtualservice.yaml", 200, false, ts(83)),
  );

  // More deployment padding
  const deploySteps = [
    { file: "configmap.yaml", desc: "ConfigMap 'taskflow-config' with non-secret env vars" },
    { file: "external-secret.yaml", desc: "ExternalSecret pointing to GCP Secret Manager" },
    { file: "service.yaml", desc: "Kubernetes Service (ClusterIP, port 3000)" },
    { file: "networkpolicy.yaml", desc: "NetworkPolicy restricting ingress to Istio gateway" },
  ];

  for (let i = 0; i < deploySteps.length; i++) {
    const step = deploySteps[i];
    const tool = assistantToolUse(
      `Creating ${step.desc}.`,
      "write",
      { path: `taskflow-api/k8s/${step.file}`, content: `# ${step.desc}\n` },
      undefined,
      2000,
      ts(84 + i * 2),
    );
    turns.push(tool.turn);
    turns.push(
      userToolResult(
        tool.id,
        `File written: taskflow-api/k8s/${step.file}`,
        200,
        false,
        ts(84 + i * 2),
      ),
    );
  }

  // Final test run
  const dTest = assistantToolUse(
    "Running the full test suite one final time before deploying.",
    "bash",
    { command: "cd taskflow-api && pnpm test 2>&1" },
    undefined,
    600,
    ts(92),
  );
  turns.push(dTest.turn);

  turns.push(
    userToolResult(
      dTest.id,
      `✓ src/__tests__/task.test.ts (12 tests) 340ms\n` +
      `✓ src/__tests__/project.test.ts (8 tests) 210ms\n` +
      `✓ src/__tests__/user.test.ts (6 tests) 180ms\n` +
      `✓ src/__tests__/auth.test.ts (10 tests) 290ms\n` +
      `✓ src/__tests__/rate-limiter.test.ts (6 tests) 150ms\n` +
      `✓ src/__tests__/rbac.test.ts (8 tests) 220ms\n` +
      `✓ src/__tests__/e2e-auth.test.ts (4 tests) 890ms\n` +
      `✓ src/__tests__/integration.test.ts (5 tests) 1.2s\n\n` +
      `Test Files  8 passed (8)\n` +
      `     Tests  59 passed (59)\n` +
      `      Time  3.48s`,
      3000,
      false,
      ts(93),
    ),
  );

  // Final summary
  turns.push(
    assistantText(
      "All 59 tests pass across 8 test files. The project is ready for deployment.\n\n" +
      "**Architecture summary**:\n" +
      "- Framework: Hono.js with Drizzle ORM on PostgreSQL\n" +
      "- Auth: JWT RS256, 15min access / 7d refresh, rate limited 5/min/IP\n" +
      "- Deployment: GKE with 3-10 replicas, HPA at 70% CPU, Istio routing\n" +
      "- Domain: api.taskflow.acme.com\n" +
      "- Total: 59 tests, 8 test files, 100% passing",
      900,
      ts(94),
    ),
  );

  return {
    id: "cm-3-session",
    label: "Building taskflow-api from scratch (scaffolding → deployment)",
    projectPath: PROJECT_PATH,
    turns,
    metadata: {
      totalTokens: turns.reduce((sum, t) => sum + (t.tokens ?? 0), 0),
      description:
        "~60-turn session building a full REST API. 4 checkpoints for gradient layer " +
        "escalation testing: scaffolding (L0), business logic (L1), auth (L2), deployment (L3).",
    },
  };
}

// ---------------------------------------------------------------------------
// CM-3 questions
// ---------------------------------------------------------------------------

function buildCM3Questions(): EvalQuestion[] {
  const base = {
    dimension: "context" as const,
    scenario: "cm-3-layer-escalation",
    sessionRef: "cm-3-session",
    rubric: RUBRICS.layerEscalation,
    metadata: { tags: ["layer-escalation"] },
  };

  return [
    // Checkpoint A: Layer 0 — project scaffolding facts (turns 0-6)
    {
      ...base,
      id: "cm-3-a1",
      question: "What framework and ORM were chosen for the taskflow-api project?",
      referenceAnswer:
        "Hono.js as the web framework and Drizzle ORM for PostgreSQL database access.",
      metadata: { ...base.metadata, turnIndex: 0, cumulativeTokens: 500, difficulty: "easy" as const },
    },
    {
      ...base,
      id: "cm-3-a2",
      question: "What is the database host and name configured for the taskflow-api?",
      referenceAnswer:
        "Host: pg.taskflow.internal:5432, database name: taskflow_prod. " +
        "Connection string: postgres://taskflow:taskflow@pg.taskflow.internal:5432/taskflow_prod. " +
        "Connection pool max: 20, idle timeout: 30s.",
      metadata: { ...base.metadata, turnIndex: 4, cumulativeTokens: 5000, difficulty: "medium" as const },
    },
    {
      ...base,
      id: "cm-3-a3",
      question: "What primary key strategy was chosen for the database tables?",
      referenceAnswer:
        "UUIDv7 (time-sortable) generated via crypto.randomUUID() with a custom UUIDv7 wrapper. " +
        "The schema uses uuid('id').primaryKey().defaultRandom() for all tables (users, projects, tasks). " +
        "Foreign key cascade deletes are configured on project → tasks.",
      metadata: { ...base.metadata, turnIndex: 3, cumulativeTokens: 3000, difficulty: "hard" as const },
    },

    // Checkpoint B: Layer 1 — business logic facts (turns 14-29)
    {
      ...base,
      id: "cm-3-b1",
      question: "What is the maximum number of active tasks a user can be assigned?",
      referenceAnswer:
        "10 active tasks per user (tasks with status not 'done' and not 'cancelled'). " +
        "This is enforced by the TaskService.checkAssignmentCap() method which runs a " +
        "count query before allowing assignment.",
      metadata: { ...base.metadata, turnIndex: 15, cumulativeTokens: 35000, difficulty: "easy" as const },
    },
    {
      ...base,
      id: "cm-3-b2",
      question: "What validation rules apply to P0 (critical) priority tasks?",
      referenceAnswer:
        "P0 tasks must have both an assignee (assigneeId) and a due date (dueDate). " +
        "If either is missing, the TaskService throws a ValidationError. This is " +
        "checked at creation time in TaskService.create().",
      metadata: { ...base.metadata, turnIndex: 15, cumulativeTokens: 35000, difficulty: "medium" as const },
    },
    {
      ...base,
      id: "cm-3-b3",
      question: "What naming convention was specified for service and validator files?",
      referenceAnswer:
        "Service files: <entity>.service.ts (e.g., task.service.ts, project.service.ts). " +
        "Validator files: <entity>.validator.ts (e.g., task.validator.ts). " +
        "Project slugs must be lowercase alphanumeric with hyphens only, max 50 chars. " +
        "Task title has a 200-character limit enforced at the service layer.",
      metadata: { ...base.metadata, turnIndex: 14, cumulativeTokens: 32000, difficulty: "hard" as const },
    },

    // Checkpoint C: Layer 2 — auth facts (turns 30-49)
    {
      ...base,
      id: "cm-3-c1",
      question: "What JWT algorithm is used for authentication in taskflow-api?",
      referenceAnswer:
        "RS256 (asymmetric RSA). HS256 was explicitly rejected because asymmetric keys " +
        "are needed for microservices. Uses 2048-bit RSA keys stored in /etc/taskflow/keys/ " +
        "(private.pem and public.pem).",
      metadata: { ...base.metadata, turnIndex: 44, cumulativeTokens: 100000, difficulty: "easy" as const },
    },
    {
      ...base,
      id: "cm-3-c2",
      question: "What are the access and refresh token expiry times?",
      referenceAnswer:
        "Access tokens: 15 minutes (900 seconds). Refresh tokens: 7 days (604800 seconds). " +
        "Refresh tokens are stored in the database with device fingerprinting. " +
        "The JWT issuer is 'taskflow-api.acme.com'.",
      metadata: { ...base.metadata, turnIndex: 44, cumulativeTokens: 100000, difficulty: "medium" as const },
    },
    {
      ...base,
      id: "cm-3-c3",
      question: "What are the rate limiting settings for auth endpoints?",
      referenceAnswer:
        "5 attempts per minute per IP address on auth endpoints. Uses sliding window with " +
        "Redis as backing store. Redis instance at redis.taskflow.internal:6379. " +
        "Returns 429 status code when rate limited.",
      metadata: { ...base.metadata, turnIndex: 46, cumulativeTokens: 105000, difficulty: "hard" as const },
    },

    // Checkpoint D: Layer 3 — deployment facts (turns 50-60)
    {
      ...base,
      id: "cm-3-d1",
      question: "How many test files and total tests pass in the final test run?",
      referenceAnswer:
        "8 test files, 59 tests total, all passing. Time: 3.48s. " +
        "Files: task.test.ts (12), project.test.ts (8), user.test.ts (6), " +
        "auth.test.ts (10), rate-limiter.test.ts (6), rbac.test.ts (8), " +
        "e2e-auth.test.ts (4), integration.test.ts (5).",
      metadata: { ...base.metadata, turnIndex: 58, cumulativeTokens: 250000, difficulty: "easy" as const },
    },
    {
      ...base,
      id: "cm-3-d2",
      question: "What Docker base image is used and what is the container registry path?",
      referenceAnswer:
        "Base image: node:20-alpine (multi-stage build). Container registry: " +
        "gcr.io/acme-prod/taskflow-api. The Dockerfile uses a builder stage for " +
        "compilation and a slim final stage.",
      metadata: { ...base.metadata, turnIndex: 54, cumulativeTokens: 200000, difficulty: "medium" as const },
    },
    {
      ...base,
      id: "cm-3-d3",
      question:
        "What are the Kubernetes HPA settings and the Istio VirtualService hostname?",
      referenceAnswer:
        "HPA: min 3 replicas, max 10 replicas, targeting 70% CPU utilization. " +
        "Pod limits: 512Mi memory, 500m CPU. Requests: 256Mi memory, 250m CPU. " +
        "Istio VirtualService hostname: api.taskflow.acme.com. " +
        "Liveness probe: GET /healthz, readiness probe: GET /readyz. " +
        "ConfigMap: taskflow-config. Secrets via External Secrets Operator + GCP Secret Manager.",
      metadata: { ...base.metadata, turnIndex: 56, cumulativeTokens: 220000, difficulty: "hard" as const },
    },
  ];
}

// =========================================================================
// Export
// =========================================================================

export const scenarios: ScenarioDefinition[] = [
  {
    id: "cm-1-early-detail",
    name: "CM-1: Long Session Early Detail Retention",
    dimension: "context",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [buildCM1Transcript()],
    questions: buildCM1Questions(),
  },
  {
    id: "cm-2-tool-dedup",
    name: "CM-2: Tool Output Deduplication",
    dimension: "context",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [buildCM2Transcript()],
    questions: buildCM2Questions(),
  },
  {
    id: "cm-3-layer-escalation",
    name: "CM-3: Gradient Layer Escalation",
    dimension: "context",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [buildCM3Transcript()],
    questions: buildCM3Questions(),
  },
];
