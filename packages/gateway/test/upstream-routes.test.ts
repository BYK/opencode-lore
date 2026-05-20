import { describe, test, expect } from "bun:test";
import { resolveUpstreamRoute } from "../src/config";

// ---------------------------------------------------------------------------
// resolveUpstreamRoute
// ---------------------------------------------------------------------------

describe("resolveUpstreamRoute", () => {
  describe("Anthropic", () => {
    test("routes claude- models to Anthropic API", () => {
      expect(resolveUpstreamRoute("claude-sonnet-4-5")).toEqual({
        url: "https://api.anthropic.com",
        protocol: "anthropic",
      });
    });
  });

  describe("OpenAI", () => {
    test("routes gpt- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("gpt-4o")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o1- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o1-pro")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o3- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o3-mini")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o4- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o4-mini")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });
  });

  describe("xAI", () => {
    test("routes grok- models to xAI API", () => {
      expect(resolveUpstreamRoute("grok-3-beta")).toEqual({
        url: "https://api.x.ai",
        protocol: "openai",
      });
    });
  });

  describe("Mistral (direct)", () => {
    test("routes mistral- models to Mistral API", () => {
      expect(resolveUpstreamRoute("mistral-large-latest")).toEqual({
        url: "https://api.mistral.ai",
        protocol: "openai",
      });
    });

    test("routes codestral- models to Mistral API", () => {
      expect(resolveUpstreamRoute("codestral-latest")).toEqual({
        url: "https://api.mistral.ai",
        protocol: "openai",
      });
    });
  });

  describe("Google (direct)", () => {
    test("routes gemini- models to Google API", () => {
      expect(resolveUpstreamRoute("gemini-2.5-pro")).toEqual({
        url: "https://generativelanguage.googleapis.com",
        protocol: "openai",
      });
    });
  });

  describe("DeepSeek", () => {
    test("routes deepseek- (dash) models to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-v4-pro")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek-chat to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-chat")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek-reasoner to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-reasoner")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek/ (slash) models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("deepseek/deepseek-r1")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });
  });

  describe("Nvidia NIM (slash-prefix)", () => {
    test("routes nvidia/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("nvidia/llama-3.1-nemotron")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes meta/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("meta/llama-4-maverick")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes mistralai/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("mistralai/mistral-large")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes google/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("google/gemma-3")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes qwen/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("qwen/qwen3-235b-a22b")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
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
