import { describe, test, expect } from "bun:test";
import { inferProjectPath, getProjectPath, extractGitRemoteHeader, extractProjectHeader } from "../src/config";
import { resolveSessionProjectPath } from "../src/pipeline";

// ---------------------------------------------------------------------------
// inferProjectPath
// ---------------------------------------------------------------------------

describe("inferProjectPath", () => {
  test("extracts path from JSON-style cwd field (double-quoted)", () => {
    const system = `Some preamble\n"cwd": "/home/user/my-project"\nMore text`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts path from JSON-style cwd field (single-quoted)", () => {
    const system = `Tool def: 'cwd': '/Users/dev/app'`;
    expect(inferProjectPath(system)).toBe("/Users/dev/app");
  });

  test("extracts path from JSON-style cwd field (no quotes)", () => {
    const system = `cwd=/home/user/project`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });

  test("extracts path from Working directory line", () => {
    const system = `Working directory: /home/byk/Code/opencode-lore\nOther stuff`;
    expect(inferProjectPath(system)).toBe("/home/byk/Code/opencode-lore");
  });

  test("extracts path from working directory (lowercase w)", () => {
    const system = `working directory: /Users/dev/project`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("extracts directory from CLAUDE.md path reference", () => {
    const system = `Instructions from: /home/user/my-project/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts directory from AGENTS.md path reference", () => {
    const system = `Instructions from: /home/byk/Code/opencode-lore/AGENTS.md`;
    expect(inferProjectPath(system)).toBe("/home/byk/Code/opencode-lore");
  });

  test("extracts directory from .lore.md path reference", () => {
    const system = `See /Users/dev/project/.lore.md for details`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("falls back to generic /home/ path", () => {
    const system = `Some text mentioning /home/user/generic-project here`;
    expect(inferProjectPath(system)).toBe("/home/user/generic-project");
  });

  test("falls back to generic /Users/ path", () => {
    const system = `Some text mentioning /Users/dev/generic-project here`;
    expect(inferProjectPath(system)).toBe("/Users/dev/generic-project");
  });

  test("returns null for empty system prompt", () => {
    expect(inferProjectPath("")).toBeNull();
  });

  test("returns null for system prompt without paths", () => {
    expect(inferProjectPath("You are a helpful assistant.")).toBeNull();
  });

  test("cwd pattern matches any absolute path (not just /home/ or /Users/)", () => {
    // The cwd pattern is structurally specific enough to accept any absolute path.
    expect(inferProjectPath("cwd: /var/lib/project")).toBe("/var/lib/project");
  });

  test("generic fallback returns null for paths not starting with /home/ or /Users/", () => {
    // Without a structural prefix (cwd, Working directory, CLAUDE.md), only
    // /home/ and /Users/ paths are matched by the generic fallback.
    expect(inferProjectPath("Some text /var/lib/project here")).toBeNull();
  });

  test("prefers cwd field over generic path match", () => {
    // cwd pattern is checked first; if both are present, cwd wins
    const system = `Some /home/other/path here\n"cwd": "/home/user/correct-project"`;
    expect(inferProjectPath(system)).toBe("/home/user/correct-project");
  });

  test("prefers Working directory over CLAUDE.md reference", () => {
    const system = `Working directory: /home/user/project-a\nInstructions from: /home/user/project-b/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/project-a");
  });

  test("strips trailing slashes", () => {
    const system = `Working directory: /home/user/project/`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });

  // --- Broadened patterns (any absolute path for structurally-specific patterns) ---

  test("extracts path from cwd field with /root/ prefix", () => {
    expect(inferProjectPath('"cwd": "/root/project"')).toBe("/root/project");
  });

  test("extracts path from cwd field with /var/home/ prefix", () => {
    expect(inferProjectPath('"cwd": "/var/home/user/project"')).toBe("/var/home/user/project");
  });

  test("extracts path from cwd field with /nix/store/ prefix", () => {
    expect(inferProjectPath('"cwd": "/nix/store/abc/project"')).toBe("/nix/store/abc/project");
  });

  test("extracts path from Working directory with /root/ prefix", () => {
    expect(inferProjectPath("Working directory: /root/my-app")).toBe("/root/my-app");
  });

  test("extracts path from Working directory with /data/ prefix (Termux)", () => {
    expect(inferProjectPath("Working directory: /data/data/com.termux/files/home/project")).toBe(
      "/data/data/com.termux/files/home/project",
    );
  });

  test("extracts directory from CLAUDE.md with /root/ path", () => {
    expect(inferProjectPath("Instructions from: /root/project/CLAUDE.md")).toBe("/root/project");
  });

  test("extracts directory from AGENTS.md with /nix/store/ path", () => {
    expect(inferProjectPath("Instructions from: /nix/store/abc/project/AGENTS.md")).toBe(
      "/nix/store/abc/project",
    );
  });

  test("generic fallback still requires /home/ or /Users/", () => {
    // Only the generic pattern should apply — and it should NOT match /root/
    expect(inferProjectPath("Some text /root/project here")).toBeNull();
  });

  test("generic fallback still rejects /var/ paths", () => {
    expect(inferProjectPath("Some text /var/lib/project here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getProjectPath
// ---------------------------------------------------------------------------

describe("getProjectPath", () => {
  test("prefers X-Lore-Project header over system prompt inference", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      { "x-lore-project": "/home/user/explicit-project" },
    );
    expect(result.path).toBe("/home/user/explicit-project");
    expect(result.source).toBe("header");
    expect(result.gitRemote).toBeUndefined();
  });

  test("falls back to inferProjectPath when no header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      {},
    );
    expect(result.path).toBe("/home/user/inferred-project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBeUndefined();
  });

  test("falls back to process.cwd() when neither header nor inference match", () => {
    const result = getProjectPath("You are a helpful assistant.", {});
    expect(result.path).toBe(process.cwd());
    expect(result.source).toBe("cwd");
    expect(result.gitRemote).toBeUndefined();
  });

  test("ignores empty X-Lore-Project header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-project": "" },
    );
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBeUndefined();
  });

  test("sanitizes control characters from X-Lore-Project header", () => {
    const result = getProjectPath("", { "x-lore-project": "/home/user/project\n" });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("header");
  });

  test("rejects non-absolute X-Lore-Project header, falls through to inference", () => {
    const result = getProjectPath(
      "Working directory: /home/user/project",
      { "x-lore-project": "relative/path" },
    );
    expect(result.source).toBe("inferred");
  });

  test("strips trailing slashes from X-Lore-Project header", () => {
    const result = getProjectPath("", { "x-lore-project": "/home/user/project///" });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("header");
  });

  test("rejects X-Lore-Project header exceeding 1024 characters", () => {
    const longPath = "/" + "a".repeat(1030);
    const result = getProjectPath(
      "Working directory: /home/user/project",
      { "x-lore-project": longPath },
    );
    expect(result.source).toBe("inferred");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (HTTPS)", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-git-remote": "https://github.com/org/repo.git" },
    );
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (SSH)", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-git-remote": "git@github.com:org/repo.git" },
    );
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (already normalized)", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-git-remote": "github.com/org/repo" },
    );
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("trims whitespace from X-Lore-Git-Remote header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-git-remote": "  https://github.com/org/repo.git  " },
    );
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("ignores empty X-Lore-Git-Remote header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/project`,
      { "x-lore-git-remote": "" },
    );
    expect(result.gitRemote).toBeUndefined();
  });

  test("X-Lore-Git-Remote is independent of project path source", () => {
    // With header path
    const r1 = getProjectPath("", {
      "x-lore-project": "/home/user/project",
      "x-lore-git-remote": "github.com/org/repo",
    });
    expect(r1.source).toBe("header");
    expect(r1.gitRemote).toBe("github.com/org/repo");

    // With cwd fallback
    const r2 = getProjectPath("No paths here", {
      "x-lore-git-remote": "github.com/org/repo",
    });
    expect(r2.source).toBe("cwd");
    expect(r2.gitRemote).toBe("github.com/org/repo");
  });
});

