/**
 * Smoke test for the npm bundle artifacts.
 *
 * Verifies that:
 * - Every file referenced by package.json `files` and `exports` exists
 * - The Bun ESM bundle uses bun:sqlite (not node:sqlite)
 * - The CJS Node bundle uses node:sqlite (not bun:sqlite)
 * - The Bun ESM bundle can be imported at runtime under Bun
 * - The imported module exports the expected public API
 *
 * Requires `bun run bundle` to have been run first. Skipped otherwise.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(fileURLToPath(import.meta.url), "..", "..");
const distDir = join(packageDir, "dist");
const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const hasBunBundle = existsSync(join(distDir, "index.bun.js")) &&
  !readFileSync(join(distDir, "index.bun.js"), "utf8").startsWith("export *");
const hasBundle = existsSync(join(distDir, "index.cjs")) && hasBunBundle;

describe.skipIf(!hasBundle)("bundle exports", () => {
  // -------------------------------------------------------------------------
  // Layer 1: Static content checks
  // -------------------------------------------------------------------------

  test("all declared files exist", () => {
    for (const file of pkgJson.files as string[]) {
      const fullPath = join(packageDir, file);
      expect(existsSync(fullPath)).toBe(true);
    }
  });

  test("export conditions reference files in the files list", () => {
    const filesSet = new Set(pkgJson.files as string[]);
    const exports = pkgJson.exports["."] as Record<string, string>;
    for (const [condition, filePath] of Object.entries(exports)) {
      // Strip leading "./" for comparison with files array entries
      const normalized = filePath.replace(/^\.\//, "");
      expect(filesSet.has(normalized)).toBe(true);
    }
  });

  test("Bun bundle uses bun:sqlite, not node:sqlite", () => {
    const content = readFileSync(join(distDir, "index.bun.js"), "utf8");
    expect(content).toContain("bun:sqlite");
    expect(content).not.toContain("node:sqlite");
  });

  test("CJS bundle uses node:sqlite, not bun:sqlite", () => {
    const content = readFileSync(join(distDir, "index.cjs"), "utf8");
    expect(content).toContain("node:sqlite");
    expect(content).not.toContain("bun:sqlite");
  });

  // -------------------------------------------------------------------------
  // Layer 2: Runtime import under Bun
  // -------------------------------------------------------------------------

  test("Bun bundle can be imported at runtime", async () => {
    const mod = await import(join(distDir, "index.bun.js"));
    expect(typeof mod.startGateway).toBe("function");
    expect(typeof mod.loadConfig).toBe("function");
    expect(typeof mod.readPortFile).toBe("function");
    expect(typeof mod.probeGateway).toBe("function");
  });
});
