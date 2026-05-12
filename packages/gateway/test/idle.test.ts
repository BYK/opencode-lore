/**
 * Tests for buildIdleWorkHandler project isolation.
 *
 * The idle handler tests require mock.module("@loreai/core", ...) which
 * pollutes the module cache for the entire Bun process. To avoid breaking
 * other test files (e.g. cache-warmer.test.ts which also imports @loreai/core),
 * we run the actual tests in a subprocess via `bun test`.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dir, "helpers", "idle-worker.ts");

describe("buildIdleWorkHandler", () => {
  test("uses state.projectPath for all core operations", async () => {
    const result = await runIsolatedTests();
    if (result.exitCode !== 0) {
      // Print the subprocess output for debugging
      console.error(result.stderr);
      console.log(result.stdout);
    }
    expect(result.exitCode).toBe(0);
  });
});

/**
 * Run the idle worker test file in an isolated Bun subprocess.
 */
async function runIsolatedTests(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "test", WORKER_PATH], {
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
