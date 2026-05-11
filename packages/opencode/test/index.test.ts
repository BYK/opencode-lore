import { describe, test, expect } from "bun:test";
import { LorePlugin } from "../src/index";
import type { Plugin } from "@opencode-ai/plugin";

/**
 * Minimal mock of the OpenCode client. Only stubs the methods the plugin
 * actually calls during initialization.
 */
function createMockClient() {
  return {
    tui: {
      showToast: () => Promise.resolve(),
    },
    session: {
      get: () => Promise.resolve({ data: {} }),
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ data: { id: "worker_1" } }),
      messages: () => Promise.resolve({ data: [] }),
      message: () => Promise.resolve({ data: null }),
      prompt: () => Promise.resolve({ data: {} }),
    },
  } as unknown as Parameters<Exclude<Plugin, undefined>>[0]["client"];
}

/**
 * Initialize the plugin with a mock client and temp directory.
 * Returns the plugin hooks.
 */
async function initPlugin() {
  const client = createMockClient();
  const tmpDir = `${import.meta.dir}/__tmp_plugin_${Date.now()}__`;
  const { mkdirSync, rmSync } = await import("fs");
  mkdirSync(tmpDir, { recursive: true });

  const hooks = await LorePlugin({
    client,
    project: { id: "test", path: tmpDir } as any,
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:0"),
    $: {} as any,
  });

  return {
    hooks,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("LorePlugin config hook", () => {
  test("disables built-in compaction", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {};
      await hooks.config!(cfg);

      expect(cfg.compaction).toEqual({ auto: false, prune: false });
    } finally {
      cleanup();
    }
  });

  test("registers hidden worker agents", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {};
      await hooks.config!(cfg);

      const agents = cfg.agent as Record<string, { hidden: boolean; description: string }>;
      expect(agents["lore-distill"]).toEqual({
        hidden: true,
        description: "Lore memory distillation worker",
      });
      expect(agents["lore-curator"]).toEqual({
        hidden: true,
        description: "Lore knowledge curator worker",
      });
      expect(agents["lore-query-expand"]).toEqual({
        hidden: true,
        description: "Lore query expansion worker",
      });
    } finally {
      cleanup();
    }
  });

  test("preserves existing agent config", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {
        agent: { "my-agent": { hidden: false, description: "Custom" } },
      };
      await hooks.config!(cfg);

      const agents = cfg.agent as Record<string, unknown>;
      expect(agents["my-agent"]).toEqual({ hidden: false, description: "Custom" });
      expect(agents["lore-distill"]).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

describe("LorePlugin hooks", () => {
  test("returns an empty tool map", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      expect(hooks.tool).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("returns only config and tool hooks (no event/transform hooks)", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      expect(hooks.config).toBeDefined();
      expect(hooks.tool).toBeDefined();
      // All standalone-mode hooks should be stripped
      expect(hooks.event).toBeUndefined();
      expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
      expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
      expect(hooks["experimental.session.compacting"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
