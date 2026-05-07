/**
 * Gateway authentication: typed credentials, per-session registry, and
 * two-level lookup for background workers.
 *
 * Replaces the bare `lastSeenApiKey` string with a typed `AuthCredential`
 * that supports both API-key (`x-api-key`) and OAuth Bearer token
 * (`Authorization: Bearer`) authentication schemes.
 *
 * The per-session registry ensures background workers (distillation,
 * curation, batch queue) use the correct credential for their session
 * even when multiple clients are connected simultaneously.
 */

// ---------------------------------------------------------------------------
// AuthCredential type
// ---------------------------------------------------------------------------

/** Auth credential — either an API key or an OAuth bearer token. */
export type AuthCredential =
  | { scheme: "api-key"; value: string }
  | { scheme: "bearer"; value: string };

// ---------------------------------------------------------------------------
// Header extraction / formatting
// ---------------------------------------------------------------------------

/**
 * Extract auth from request headers.
 *
 * Prefers `x-api-key` (Anthropic SDK default), falls back to
 * `Authorization: Bearer` (OAuth / Claude Code subscriptions).
 * Returns `null` if neither is present.
 */
export function extractAuth(
  headers: Record<string, string>,
): AuthCredential | null {
  const apiKey = headers["x-api-key"] || headers["X-Api-Key"];
  if (apiKey) return { scheme: "api-key", value: apiKey };

  const authHeader =
    headers["authorization"] || headers["Authorization"];
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) return { scheme: "bearer", value: match[1] };
  }

  return null;
}

/**
 * Format credential as the appropriate HTTP header(s).
 *
 * - `api-key` → `{ "x-api-key": value }`
 * - `bearer`  → `{ "Authorization": "Bearer <value>" }`
 */
export function authHeaders(cred: AuthCredential): Record<string, string> {
  switch (cred.scheme) {
    case "api-key":
      return { "x-api-key": cred.value };
    case "bearer":
      return { Authorization: `Bearer ${cred.value}` };
  }
}

/**
 * Non-sensitive suffix for fingerprinting — last 8 chars of credential value.
 *
 * Used to differentiate sessions that share the same first message but use
 * different API keys or OAuth tokens. The suffix alone cannot reconstruct
 * the full credential.
 */
export function authFingerprint(cred: AuthCredential): string {
  return cred.value.slice(-8);
}

// ---------------------------------------------------------------------------
// Per-session registry
// ---------------------------------------------------------------------------

const sessionAuth = new Map<string, AuthCredential>();

export function setSessionAuth(
  sessionID: string,
  cred: AuthCredential,
): void {
  sessionAuth.set(sessionID, cred);
}

export function getSessionAuth(
  sessionID: string,
): AuthCredential | null {
  return sessionAuth.get(sessionID) ?? null;
}

/** Delete a session's credential (for future eviction). */
export function deleteSessionAuth(sessionID: string): void {
  sessionAuth.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Global fallback (replaces lastSeenApiKey)
// ---------------------------------------------------------------------------

let lastSeenAuth: AuthCredential | null = null;

export function setLastSeenAuth(cred: AuthCredential): void {
  lastSeenAuth = cred;
}

export function getLastSeenAuth(): AuthCredential | null {
  return lastSeenAuth;
}

// ---------------------------------------------------------------------------
// Two-level lookup
// ---------------------------------------------------------------------------

/**
 * Resolve auth credentials for a given session.
 *
 * 1. If `sessionID` is provided, check the per-session registry first.
 * 2. Fall back to the global `lastSeenAuth` (for cold-start or callers
 *    that don't pass a session ID).
 */
export function resolveAuth(
  sessionID?: string,
): AuthCredential | null {
  if (sessionID) {
    const cred = getSessionAuth(sessionID);
    if (cred) return cred;
  }
  return getLastSeenAuth();
}
