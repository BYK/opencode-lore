/**
 * Tests for hosted mode configuration defaults in startGateway().
 *
 * The override logic in startGateway() follows three-tier precedence:
 *   1. `opts.local` CLI flag (highest)
 *   2. `LORE_HOSTED_MODE` env var
 *   3. Caller default: `lore start` → hosted ON, `lore run` → hosted OFF
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config";
import type { StartOptions } from "../src/cli/start";
import type { GatewayConfig } from "../src/config";

/**
 * Replicate the hosted mode override logic from startGateway() so we can
 * test it without spinning up a real server.
 */
function applyHostedModeOverrides(config: GatewayConfig, opts: StartOptions): GatewayConfig {
  if (opts.local !== undefined) {
    config.hostedMode = !opts.local;
  } else if (!process.env.LORE_HOSTED_MODE) {
    config.hostedMode = true;
  }
  return config;
}

describe("hosted mode config defaults", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LORE_HOSTED_MODE;
    delete process.env.LORE_HOSTED_MODE;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LORE_HOSTED_MODE = savedEnv;
    } else {
      delete process.env.LORE_HOSTED_MODE;
    }
  });

  // -----------------------------------------------------------------------
  // loadConfig() — env var handling
  // -----------------------------------------------------------------------

  describe("loadConfig", () => {
    test("hostedMode is false when LORE_HOSTED_MODE is not set", () => {
      delete process.env.LORE_HOSTED_MODE;
      expect(loadConfig().hostedMode).toBe(false);
    });

    test("hostedMode is true when LORE_HOSTED_MODE=1", () => {
      process.env.LORE_HOSTED_MODE = "1";
      expect(loadConfig().hostedMode).toBe(true);
    });

    test("hostedMode is false when LORE_HOSTED_MODE=0", () => {
      process.env.LORE_HOSTED_MODE = "0";
      expect(loadConfig().hostedMode).toBe(false);
    });

    test("hostedMode is true when LORE_HOSTED_MODE=true", () => {
      process.env.LORE_HOSTED_MODE = "true";
      expect(loadConfig().hostedMode).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // startGateway override logic
  // -----------------------------------------------------------------------

  describe("startGateway override logic", () => {
    test("lore start (no opts.local, no env) defaults to hosted mode ON", () => {
      delete process.env.LORE_HOSTED_MODE;
      const config = applyHostedModeOverrides(loadConfig(), {});
      expect(config.hostedMode).toBe(true);
    });

    test("lore start --local forces hosted mode OFF", () => {
      delete process.env.LORE_HOSTED_MODE;
      const config = applyHostedModeOverrides(loadConfig(), { local: true });
      expect(config.hostedMode).toBe(false);
    });

    test("lore run (local: true) forces hosted mode OFF", () => {
      delete process.env.LORE_HOSTED_MODE;
      const config = applyHostedModeOverrides(loadConfig(), { local: true });
      expect(config.hostedMode).toBe(false);
    });

    test("--local overrides LORE_HOSTED_MODE=1", () => {
      process.env.LORE_HOSTED_MODE = "1";
      const config = applyHostedModeOverrides(loadConfig(), { local: true });
      expect(config.hostedMode).toBe(false);
    });

    test("LORE_HOSTED_MODE=0 overrides lore start default", () => {
      process.env.LORE_HOSTED_MODE = "0";
      const config = applyHostedModeOverrides(loadConfig(), {});
      expect(config.hostedMode).toBe(false);
    });

    test("LORE_HOSTED_MODE=1 with lore start (no --local) stays ON", () => {
      process.env.LORE_HOSTED_MODE = "1";
      const config = applyHostedModeOverrides(loadConfig(), {});
      expect(config.hostedMode).toBe(true);
    });

    test("local: false explicitly enables hosted mode", () => {
      delete process.env.LORE_HOSTED_MODE;
      const config = applyHostedModeOverrides(loadConfig(), { local: false });
      expect(config.hostedMode).toBe(true);
    });
  });
});
