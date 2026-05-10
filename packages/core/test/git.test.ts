import { describe, test, expect } from "bun:test";
import { normalizeRemoteUrl } from "../src/git";

describe("normalizeRemoteUrl", () => {
  test("normalizes SSH shorthand", () => {
    expect(normalizeRemoteUrl("git@github.com:user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTPS", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTPS without .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes SSH protocol URL", () => {
    expect(normalizeRemoteUrl("ssh://git@github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes git:// protocol", () => {
    expect(normalizeRemoteUrl("git://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTP", () => {
    expect(normalizeRemoteUrl("http://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("strips auth from HTTPS URL", () => {
    expect(
      normalizeRemoteUrl("https://user:token@github.com/user/repo.git"),
    ).toBe("github.com/user/repo");
  });

  test("lowercases host but preserves path case", () => {
    expect(normalizeRemoteUrl("git@GitHub.COM:User/MyRepo.git")).toBe(
      "github.com/User/MyRepo",
    );
  });

  test("strips trailing slashes", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo/")).toBe(
      "github.com/user/repo",
    );
  });

  test("handles GitLab SSH", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:org/project.git")).toBe(
      "gitlab.com/org/project",
    );
  });

  test("handles self-hosted with port in SSH protocol URL", () => {
    expect(
      normalizeRemoteUrl("ssh://git@git.example.com:2222/org/repo.git"),
    ).toBe("git.example.com:2222/org/repo");
  });

  test("handles nested paths (subgroups)", () => {
    expect(
      normalizeRemoteUrl("git@gitlab.com:org/subgroup/project.git"),
    ).toBe("gitlab.com/org/subgroup/project");
  });

  test("produces same result for SSH and HTTPS of same repo", () => {
    const ssh = normalizeRemoteUrl("git@github.com:user/repo.git");
    const https = normalizeRemoteUrl("https://github.com/user/repo.git");
    expect(ssh).toBe(https);
  });

  test("produces same result for git:// and HTTPS of same repo", () => {
    const git = normalizeRemoteUrl("git://github.com/user/repo.git");
    const https = normalizeRemoteUrl("https://github.com/user/repo.git");
    expect(git).toBe(https);
  });

  test("handles whitespace", () => {
    expect(normalizeRemoteUrl("  https://github.com/user/repo.git  ")).toBe(
      "github.com/user/repo",
    );
  });
});
