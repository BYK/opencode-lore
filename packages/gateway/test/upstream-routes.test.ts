import { describe, test, expect } from "bun:test";
import { resolveUpstreamRoute } from "../src/config";

// ---------------------------------------------------------------------------
// resolveUpstreamRoute
// ---------------------------------------------------------------------------

describe("resolveUpstreamRoute", () => {
  describe("Anthropic", () => {
    test("routes claude- models to Anthropic API", () => {
      const result = resolveUpstreamRoute("claude-sonnet-4-5");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.anthropic.com");
      expect(result!.protocol).toBe("anthropic");
    });
  });

  describe("OpenAI", () => {
    test("routes gpt- models to OpenAI API", () => {
      const result = resolveUpstreamRoute("gpt-4o");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.openai.com");
      expect(result!.protocol).toBe("openai");
    });

    test("routes o1- models to OpenAI API", () => {
      const result = resolveUpstreamRoute("o1-pro");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.openai.com");
      expect(result!.protocol).toBe("openai");
    });
  });

  describe("xAI", () => {
    test("routes grok- models to xAI API", () => {
      const result = resolveUpstreamRoute("grok-3-beta");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.x.ai");
      expect(result!.protocol).toBe("openai");
    });
  });

  describe("Mistral (direct)", () => {
    test("routes mistral- models to Mistral API", () => {
      const result = resolveUpstreamRoute("mistral-large-latest");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.mistral.ai");
      expect(result!.protocol).toBe("openai");
    });

    test("routes codestral- models to Mistral API", () => {
      const result = resolveUpstreamRoute("codestral-latest");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.mistral.ai");
      expect(result!.protocol).toBe("openai");
    });
  });

  describe("Google (direct)", () => {
    test("routes gemini- models to Google API", () => {
      const result = resolveUpstreamRoute("gemini-2.5-pro");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://generativelanguage.googleapis.com");
      expect(result!.protocol).toBe("openai");
    });
  });

  describe("DeepSeek", () => {
    test("routes deepseek- (dash) models to DeepSeek direct API", () => {
      const result = resolveUpstreamRoute("deepseek-v4-pro");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.deepseek.com");
      expect(result!.protocol).toBe("openai");
    });

    test("routes deepseek-chat to DeepSeek direct API", () => {
      const result = resolveUpstreamRoute("deepseek-chat");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.deepseek.com");
      expect(result!.protocol).toBe("openai");
    });

    test("routes deepseek-reasoner to DeepSeek direct API", () => {
      const result = resolveUpstreamRoute("deepseek-reasoner");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://api.deepseek.com");
      expect(result!.protocol).toBe("openai");
    });

    test("routes deepseek/ (slash) models to Nvidia NIM", () => {
      const result = resolveUpstreamRoute("deepseek/deepseek-r1");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://integrate.api.nvidia.com");
      expect(result!.protocol).toBe("openai");
    });
  });

  describe("Nvidia NIM (slash-prefix)", () => {
    test("routes nvidia/ models to Nvidia NIM", () => {
      const result = resolveUpstreamRoute("nvidia/llama-3.1-nemotron");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://integrate.api.nvidia.com");
    });

    test("routes meta/ models to Nvidia NIM", () => {
      const result = resolveUpstreamRoute("meta/llama-4-maverick");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://integrate.api.nvidia.com");
    });

    test("routes qwen/ models to Nvidia NIM", () => {
      const result = resolveUpstreamRoute("qwen/qwen3-235b-a22b");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://integrate.api.nvidia.com");
    });
  });

  describe("Unknown models", () => {
    test("returns null for unknown model prefix", () => {
      expect(resolveUpstreamRoute("llama-4-maverick")).toBeNull();
    });

    test("returns null for model without prefix", () => {
      expect(resolveUpstreamRoute("some-random-model")).toBeNull();
    });
  });
});
