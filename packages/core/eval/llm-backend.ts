/**
 * LLM backend abstraction for the eval suite.
 *
 * Supports Anthropic (direct), GitHub Models API (free in CI), and
 * Azure OpenAI as backends. The harness and judge call `prompt()` on
 * the resolved backend without knowing which provider is active.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LLMBackendType = "anthropic" | "github-models" | "openai";

export interface BackendConfig {
  backend: LLMBackendType;
  model: string;
  judgeModel: string;
  apiKey: string;
  baseUrl: string;
}

export interface PromptOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** If true, parse the response as JSON. */
  json?: boolean;
}

export interface PromptResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface EvalLLMClient {
  prompt(
    system: string,
    user: string,
    opts?: PromptOptions,
  ): Promise<PromptResult>;
  readonly config: BackendConfig;
}

// ---------------------------------------------------------------------------
// Rate limiter (token-bucket with 429 backoff)
// ---------------------------------------------------------------------------

class RateLimiter {
  private queue: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private inflight = 0;
  private backoffUntil = 0;

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    // Honor backoff from 429 responses
    const now = Date.now();
    if (this.backoffUntil > now) {
      await new Promise((r) => setTimeout(r, this.backoffUntil - now));
    }

    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(): void {
    this.inflight--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.inflight++;
      // Add minimum interval between requests
      setTimeout(() => next.resolve(), this.minIntervalMs);
    }
  }

  backoff(retryAfterMs: number): void {
    this.backoffUntil = Date.now() + retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Resolve backend from environment
// ---------------------------------------------------------------------------

export function resolveBackend(overrides?: Partial<BackendConfig>): BackendConfig {
  // Anthropic direct — preferred when available (no daily limits, best quality)
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      backend: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: "https://api.anthropic.com",
      ...overrides,
    };
  }

  // OpenAI direct
  if (process.env.OPENAI_API_KEY) {
    return {
      backend: "openai",
      model: "gpt-4.1",
      judgeModel: "gpt-4.1",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com",
      ...overrides,
    };
  }

  // GitHub Models API — free fallback in CI (150 req/day for low-tier models)
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_TOKEN) {
    return {
      backend: "github-models",
      model: "openai/gpt-4o-mini",
      judgeModel: "openai/gpt-4o-mini",
      apiKey: process.env.GITHUB_TOKEN,
      baseUrl: "https://models.github.ai/inference",
      ...overrides,
    };
  }

  // No API key — fixture mode only
  return {
    backend: "anthropic",
    model: "claude-sonnet-4-6",
    judgeModel: "claude-sonnet-4-6",
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

async function promptAnthropic(
  config: BackendConfig,
  system: string,
  user: string,
  opts?: PromptOptions,
): Promise<PromptResult> {
  const model = opts?.model ?? config.model;
  const resp = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature ?? 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return {
    text,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client (GitHub Models, OpenAI, Azure)
// ---------------------------------------------------------------------------

async function promptOpenAI(
  config: BackendConfig,
  system: string,
  user: string,
  opts?: PromptOptions,
): Promise<PromptResult> {
  const model = opts?.model ?? config.model;

  // GitHub Models API uses /chat/completions path
  const url =
    config.backend === "github-models"
      ? `${config.baseUrl}/chat/completions`
      : `${config.baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };

  // GitHub Models API requires additional headers
  if (config.backend === "github-models") {
    headers["accept"] = "application/vnd.github+json";
    headers["x-github-api-version"] = "2022-11-28";
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  if (opts?.json) {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    // Log details for debugging in CI
    if (process.env.GITHUB_ACTIONS) {
      console.error(`  API error: ${resp.status} ${url} model=${model}`);
      console.error(`  Response: ${respBody.slice(0, 300)}`);
    }
    throw new Error(`OpenAI API error ${resp.status}: ${respBody.slice(0, 500)}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? "",
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
  };
}

// ---------------------------------------------------------------------------
// Create client
// ---------------------------------------------------------------------------

export function createEvalLLMClient(
  backendConfig?: BackendConfig,
): EvalLLMClient {
  const config = backendConfig ?? resolveBackend();

  // Rate limits: very conservative for GitHub Models, generous for direct API
  const limiter =
    config.backend === "github-models"
      ? new RateLimiter(1, 10_000) // ~6 req/min to stay well under limits
      : new RateLimiter(5, 200);

  const promptFn =
    config.backend === "anthropic" ? promptAnthropic : promptOpenAI;

  const MAX_RETRIES = 5;

  return {
    config,
    async prompt(
      system: string,
      user: string,
      opts?: PromptOptions,
    ): Promise<PromptResult> {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await limiter.acquire();
        try {
          const result = await promptFn(config, system, user, opts);
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          // Handle 429 responses
          if (lastError.message.includes("429")) {
            // Detect GitHub's anti-scraping / quota exhaustion page (HTML, not JSON).
            // This is NOT a transient rate limit — it means daily quota is exhausted
            // or the token lacks access. Retrying wastes quota.
            if (lastError.message.includes("scraping")) {
              throw new Error(
                "GitHub Models daily quota exhausted or access denied. " +
                  "The API returned GitHub's anti-scraping page instead of a JSON rate-limit error. " +
                  "Wait for daily quota reset or check your token's 'models' scope.",
              );
            }

            // Transient rate limit — retry with exponential backoff
            const backoffMs = Math.min(
              30_000 * Math.pow(2, attempt), // 30s, 60s, 120s, 240s, 480s
              600_000, // cap at 10 minutes
            );
            console.warn(
              `  Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), backing off ${Math.round(backoffMs / 1000)}s...`,
            );
            limiter.backoff(backoffMs);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          // Non-retryable error
          throw lastError;
        } finally {
          limiter.release();
        }
      }

      throw lastError ?? new Error("Max retries exceeded");
    },
  };
}