// ---------------------------------------------------------------------------
// extractProjectHeader
// ---------------------------------------------------------------------------

describe("extractProjectHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractProjectHeader({})).toBeUndefined();
  });

  test("returns undefined for empty header", () => {
    expect(extractProjectHeader({ "x-lore-project": "" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only header", () => {
    expect(extractProjectHeader({ "x-lore-project": "   " })).toBeUndefined();
  });

  test("extracts valid absolute path", () => {
    expect(extractProjectHeader({ "x-lore-project": "/home/user/project" }))
      .toBe("/home/user/project");
  });

  test("strips control characters", () => {
    expect(extractProjectHeader({ "x-lore-project": "/home/user/project\n" }))
      .toBe("/home/user/project");
  });

  test("strips carriage return and null bytes", () => {
    expect(extractProjectHeader({ "x-lore-project": "/home/user/project\r\0" }))
      .toBe("/home/user/project");
  });

  test("rejects non-absolute path", () => {
    expect(extractProjectHeader({ "x-lore-project": "relative/path" })).toBeUndefined();
  });

  test("strips trailing slashes", () => {
    expect(extractProjectHeader({ "x-lore-project": "/home/user/project///" }))
      .toBe("/home/user/project");
  });

  test("rejects values exceeding 1024 characters", () => {
    const longPath = "/" + "a".repeat(1030);
    expect(extractProjectHeader({ "x-lore-project": longPath })).toBeUndefined();
  });

  test("accepts values at exactly 1024 characters", () => {
    const value = "/" + "a".repeat(1023); // 1024 total
    expect(extractProjectHeader({ "x-lore-project": value })).toBeDefined();
  });

  test("trims whitespace before validation", () => {
    expect(extractProjectHeader({ "x-lore-project": "  /home/user/project  " }))
      .toBe("/home/user/project");
  });

  test("accepts /root/ paths", () => {
    expect(extractProjectHeader({ "x-lore-project": "/root/project" }))
      .toBe("/root/project");
  });
});

// ---------------------------------------------------------------------------
// extractGitRemoteHeader
// ---------------------------------------------------------------------------

describe("extractGitRemoteHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractGitRemoteHeader({})).toBeUndefined();
  });

  test("returns undefined for empty header", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only header", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "   " })).toBeUndefined();
  });

  test("normalizes HTTPS URL", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "https://github.com/org/repo.git" }))
      .toBe("github.com/org/repo");
  });

  test("normalizes SSH URL", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "git@github.com:org/repo.git" }))
      .toBe("github.com/org/repo");
  });

  test("strips control characters (newline injection)", () => {
    // After stripping \n, the result is "github.com/org/repoX-Api-Key: stolen"
    // which normalizeRemoteUrl lowercases the host part only.
    // The key point: the newline is gone, preventing header injection.
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "github.com/org/repo\nX-Api-Key: stolen" }))
      .toBe("github.com/org/repoX-Api-Key: stolen");
  });

  test("strips carriage return and null bytes", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "github.com/org/repo\r\0" }))
      .toBe("github.com/org/repo");
  });

  test("rejects values exceeding 512 characters", () => {
    const longValue = "github.com/" + "a".repeat(510);
    expect(extractGitRemoteHeader({ "x-lore-git-remote": longValue })).toBeUndefined();
  });

  test("accepts values at exactly 512 characters", () => {
    const value = "github.com/" + "a".repeat(501); // 512 total
    expect(extractGitRemoteHeader({ "x-lore-git-remote": value })).toBeDefined();
  });

  test("trims whitespace before length check", () => {
    const value = "  github.com/org/repo  ";
    expect(extractGitRemoteHeader({ "x-lore-git-remote": value }))
      .toBe("github.com/org/repo");
  });
});

