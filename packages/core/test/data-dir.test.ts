import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { dataDir, _resetMigrationFlag } from "../src/data-dir";

describe("dataDir — legacy directory migration", () => {
  let tempBase: string;
  const origXdg = process.env.XDG_DATA_HOME;
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "lore-migration-test-"));
    process.env.XDG_DATA_HOME = tempBase;
    // Migration skips when NODE_ENV=test, so unset it for these tests.
    delete process.env.NODE_ENV;
    _resetMigrationFlag();
  });

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdg;

    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;

    rmSync(tempBase, { recursive: true, force: true });
  });

  it("migrates old directory to new when only old exists", () => {
    const oldDir = join(tempBase, "opencode-lore");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "lore.db"), "test-data");
    writeFileSync(join(oldDir, "lore.log"), "log-data");

    const result = dataDir();

    expect(result).toBe(join(tempBase, "lore"));
    expect(existsSync(join(tempBase, "lore", "lore.db"))).toBe(true);
    expect(existsSync(join(tempBase, "lore", "lore.log"))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
  });

  it("does nothing when only new directory exists", () => {
    const newDir = join(tempBase, "lore");
    mkdirSync(newDir);
    writeFileSync(join(newDir, "lore.db"), "new-data");

    const result = dataDir();

    expect(result).toBe(newDir);
    expect(readFileSync(join(newDir, "lore.db"), "utf8")).toBe("new-data");
  });

  it("keeps new directory when both exist", () => {
    const oldDir = join(tempBase, "opencode-lore");
    const newDir = join(tempBase, "lore");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, "lore.db"), "old-data");
    writeFileSync(join(newDir, "lore.db"), "new-data");

    dataDir();

    // New directory wins; old directory is untouched.
    expect(readFileSync(join(newDir, "lore.db"), "utf8")).toBe("new-data");
    expect(existsSync(oldDir)).toBe(true);
  });

  it("returns new path when neither directory exists", () => {
    const result = dataDir();

    expect(result).toBe(join(tempBase, "lore"));
    // dataDir() does NOT create the directory — callers do.
    expect(existsSync(result)).toBe(false);
  });

  it("runs migration only once per process (guarded by flag)", () => {
    const oldDir = join(tempBase, "opencode-lore");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "lore.db"), "data");

    // First call migrates.
    dataDir();
    expect(existsSync(join(tempBase, "lore", "lore.db"))).toBe(true);

    // Recreate old dir — second call should NOT migrate again.
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "lore.db"), "stale");
    dataDir();
    expect(existsSync(oldDir)).toBe(true); // still there
  });

  it("skips migration when NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    _resetMigrationFlag();

    const oldDir = join(tempBase, "opencode-lore");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "lore.db"), "data");

    const result = dataDir();

    expect(result).toBe(join(tempBase, "lore"));
    // Old directory should still exist — migration was skipped.
    expect(existsSync(oldDir)).toBe(true);
  });
});
