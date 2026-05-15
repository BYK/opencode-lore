import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { enableHostedMode, isHostedMode, _resetHostedModeForTest } from "../src/hosted";
import { getGitRemote, clearGitRemoteCache } from "../src/git";
import { load } from "../src/config";
import {
  loreFileExists,
  exportLoreFile,
  shouldImportLoreFile,
  importLoreFile,
  shouldImport,
  importFromFile,
  exportToFile,
} from "../src/agents-file";
import { hasLatDir, refresh } from "../src/lat-reader";

const TMP = join(import.meta.dir, "__tmp_hosted__");

beforeEach(() => {
  _resetHostedModeForTest();
  clearGitRemoteCache();
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  _resetHostedModeForTest();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hosted.ts — flag behavior
// ---------------------------------------------------------------------------

describe("hosted mode flag", () => {
  test("defaults to false", () => {
    expect(isHostedMode()).toBe(false);
  });

  test("enableHostedMode sets it to true", () => {
    enableHostedMode();
    expect(isHostedMode()).toBe(true);
  });

  test("multiple enables are idempotent", () => {
    enableHostedMode();
    enableHostedMode();
    expect(isHostedMode()).toBe(true);
  });

  test("_resetHostedModeForTest resets to false", () => {
    enableHostedMode();
    _resetHostedModeForTest();
    expect(isHostedMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// git.ts — getGitRemote
// ---------------------------------------------------------------------------

describe("getGitRemote in hosted mode", () => {
  test("returns null without running subprocess", () => {
    enableHostedMode();
    // Pass a path that would normally produce a git remote (or error).
    // In hosted mode, it should return null immediately without touching FS.
    expect(getGitRemote("/nonexistent/path")).toBeNull();
  });

  test("returns result normally when not in hosted mode", () => {
    // process.cwd() should be in a git repo (this test repo)
    const result = getGitRemote(process.cwd());
    // Should be either a string (the remote) or null (no remote configured)
    // but should NOT throw
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// config.ts — load
// ---------------------------------------------------------------------------

describe("config.load in hosted mode", () => {
  test("skips .lore.json and returns defaults", async () => {
    // Write a config that changes a setting
    writeFileSync(
      join(TMP, ".lore.json"),
      JSON.stringify({ agentsFile: { enabled: false } }),
      "utf8",
    );

    enableHostedMode();
    const cfg = await load(TMP);
    // Should get defaults, not the file's value
    expect(cfg.agentsFile.enabled).toBe(true);
  });

  test("reads .lore.json normally when not in hosted mode", async () => {
    writeFileSync(
      join(TMP, ".lore.json"),
      JSON.stringify({ agentsFile: { enabled: false } }),
      "utf8",
    );

    const cfg = await load(TMP);
    expect(cfg.agentsFile.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agents-file.ts — all FS functions
// ---------------------------------------------------------------------------

describe("agents-file in hosted mode", () => {
  test("loreFileExists returns false", () => {
    // Create a .lore.md file that would normally be found
    writeFileSync(join(TMP, ".lore.md"), "# test", "utf8");

    enableHostedMode();
    expect(loreFileExists(TMP)).toBe(false);
  });

  test("exportLoreFile is a no-op (does not write)", () => {
    enableHostedMode();
    exportLoreFile(TMP);
    expect(existsSync(join(TMP, ".lore.md"))).toBe(false);
  });

  test("shouldImportLoreFile returns false", () => {
    writeFileSync(join(TMP, ".lore.md"), "# test content", "utf8");

    enableHostedMode();
    expect(shouldImportLoreFile(TMP)).toBe(false);
  });

  test("importLoreFile is a no-op", () => {
    writeFileSync(join(TMP, ".lore.md"), "# test content", "utf8");

    enableHostedMode();
    // Should not throw and should not import anything
    importLoreFile(TMP);
  });

  test("shouldImport returns false", () => {
    const filePath = join(TMP, "AGENTS.md");
    writeFileSync(filePath, "# Agents\nSome content", "utf8");

    enableHostedMode();
    expect(shouldImport({ projectPath: TMP, filePath })).toBe(false);
  });

  test("importFromFile is a no-op", () => {
    const filePath = join(TMP, "AGENTS.md");
    writeFileSync(filePath, "# Agents\nSome content", "utf8");

    enableHostedMode();
    importFromFile({ projectPath: TMP, filePath });
  });

  test("exportToFile is a no-op (does not write)", () => {
    enableHostedMode();
    const filePath = join(TMP, "AGENTS.md");
    exportToFile({ projectPath: TMP, filePath });
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(join(TMP, ".lore.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lat-reader.ts
// ---------------------------------------------------------------------------

describe("lat-reader in hosted mode", () => {
  test("hasLatDir returns false", () => {
    mkdirSync(join(TMP, "lat.md"), { recursive: true });

    enableHostedMode();
    expect(hasLatDir(TMP)).toBe(false);
  });

  test("refresh returns 0", () => {
    mkdirSync(join(TMP, "lat.md"), { recursive: true });
    writeFileSync(join(TMP, "lat.md", "test.md"), "# Section\nContent", "utf8");

    enableHostedMode();
    expect(refresh(TMP)).toBe(0);
  });
});