// ---------------------------------------------------------------------------
// resolveSessionProjectPath
// ---------------------------------------------------------------------------

describe("resolveSessionProjectPath", () => {
  function makeSessionState(projectPath: string) {
    return { projectPath } as any;
  }

  test("upgrades cwd fallback to session's cached path", () => {
    const state = makeSessionState("/home/user/real-project");
    const result = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      state,
    );
    expect(result).toBe("/home/user/real-project");
  });

  test("keeps cwd when session has the same path (no upgrade available)", () => {
    const cwd = process.cwd();
    const state = makeSessionState(cwd);
    const result = resolveSessionProjectPath(
      { path: cwd, source: "cwd" },
      state,
    );
    expect(result).toBe(cwd);
  });

  test("uses inferred path and updates session cache", () => {
    const state = makeSessionState("/home/user/old-project");
    const result = resolveSessionProjectPath(
      { path: "/home/user/new-project", source: "inferred" },
      state,
    );
    expect(result).toBe("/home/user/new-project");
    expect(state.projectPath).toBe("/home/user/new-project");
  });

  test("uses header path and updates session cache", () => {
    const state = makeSessionState("/home/user/old-project");
    const result = resolveSessionProjectPath(
      { path: "/home/user/header-project", source: "header" },
      state,
    );
    expect(result).toBe("/home/user/header-project");
    expect(state.projectPath).toBe("/home/user/header-project");
  });

  test("does not update session cache on cwd fallback", () => {
    const state = makeSessionState("/home/user/real-project");
    resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      state,
    );
    // Session cache should remain unchanged (upgraded, not overwritten)
    expect(state.projectPath).toBe("/home/user/real-project");
  });

  test("does not update session cache when upgrade from cwd occurs", () => {
    const state = makeSessionState("/home/user/cached-project");
    const result = resolveSessionProjectPath(
      { path: "/tmp/wrong", source: "cwd" },
      state,
    );
    expect(result).toBe("/home/user/cached-project");
    // Session cache should remain unchanged
    expect(state.projectPath).toBe("/home/user/cached-project");
  });

  test("caches gitRemote from result onto session state", () => {
    const state = makeSessionState("/home/user/project");
    resolveSessionProjectPath(
      { path: "/home/user/project", source: "inferred", gitRemote: "github.com/org/repo" },
      state,
    );
    expect(state.gitRemote).toBe("github.com/org/repo");
  });

  test("does not overwrite existing session gitRemote", () => {
    const state = makeSessionState("/home/user/project");
    state.gitRemote = "github.com/org/original-repo";
    resolveSessionProjectPath(
      { path: "/home/user/project", source: "inferred", gitRemote: "github.com/org/new-repo" },
      state,
    );
    // Should keep the original cached value
    expect(state.gitRemote).toBe("github.com/org/original-repo");
  });

  test("does not set gitRemote when result has none", () => {
    const state = makeSessionState("/home/user/project");
    resolveSessionProjectPath(
      { path: "/home/user/project", source: "inferred" },
      state,
    );
    expect(state.gitRemote).toBeUndefined();
  });
});
