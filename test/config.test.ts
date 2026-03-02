import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { load, LoreConfig } from "../src/config";

const TMP = join(import.meta.dir, "__tmp_config__");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("LoreConfig — agentsFile schema", () => {
  test("agentsFile defaults: enabled=true, path=AGENTS.md", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.agentsFile.enabled).toBe(true);
    expect(cfg.agentsFile.path).toBe("AGENTS.md");
  });

  test("agentsFile.enabled can be set to false", () => {
    const cfg = LoreConfig.parse({ agentsFile: { enabled: false } });
    expect(cfg.agentsFile.enabled).toBe(false);
    expect(cfg.agentsFile.path).toBe("AGENTS.md"); // path still defaults
  });

  test("agentsFile.path can be customised", () => {
    const cfg = LoreConfig.parse({ agentsFile: { path: "CLAUDE.md" } });
    expect(cfg.agentsFile.enabled).toBe(true);
    expect(cfg.agentsFile.path).toBe("CLAUDE.md");
  });

  test("agentsFile.path accepts nested paths", () => {
    const cfg = LoreConfig.parse({ agentsFile: { path: ".cursor/rules/lore.md" } });
    expect(cfg.agentsFile.path).toBe(".cursor/rules/lore.md");
  });

  test("agentsFile section is optional — omitting it uses defaults", () => {
    const cfg = LoreConfig.parse({ curator: { enabled: false } });
    expect(cfg.agentsFile.enabled).toBe(true);
    expect(cfg.agentsFile.path).toBe("AGENTS.md");
  });
});

describe("LoreConfig — knowledge schema", () => {
  test("knowledge defaults: enabled=true", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.knowledge.enabled).toBe(true);
  });

  test("knowledge.enabled can be set to false", () => {
    const cfg = LoreConfig.parse({ knowledge: { enabled: false } });
    expect(cfg.knowledge.enabled).toBe(false);
  });

  test("knowledge section is optional — omitting it uses defaults", () => {
    const cfg = LoreConfig.parse({ curator: { enabled: false } });
    expect(cfg.knowledge.enabled).toBe(true);
  });
});

describe("LoreConfig — curator schema", () => {
  test("curator defaults: enabled=true, onIdle=true, afterTurns=10, maxEntries=25", () => {
    const cfg = LoreConfig.parse({});
    expect(cfg.curator.enabled).toBe(true);
    expect(cfg.curator.onIdle).toBe(true);
    expect(cfg.curator.afterTurns).toBe(10);
    expect(cfg.curator.maxEntries).toBe(25);
  });

  test("curator.maxEntries can be customised", () => {
    const cfg = LoreConfig.parse({ curator: { maxEntries: 30 } });
    expect(cfg.curator.maxEntries).toBe(30);
  });

  test("curator.maxEntries minimum is 10", () => {
    expect(() => LoreConfig.parse({ curator: { maxEntries: 5 } })).toThrow();
  });
});

describe("load — reads config from .lore.json", () => {
  test("loads agentsFile.enabled=false from .lore.json", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, ".lore.json"),
      JSON.stringify({ agentsFile: { enabled: false } }),
      "utf8",
    );
    const cfg = await load(TMP);
    expect(cfg.agentsFile.enabled).toBe(false);
  });

  test("loads agentsFile.path from .lore.json", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, ".lore.json"),
      JSON.stringify({ agentsFile: { path: "CLAUDE.md" } }),
      "utf8",
    );
    const cfg = await load(TMP);
    expect(cfg.agentsFile.path).toBe("CLAUDE.md");
  });

  test("loads knowledge.enabled=false from .lore.json", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, ".lore.json"),
      JSON.stringify({ knowledge: { enabled: false } }),
      "utf8",
    );
    const cfg = await load(TMP);
    expect(cfg.knowledge.enabled).toBe(false);
  });

  test("falls back to defaults when no config file exists", async () => {
    mkdirSync(TMP, { recursive: true });
    const cfg = await load(TMP);
    expect(cfg.agentsFile.enabled).toBe(true);
    expect(cfg.agentsFile.path).toBe("AGENTS.md");
  });
});
