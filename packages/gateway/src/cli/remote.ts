/**
 * CLI remote helper — shared utilities for CLI commands that need to call
 * the remote gateway REST API when `LORE_REMOTE_URL` is set.
 */

import { getGitRemote, normalizeRemoteUrl } from "@loreai/core";

// ---------------------------------------------------------------------------
// Remote URL detection
// ---------------------------------------------------------------------------

/** Returns `LORE_REMOTE_URL` if set, undefined otherwise. */
export function getRemoteUrl(): string | undefined {
  const url = process.env.LORE_REMOTE_URL;
  return url ? url.replace(/\/+$/, "") : undefined;
}

// ---------------------------------------------------------------------------
// Project resolution for remote calls
// ---------------------------------------------------------------------------

/**
 * Resolve a local project path to query params for the remote API.
 * Computes `git_remote` locally (trusted FS) and prefers it over `path`.
 *
 * @returns Query string fragment like `git_remote=...` or `path=...`
 */
export function projectQueryParams(projectPath: string): string {
  const remote = getGitRemote(projectPath);
  if (remote) {
    const normalized = normalizeRemoteUrl(remote);
    return `git_remote=${encodeURIComponent(normalized ?? remote)}`;
  }
  return `path=${encodeURIComponent(projectPath)}`;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

class RemoteAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAPIError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  let body: unknown;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await res.json();
  } else {
    const text = await res.text();
    if (!res.ok) {
      throw new RemoteAPIError(res.status, "gateway_error", `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // Try JSON parse as fallback (some servers omit content-type)
    try {
      body = JSON.parse(text);
    } catch {
      throw new RemoteAPIError(res.status, "gateway_error", `Unexpected non-JSON response: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const err = (body as Record<string, unknown>)?.error as Record<string, string> | undefined;
    throw new RemoteAPIError(
      res.status,
      err?.type ?? "api_error",
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

/** GET request to remote gateway API. */
export async function remoteGet<T = unknown>(
  baseUrl: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  return handleResponse<T>(res);
}

/**
 * POST request to remote gateway API.
 * When `compress: true`, applies zstd compression and sets `Content-Encoding: zstd`.
 */
export async function remotePost<T = unknown>(
  baseUrl: string,
  path: string,
  body?: unknown,
  opts?: { compress?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    const json = JSON.stringify(body);
    if (opts?.compress) {
      headers["Content-Encoding"] = "zstd";
      payload = new Uint8Array(Bun.zstdCompressSync(Buffer.from(json)));
    } else {
      payload = json;
    }
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: payload,
  });
  return handleResponse<T>(res);
}

/** DELETE request to remote gateway API. */
export async function remoteDelete<T = unknown>(
  baseUrl: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  return handleResponse<T>(res);
}
