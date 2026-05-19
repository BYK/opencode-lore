/**
 * Dimension 2: Multi-Session Recall scenarios.
 *
 * Three scenarios testing whether Lore can recall information from previous
 * sessions in a multi-session workflow:
 *
 *   MSR-1  Sequential Feature Development (3 sessions, 20 questions)
 *   MSR-2  Deep History Recall            (5 sessions, 15 questions)
 *   MSR-3  Cross-Model Sessions           (2 sessions,  6 questions)
 */

import type {
  ScenarioDefinition,
  SessionTranscript,
  EvalQuestion,
  ConversationTurn,
  BaselineMode,
} from "../types";
import { RUBRICS } from "../judge";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const APPLICABLE_BASELINES: BaselineMode[] = [
  "lore",
  "lore-context-only",
  "lore-memory-only",
  "tail-window",
  "compaction",
  "auto-mem0",
];

let toolId = 0;
function tid(): string {
  return `toolu_eval_msr_${String(++toolId).padStart(4, "0")}`;
}

/** Shorthand: plain text content part. */
function text(t: string): ConversationTurn {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}

function userText(t: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text: t }] };
}

/** Assistant turn that invokes a tool. */
function toolCall(
  name: string,
  input: unknown,
  preamble?: string,
): { turn: ConversationTurn; id: string } {
  const id = tid();
  const parts: ConversationTurn["content"] = [];
  if (preamble) parts.push({ type: "text", text: preamble });
  parts.push({ type: "tool_use", id, name, input });
  return { turn: { role: "assistant", content: parts }, id };
}

/** User turn carrying a tool_result. */
function toolResult(
  toolUseId: string,
  output: string,
  isError = false,
): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
}

/** Assign timestamps across turns starting from `base`, spacing by `gapMs`. */
function stamp(
  turns: ConversationTurn[],
  base: number,
  gapMs = 90_000,
): ConversationTurn[] {
  return turns.map((t, i) => ({ ...t, timestamp: base + i * gapMs }));
}

/** Assign token estimates to turns (rough: chars/4). */
function estimateTokens(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.map((t) => {
    const chars = t.content.reduce((s, p) => {
      if (p.type === "text") return s + p.text.length;
      if (p.type === "tool_result") return s + p.content.length;
      if (p.type === "tool_use") return s + JSON.stringify(p.input).length + 40;
      return s;
    }, 0);
    return { ...t, tokens: t.tokens ?? Math.max(50, Math.ceil(chars / 4)) };
  });
}

// =========================================================================
// MSR-1: Sequential Feature Development (3 sessions)
// =========================================================================

const MSR1_PROJECT = "/tmp/eval-project-msr1";

// --- Session 1: Implement user authentication (~15 turns) ----------------

const DAY1 = Date.parse("2025-05-12T09:00:00Z");

const s1t1 = toolCall("bash", { command: "mkdir -p src/auth && ls src/" }, "Let me start by setting up the auth module directory structure.");
const s1t2 = toolCall("write", { path: "src/auth/jwt.ts", content: "import jwt from 'jsonwebtoken';\nimport { JWT_SECRET, JWT_EXPIRY } from '../config';\n\nexport function signToken(userId: string): string {\n  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });\n}\n\nexport function verifyToken(token: string): { sub: string } {\n  return jwt.verify(token, JWT_SECRET) as { sub: string };\n}\n" }, "I'll create the JWT utility. We're choosing JWT over session cookies because the API is consumed by both the web frontend and a mobile app — stateless tokens avoid server-side session storage and work well with the existing CDN setup.");
const s1t3 = toolCall("write", { path: "src/auth/password.ts", content: "import bcrypt from 'bcrypt';\n\nconst SALT_ROUNDS = 12;\n\nexport async function hashPassword(plain: string): Promise<string> {\n  return bcrypt.hash(plain, SALT_ROUNDS);\n}\n\nexport async function comparePassword(plain: string, hash: string): Promise<boolean> {\n  return bcrypt.compare(plain, hash);\n}\n" }, "For password hashing I'm using bcrypt with 12 salt rounds. Argon2 was considered but bcrypt has better library support in our current Node 20 setup.");
const s1t4 = toolCall("write", { path: "src/auth/middleware.ts", content: "import { verifyToken } from './jwt';\nimport type { Request, Response, NextFunction } from 'express';\n\nexport function requireAuth(req: Request, res: Response, next: NextFunction) {\n  const header = req.headers.authorization;\n  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });\n  try {\n    const payload = verifyToken(header.slice(7));\n    (req as any).userId = payload.sub;\n    next();\n  } catch {\n    res.status(401).json({ error: 'Invalid or expired token' });\n  }\n}\n" });
const s1t5 = toolCall("write", { path: "src/auth/rate-limiter.ts", content: "import rateLimit from 'express-rate-limit';\n\nexport const loginRateLimiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 5,\n  keyGenerator: (req) => req.ip,\n  message: { error: 'Too many login attempts, please try again in 15 minutes' },\n});\n" }, "Adding a rate limiter for the login endpoint — 5 attempts per 15 minutes.");
const s1t6 = toolCall("write", { path: "src/auth/routes.ts", content: "import { Router } from 'express';\nimport { hashPassword, comparePassword } from './password';\nimport { signToken } from './jwt';\nimport { loginRateLimiter } from './rate-limiter';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.post('/register', async (req, res) => {\n  const { email, password } = req.body;\n  const hashed = await hashPassword(password);\n  const user = await db.user.create({ data: { email, passwordHash: hashed } });\n  res.status(201).json({ id: user.id, email: user.email });\n});\n\nrouter.post('/login', loginRateLimiter, async (req, res) => {\n  const { email, password } = req.body;\n  const user = await db.user.findUnique({ where: { email } });\n  if (!user || !(await comparePassword(password, user.passwordHash))) {\n    return res.status(401).json({ error: 'Invalid credentials' });\n  }\n  const token = signToken(user.id);\n  res.json({ token, expiresIn: '24h' });\n});\n\nexport default router;\n" });
const s1t7 = toolCall("bash", { command: "npx jest tests/auth/ --verbose" });

const msr1Session1Turns: ConversationTurn[] = estimateTokens(stamp([
  // Turn 0: user request
  userText("I need to implement user authentication for our Express API. We need registration, login, and protected route middleware. The API is used by both a React web app and our React Native mobile app."),
  // Turn 1: assistant creates dir
  s1t1.turn,
  toolResult(s1t1.id, "auth/\ndb.ts\nconfig.ts\nindex.ts\nroutes/"),
  // Turn 2: assistant creates JWT
  s1t2.turn,
  toolResult(s1t2.id, "File written: src/auth/jwt.ts"),
  // Turn 3: assistant creates password module
  s1t3.turn,
  toolResult(s1t3.id, "File written: src/auth/password.ts"),
  // Turn 4: user asks about middleware
  userText("Good. Now we need middleware to protect routes."),
  // Turn 5: assistant creates middleware
  s1t4.turn,
  toolResult(s1t4.id, "File written: src/auth/middleware.ts"),
  // Turn 6: user asks about rate limiting
  userText("We should add rate limiting to the login endpoint to prevent brute force attacks."),
  // Turn 7: assistant creates rate limiter
  s1t5.turn,
  toolResult(s1t5.id, "File written: src/auth/rate-limiter.ts"),
  // Turn 8: assistant creates routes
  text("Now let me wire up the routes with the rate limiter."),
  s1t6.turn,
  toolResult(s1t6.id, "File written: src/auth/routes.ts"),
  // Turn 9: user asks to run tests
  userText("Let's run the auth tests to see where we stand."),
  // Turn 10: assistant runs tests
  s1t7.turn,
  toolResult(s1t7.id, "PASS tests/auth/jwt.test.ts\n  ✓ signToken returns a valid JWT (12ms)\n  ✓ verifyToken decodes correctly (3ms)\n  ✓ verifyToken rejects expired tokens (2ms)\nPASS tests/auth/password.test.ts\n  ✓ hashPassword produces bcrypt hash (89ms)\n  ✓ comparePassword matches correctly (85ms)\nFAIL tests/auth/rate-limiter.test.ts\n  ✗ blocks after 5 attempts (45ms)\n    Expected: 429\n    Received: 200\n    The rate limiter is keyed by req.ip but the test uses supertest which\n    sets req.ip to '::ffff:127.0.0.1' — the limiter counts by IP so all\n    test requests share the same counter, but the counter resets between\n    test files because the express app is re-created.\n\nTests: 5 passed, 1 failed, 6 total"),
  // Turn 11: user notes the bug
  userText("Interesting — the rate limiter is counting by IP address instead of by user. In production, many users could be behind the same NAT. We should key it by the email in the request body."),
  // Turn 12: assistant discusses fix
  text("You're right — that's a real bug. The rate limiter should use `req.body.email` as the key instead of `req.ip`. This way each account gets its own counter. Let me fix that."),
  (() => {
    const c = toolCall("edit", { path: "src/auth/rate-limiter.ts", old: "keyGenerator: (req) => req.ip", new: "keyGenerator: (req) => req.body?.email ?? req.ip" });
    return c.turn;
  })(),
  toolResult(tid(), "File edited: src/auth/rate-limiter.ts"),
  // Turn 13: user mentions auth directory structure
  userText("Great. Let me also note: the five auth files we created are jwt.ts, password.ts, middleware.ts, rate-limiter.ts, and routes.ts — all under src/auth/. Can you confirm?"),
  // Turn 14: assistant confirms
  text("Confirmed. The `src/auth/` directory now contains these five files:\n1. `jwt.ts` — JWT sign/verify using jsonwebtoken\n2. `password.ts` — bcrypt hashing with 12 salt rounds\n3. `middleware.ts` — Express middleware extracting Bearer token\n4. `rate-limiter.ts` — express-rate-limit keyed by email (just fixed from IP)\n5. `routes.ts` — /register and /login endpoints\n\nThe JWT tokens expire after 24 hours as configured in `JWT_EXPIRY`."),
], DAY1));

const msr1Session1: SessionTranscript = {
  id: "msr1-session-1",
  label: "Implement user authentication",
  projectPath: MSR1_PROJECT,
  turns: msr1Session1Turns,
  metadata: {
    totalTokens: msr1Session1Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "Initial auth implementation: JWT, bcrypt, rate limiter, routes. " +
      "Key decisions: JWT over session cookies (multi-client), bcrypt over argon2, " +
      "rate limiter bug discovered (IP-based → email-based).",
  },
};

// --- Session 2: Add OAuth2 support (~12 turns) ---------------------------

const DAY2 = Date.parse("2025-05-13T10:00:00Z");

const s2t1 = toolCall("read", { path: "src/auth/routes.ts" }, "Let me review the existing auth routes before adding OAuth2 support.");
const s2t2 = toolCall("write", { path: "src/auth/oauth-config.ts", content: "export const OAUTH_PROVIDERS = {\n  google: {\n    clientId: process.env.GOOGLE_CLIENT_ID!,\n    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,\n    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',\n    tokenUrl: 'https://oauth2.googleapis.com/token',\n    callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:3000/auth/google/callback',\n    scopes: ['openid', 'email', 'profile'],\n  },\n  github: {\n    clientId: process.env.GITHUB_CLIENT_ID!,\n    clientSecret: process.env.GITHUB_CLIENT_SECRET!,\n    authUrl: 'https://github.com/login/oauth/authorize',\n    tokenUrl: 'https://github.com/login/oauth/access_token',\n    callbackUrl: process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3000/auth/github/callback',\n    scopes: ['user:email'],\n  },\n} as const;\n\nexport type OAuthProvider = keyof typeof OAUTH_PROVIDERS;\n" }, "I'll set up the OAuth provider configuration. We're supporting Google and GitHub initially.");
const s2t3 = toolCall("write", { path: "src/auth/oauth-pkce.ts", content: "import crypto from 'node:crypto';\n\nexport function generateCodeVerifier(): string {\n  return crypto.randomBytes(32).toString('base64url');\n}\n\nexport function generateCodeChallenge(verifier: string): string {\n  return crypto.createHash('sha256').update(verifier).digest('base64url');\n}\n\nexport interface PKCEPair {\n  codeVerifier: string;\n  codeChallenge: string;\n  method: 'S256';\n}\n\nexport function createPKCEPair(): PKCEPair {\n  const codeVerifier = generateCodeVerifier();\n  return {\n    codeVerifier,\n    codeChallenge: generateCodeChallenge(codeVerifier),\n    method: 'S256',\n  };\n}\n" }, "We're using PKCE (Proof Key for Code Exchange) instead of the implicit grant flow. PKCE is required for public clients (our mobile app) and is recommended even for server-side apps since 2021. The implicit grant is deprecated in OAuth 2.1.");
const s2t4 = toolCall("write", { path: "src/auth/oauth-routes.ts", content: "import { Router } from 'express';\nimport { OAUTH_PROVIDERS, OAuthProvider } from './oauth-config';\nimport { createPKCEPair } from './oauth-pkce';\nimport { signToken } from './jwt';\nimport { db } from '../db';\n\nconst router = Router();\nconst pendingPKCE = new Map<string, string>();\n\nrouter.get('/oauth/:provider/authorize', (req, res) => {\n  const provider = req.params.provider as OAuthProvider;\n  const config = OAUTH_PROVIDERS[provider];\n  if (!config) return res.status(400).json({ error: 'Unknown provider' });\n\n  const pkce = createPKCEPair();\n  const state = crypto.randomUUID();\n  pendingPKCE.set(state, pkce.codeVerifier);\n\n  const params = new URLSearchParams({\n    client_id: config.clientId,\n    redirect_uri: config.callbackUrl,\n    response_type: 'code',\n    scope: config.scopes.join(' '),\n    state,\n    code_challenge: pkce.codeChallenge,\n    code_challenge_method: pkce.method,\n  });\n\n  res.redirect(`${config.authUrl}?${params}`);\n});\n\nrouter.get('/oauth/:provider/callback', async (req, res) => {\n  const provider = req.params.provider as OAuthProvider;\n  const config = OAUTH_PROVIDERS[provider];\n  const { code, state } = req.query as { code: string; state: string };\n\n  const codeVerifier = pendingPKCE.get(state);\n  if (!codeVerifier) return res.status(400).json({ error: 'Invalid state' });\n  pendingPKCE.delete(state);\n\n  const tokenRes = await fetch(config.tokenUrl, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },\n    body: new URLSearchParams({\n      grant_type: 'authorization_code',\n      code,\n      redirect_uri: config.callbackUrl,\n      client_id: config.clientId,\n      client_secret: config.clientSecret,\n      code_verifier: codeVerifier,\n    }),\n  });\n\n  const tokens = await tokenRes.json();\n  // ... extract user info, upsert user, return JWT\n  const user = await db.user.upsert({\n    where: { email: '...' },\n    create: { email: '...', oauthProvider: provider },\n    update: { oauthProvider: provider },\n  });\n  const jwt = signToken(user.id);\n  res.json({ token: jwt, expiresIn: '24h' });\n});\n\nexport default router;\n" });
const s2t5 = toolCall("write", { path: "src/auth/token-refresh.ts", content: "import { signToken, verifyToken } from './jwt';\nimport { db } from '../db';\n\nconst REFRESH_TOKEN_EXPIRY = '7d';\nconst REFRESH_WINDOW_MS = 60 * 60 * 1000; // 1 hour before expiry\n\nexport async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {\n  const stored = await db.refreshToken.findUnique({ where: { token: refreshToken } });\n  if (!stored || stored.revokedAt) throw new Error('Invalid refresh token');\n  if (stored.expiresAt < new Date()) throw new Error('Refresh token expired');\n\n  const accessToken = signToken(stored.userId);\n  const newRefresh = crypto.randomUUID();\n\n  await db.$transaction([\n    db.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),\n    db.refreshToken.create({ data: { token: newRefresh, userId: stored.userId, expiresAt: new Date(Date.now() + 7 * 86400000) } }),\n  ]);\n\n  return { accessToken, refreshToken: newRefresh };\n}\n" }, "Token refresh logic: refresh tokens are stored in the database, valid for 7 days, and rotated on each use (the old token is revoked).");

const s2t6 = toolCall("bash", { command: "npx jest tests/auth/oauth --verbose" });

const msr1Session2Turns: ConversationTurn[] = estimateTokens(stamp([
  // Turn 0
  userText("We need to add OAuth2 support to the auth system we built yesterday. Users should be able to sign in with Google and GitHub. The mobile app needs this especially."),
  // Turn 1
  s2t1.turn,
  toolResult(s2t1.id, "import { Router } from 'express';\nimport { hashPassword, comparePassword } from './password';\nimport { signToken } from './jwt';\nimport { loginRateLimiter } from './rate-limiter';\nimport { db } from '../db';\n\nconst router = Router();\n\nrouter.post('/register', async (req, res) => { ... });\nrouter.post('/login', loginRateLimiter, async (req, res) => { ... });\n\nexport default router;"),
  // Turn 2
  s2t2.turn,
  toolResult(s2t2.id, "File written: src/auth/oauth-config.ts"),
  // Turn 3: user asks about flow choice
  userText("Why PKCE instead of the standard implicit grant? We're a server-side app."),
  // Turn 4
  s2t3.turn,
  toolResult(s2t3.id, "File written: src/auth/oauth-pkce.ts"),
  // Turn 5
  text("Good question. Even though our backend is server-side, we're choosing PKCE for three reasons:\n1. The mobile app is a public client — PKCE is mandatory for public clients\n2. Implicit grant is deprecated in OAuth 2.1\n3. Using the same flow everywhere simplifies the codebase"),
  // Turn 6: routes
  s2t4.turn,
  toolResult(s2t4.id, "File written: src/auth/oauth-routes.ts"),
  // Turn 7: user asks about callback URLs
  userText("What callback URLs are we using?"),
  // Turn 8: assistant explains
  text("The callback URLs are configured per provider in `src/auth/oauth-config.ts`:\n- Google: `http://localhost:3000/auth/google/callback` (overridable via `GOOGLE_CALLBACK_URL` env var)\n- GitHub: `http://localhost:3000/auth/github/callback` (overridable via `GITHUB_CALLBACK_URL` env var)\n\nIn production, these should be set to `https://api.ourapp.com/auth/{provider}/callback`."),
  // Turn 9: token refresh
  userText("We also need refresh token support. The access token should stay short-lived but users shouldn't have to re-login constantly."),
  // Turn 10
  s2t5.turn,
  toolResult(s2t5.id, "File written: src/auth/token-refresh.ts"),
  // Turn 11: run tests
  userText("Let's run the OAuth tests."),
  // Turn 12
  s2t6.turn,
  toolResult(s2t6.id, "PASS tests/auth/oauth/pkce.test.ts\n  ✓ generates valid code verifier (2ms)\n  ✓ code challenge is SHA256 of verifier (1ms)\n  ✓ PKCE pair has S256 method (1ms)\nPASS tests/auth/oauth/routes.test.ts\n  ✓ redirects to provider auth URL with PKCE params (8ms)\n  ✓ exchanges code for token on callback (15ms)\n  ✓ rejects invalid state parameter (3ms)\n  ✓ rejects unknown provider (2ms)\nPASS tests/auth/oauth/refresh.test.ts\n  ✓ rotates refresh token on use (12ms)\n  ✓ rejects revoked refresh token (3ms)\n  ✓ rejects expired refresh token (2ms)\n\nTests: 10 passed, 0 failed, 10 total"),
  // Turn 13: user notes the file count
  userText("Nice, all passing. So we've added oauth-config.ts, oauth-pkce.ts, oauth-routes.ts, and token-refresh.ts. The auth module is getting big."),
  // Turn 14: assistant wraps up
  text("Yes, the `src/auth/` directory now has 9 files total:\n- Original 5: jwt.ts, password.ts, middleware.ts, rate-limiter.ts, routes.ts\n- New 4: oauth-config.ts, oauth-pkce.ts, oauth-routes.ts, token-refresh.ts\n\nRefresh tokens are stored in the DB with 7-day expiry and single-use rotation."),
], DAY2));

const msr1Session2: SessionTranscript = {
  id: "msr1-session-2",
  label: "Add OAuth2 support",
  projectPath: MSR1_PROJECT,
  turns: msr1Session2Turns,
  metadata: {
    totalTokens: msr1Session2Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "OAuth2 with PKCE for Google & GitHub. Callback URLs configured per provider. " +
      "Token refresh with 7-day expiry and rotation. PKCE chosen over implicit grant " +
      "(public client requirement + OAuth 2.1 deprecation).",
  },
};

// --- Session 3: Fix auth regression (~10 turns) --------------------------

const DAY3 = Date.parse("2025-05-15T14:00:00Z");

const s3t1 = toolCall("bash", { command: "npx jest tests/auth/ --verbose 2>&1 | tail -30" }, "Let me run the auth test suite to see the failure.");
const s3t2 = toolCall("read", { path: "src/auth/rate-limiter.ts" });
const s3t3 = toolCall("read", { path: "src/auth/oauth-routes.ts" });
const s3t4 = toolCall("edit", { path: "src/auth/rate-limiter.ts", old: "keyGenerator: (req) => req.body?.email ?? req.ip", new: "keyGenerator: (req) => {\n    // Skip rate limiting for OAuth callback requests (no email body)\n    if (req.path.startsWith('/auth/oauth/')) return `oauth:${req.ip}`;\n    return req.body?.email ?? req.ip;\n  }" }, "The fix: OAuth callback requests don't have an email in the body, so the rate limiter falls back to IP — and since the OAuth provider's server makes the callback, all callbacks share one IP counter.");
const s3t5 = toolCall("write", { path: "tests/auth/rate-limiter-oauth.test.ts", content: "import { describe, it, expect } from '@jest/globals';\nimport request from 'supertest';\nimport { createApp } from '../../src/app';\n\ndescribe('rate limiter + OAuth interaction', () => {\n  it('does not count OAuth callbacks against login rate limit', async () => {\n    const app = createApp();\n    // Simulate 5 OAuth callbacks\n    for (let i = 0; i < 5; i++) {\n      await request(app).get('/auth/oauth/google/callback?code=test&state=test');\n    }\n    // Login should still work (not rate-limited)\n    const res = await request(app).post('/auth/login').send({ email: 'user@test.com', password: 'pass' });\n    expect(res.status).not.toBe(429);\n  });\n\n  it('still rate-limits login attempts by email', async () => {\n    const app = createApp();\n    for (let i = 0; i < 6; i++) {\n      await request(app).post('/auth/login').send({ email: 'brute@test.com', password: 'wrong' });\n    }\n    const res = await request(app).post('/auth/login').send({ email: 'brute@test.com', password: 'wrong' });\n    expect(res.status).toBe(429);\n  });\n});\n" });
const s3t6 = toolCall("bash", { command: "npx jest tests/auth/ --verbose 2>&1 | tail -20" });

const msr1Session3Turns: ConversationTurn[] = estimateTokens(stamp([
  // Turn 0
  userText("We have a regression in auth after the OAuth merge. Users are reporting they get rate-limited when trying to log in with email/password after other users do OAuth logins. The error is 'Too many login attempts, please try again in 15 minutes'."),
  // Turn 1
  s3t1.turn,
  toolResult(s3t1.id, "PASS tests/auth/jwt.test.ts (3 tests)\nPASS tests/auth/password.test.ts (2 tests)\nPASS tests/auth/rate-limiter.test.ts (1 test)\nPASS tests/auth/oauth/pkce.test.ts (3 tests)\nPASS tests/auth/oauth/routes.test.ts (4 tests)\nPASS tests/auth/oauth/refresh.test.ts (3 tests)\n\nTests: 16 passed, 0 failed, 16 total\n\nNote: all tests pass in isolation but the rate limiter\ninteraction isn't covered."),
  // Turn 2
  text("All tests pass individually, but we don't have a test that exercises the rate limiter together with OAuth callbacks. Let me look at the rate limiter code."),
  // Turn 3
  s3t2.turn,
  toolResult(s3t2.id, "import rateLimit from 'express-rate-limit';\n\nexport const loginRateLimiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 5,\n  keyGenerator: (req) => req.body?.email ?? req.ip,\n  message: { error: 'Too many login attempts, please try again in 15 minutes' },\n});"),
  // Turn 4
  s3t3.turn,
  toolResult(s3t3.id, "import { Router } from 'express';\nimport { OAUTH_PROVIDERS, OAuthProvider } from './oauth-config';\nimport { createPKCEPair } from './oauth-pkce';\n...\nrouter.get('/oauth/:provider/callback', async (req, res) => {\n  ...\n});"),
  // Turn 5: assistant explains root cause
  text("Found it! Here's the bug:\n\n1. In session 1, we fixed the rate limiter to key by `req.body?.email ?? req.ip` instead of just `req.ip`\n2. OAuth callback requests (GET `/auth/:provider/callback`) don't have a body — `req.body` is undefined\n3. So the rate limiter falls back to `req.ip` for OAuth callbacks\n4. The OAuth provider's servers all come from a small set of IPs\n5. After 5 OAuth callbacks from Google's servers, ALL requests from that IP get rate-limited\n6. If our server and any users share infrastructure (or the fallback IP is the same), login requests also get blocked\n\nThe root cause is the interaction between the session-1 rate limiter fix (email-based keying with IP fallback) and the session-2 OAuth callback routes (which hit the rate limiter with no email, triggering the IP fallback)."),
  // Turn 6: fix
  s3t4.turn,
  toolResult(s3t4.id, "File edited: src/auth/rate-limiter.ts"),
  // Turn 7: write test
  userText("Good analysis. Can you write a test that specifically covers this interaction?"),
  // Turn 8
  s3t5.turn,
  toolResult(s3t5.id, "File written: tests/auth/rate-limiter-oauth.test.ts"),
  // Turn 9: run final tests
  s3t6.turn,
  toolResult(s3t6.id, "PASS tests/auth/rate-limiter-oauth.test.ts\n  ✓ does not count OAuth callbacks against login rate limit (23ms)\n  ✓ still rate-limits login attempts by email (18ms)\nPASS tests/auth/jwt.test.ts (3 tests)\nPASS tests/auth/password.test.ts (2 tests)\nPASS tests/auth/rate-limiter.test.ts (1 test)\nPASS tests/auth/oauth/pkce.test.ts (3 tests)\nPASS tests/auth/oauth/routes.test.ts (4 tests)\nPASS tests/auth/oauth/refresh.test.ts (3 tests)\n\nTests: 18 passed, 0 failed, 18 total"),
  // Turn 10: wrap up
  text("All 18 tests pass. The regression was caused by the rate limiter's IP fallback being triggered by OAuth callbacks that lack an email body. The fix adds a path check to use a separate `oauth:` prefix key for OAuth routes, keeping them in their own rate-limit bucket."),
], DAY3));

const msr1Session3: SessionTranscript = {
  id: "msr1-session-3",
  label: "Fix auth regression after OAuth merge",
  projectPath: MSR1_PROJECT,
  turns: msr1Session3Turns,
  metadata: {
    totalTokens: msr1Session3Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "Auth regression: rate limiter IP fallback triggered by OAuth callbacks. " +
      "Root cause spans session 1 (rate limiter email-key fix) and session 2 " +
      "(OAuth callback routes with no email body). Fixed with path-based exemption.",
  },
};

// --- MSR-1 Questions (12) ------------------------------------------------

const msr1Questions: EvalQuestion[] = [
  // Within-session (session 3 facts) — easy
  {
    id: "msr1-q1",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-3",
    question: "What was the specific regression symptom reported by users?",
    referenceAnswer:
      "Users were getting rate-limited when trying to log in with email/password after other users did OAuth logins. They received the error 'Too many login attempts, please try again in 15 minutes'.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 0, difficulty: "easy", tags: ["error-message", "regression"] },
  },
  {
    id: "msr1-q2",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-3",
    question: "What test file was created to cover the rate limiter and OAuth interaction?",
    referenceAnswer:
      "tests/auth/rate-limiter-oauth.test.ts — it has two test cases: one verifying OAuth callbacks don't count against login rate limits, and one verifying login attempts are still rate-limited by email.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 8, difficulty: "easy", tags: ["file-path", "test"] },
  },
  // Cross-session (session 1 → session 3) — medium
  {
    id: "msr1-q3",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "In the original auth implementation, why was JWT chosen over session cookies?",
    referenceAnswer:
      "JWT was chosen because the API is consumed by both a React web frontend and a React Native mobile app. Stateless tokens avoid server-side session storage and work well with the existing CDN setup.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 2, difficulty: "medium", tags: ["decision-rationale"] },
  },
  {
    id: "msr1-q4",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "What was the rate limiter bug found in the first auth session?",
    referenceAnswer:
      "The rate limiter was keyed by req.ip instead of by user (req.body.email). This meant all users behind the same NAT would share a rate limit counter. It was fixed to use req.body?.email ?? req.ip as the key.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 11, difficulty: "medium", tags: ["bug", "rate-limiter"] },
  },
  {
    id: "msr1-q5",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "What password hashing algorithm was chosen and what file contains the implementation?",
    referenceAnswer:
      "bcrypt with 12 salt rounds, implemented in src/auth/password.ts. Argon2 was considered but rejected due to better library support for bcrypt in the Node 20 setup.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 3, difficulty: "medium", tags: ["decision-rationale", "file-path"] },
  },
  // Cross-session (session 2 → session 3) — medium
  {
    id: "msr1-q6",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "Why was PKCE chosen over implicit grant for the OAuth flow?",
    referenceAnswer:
      "PKCE was chosen for three reasons: (1) the mobile app is a public client where PKCE is mandatory, (2) implicit grant is deprecated in OAuth 2.1, and (3) using the same flow for both web and mobile simplifies the codebase.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 4, difficulty: "medium", tags: ["decision-rationale", "oauth"] },
  },
  {
    id: "msr1-q7",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "What are the configured OAuth callback URLs for Google and GitHub?",
    referenceAnswer:
      "Google: http://localhost:3000/auth/google/callback (overridable via GOOGLE_CALLBACK_URL env var). GitHub: http://localhost:3000/auth/github/callback (overridable via GITHUB_CALLBACK_URL env var). In production they should be https://api.ourapp.com/auth/{provider}/callback.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 8, difficulty: "medium", tags: ["config-value", "oauth"] },
  },
  {
    id: "msr1-q8",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "How does the refresh token system work?",
    referenceAnswer:
      "Refresh tokens are stored in the database with a 7-day expiry. On each use, the old refresh token is revoked and a new one is created (single-use rotation). This is implemented in src/auth/token-refresh.ts.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 10, difficulty: "medium", tags: ["architecture", "token"] },
  },
  // Hard: cross-session recall of specific details
  {
    id: "msr1-q9",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "How many auth files were in the src/auth/ directory after the first session, and what were they?",
    referenceAnswer:
      "Five files: jwt.ts, password.ts, middleware.ts, rate-limiter.ts, and routes.ts.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 14, difficulty: "hard", tags: ["file-path", "enumeration"] },
  },
  {
    id: "msr1-q10",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "How many tests were passing at the end of the first auth session?",
    referenceAnswer:
      "5 passed and 1 failed initially (the rate limiter test). After fixing the rate limiter key from req.ip to req.body.email, the final count is not re-run in session 1 — the last shown result is 5 passed, 1 failed, 6 total.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 10, difficulty: "hard", tags: ["number", "test-result"] },
  },
  // Synthesis — hard
  {
    id: "msr1-q11",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1,msr1-session-2,msr1-session-3",
    question: "How does the rate limiter bug from session 1 relate to the OAuth regression in session 3?",
    referenceAnswer:
      "In session 1, the rate limiter was fixed from IP-based to email-based keying (req.body?.email ?? req.ip). In session 2, OAuth callback routes were added that don't have a request body. In session 3, the regression was discovered: OAuth callbacks fall back to the IP key because req.body is undefined, causing callbacks from OAuth provider servers to consume the IP-based rate limit counter, which then blocks legitimate login requests sharing that IP.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { difficulty: "hard", tags: ["synthesis", "cross-session"] },
  },
  {
    id: "msr1-q12",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1,msr1-session-2,msr1-session-3",
    question: "Describe the complete authentication flow of the system, combining both JWT/password and OAuth paths.",
    referenceAnswer:
      "The system supports two auth paths: (1) Email/password: POST /register creates a user with bcrypt-hashed password (12 rounds), POST /login validates credentials via bcrypt.compare, returns a signed JWT (24h expiry). Login is rate-limited by email (5 attempts per 15 min). (2) OAuth: GET /auth/:provider/authorize redirects to Google/GitHub with PKCE challenge, provider calls back to /auth/:provider/callback with auth code, server exchanges code+verifier for tokens, upserts user, returns JWT. Both paths share the JWT system (signToken/verifyToken from jwt.ts). Refresh tokens (7-day, single-use rotation) extend sessions. The requireAuth middleware validates Bearer tokens on protected routes. Rate limiting uses separate buckets for OAuth (oauth:IP prefix) and login (email key).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { difficulty: "hard", tags: ["synthesis", "architecture"] },
  },
  // Cross-session cue questions — test whether conversational references
  // to prior sessions trigger recall tool usage. Same factual content as
  // some existing questions but phrased with natural cross-session cues.
  {
    id: "msr1-q13",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1,msr1-session-2,msr1-session-3",
    question: "Remember that auth bug we had? What was the root cause?",
    referenceAnswer:
      "The auth regression was caused by the interaction between two changes across sessions. In session 1, the rate limiter was fixed from IP-based to email-based keying (req.body?.email ?? req.ip). In session 2, OAuth callback routes were added that don't have a request body. OAuth callbacks fell back to the IP key because req.body was undefined, causing OAuth provider callbacks to consume the IP-based rate limit counter, which then blocked legitimate login requests sharing that IP.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "bug"] },
  },
  {
    id: "msr1-q14",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "We set up something for token refresh last time, how does it work?",
    referenceAnswer:
      "Refresh tokens are stored in the database with a 7-day expiry. On each use, the old refresh token is revoked and a new one is created (single-use rotation). This is implemented in src/auth/token-refresh.ts.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "token"] },
  },
  {
    id: "msr1-q15",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "Earlier we discussed why we went with JWT — what was the reasoning?",
    referenceAnswer:
      "JWT was chosen over session cookies because the API is consumed by both a React web frontend and a React Native mobile app. Stateless tokens avoid server-side session storage and work well with the existing CDN setup.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "decision-rationale"] },
  },
  {
    id: "msr1-q16",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1",
    question: "What was that password hashing library we picked, and why did we rule out the other one?",
    referenceAnswer:
      "bcrypt with 12 salt rounds, implemented in src/auth/password.ts. Argon2 was considered but rejected because bcrypt has better library support in the current Node 20 setup.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "decision-rationale"] },
  },
  {
    id: "msr1-q17",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "In our OAuth work, we had a specific reason for using PKCE instead of the simpler flow — remind me why?",
    referenceAnswer:
      "PKCE was chosen for three reasons: (1) the mobile app is a public client where PKCE is mandatory, (2) implicit grant is deprecated in OAuth 2.1, and (3) using the same flow for both web and mobile simplifies the codebase.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "oauth"] },
  },
  {
    id: "msr1-q18",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1,msr1-session-2,msr1-session-3",
    question: "We changed the rate limiter key at some point and then it caused issues later — can you walk me through what happened?",
    referenceAnswer:
      "In session 1, the rate limiter was keyed by req.ip, which meant users behind the same NAT shared a counter. It was fixed to use req.body?.email ?? req.ip. In session 3, this caused a regression: OAuth callback requests (added in session 2) don't have a body, so they fell back to IP-based keying. OAuth provider servers sharing IPs consumed the rate limit counter, blocking legitimate login requests. The fix added a path check to use a separate 'oauth:' prefix key for OAuth routes.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "hard", tags: ["cross-session-cue", "recall-trigger", "synthesis"] },
  },
  {
    id: "msr1-q19",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-1,msr1-session-2",
    question: "We built up the auth module over a couple of sessions — how many files ended up in src/auth/ and what are they?",
    referenceAnswer:
      "9 files total in src/auth/. Original 5 from session 1: jwt.ts, password.ts, middleware.ts, rate-limiter.ts, routes.ts. Added 4 in session 2: oauth-config.ts, oauth-pkce.ts, oauth-routes.ts, token-refresh.ts.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "hard", tags: ["cross-session-cue", "recall-trigger", "enumeration"] },
  },
  {
    id: "msr1-q20",
    dimension: "recall",
    scenario: "msr-1-sequential",
    sessionRef: "msr1-session-2",
    question: "What were those callback URLs we configured for the OAuth providers? I need to set them up in production.",
    referenceAnswer:
      "Google: http://localhost:3000/auth/google/callback (overridable via GOOGLE_CALLBACK_URL env var). GitHub: http://localhost:3000/auth/github/callback (overridable via GITHUB_CALLBACK_URL env var). In production, set them to https://api.ourapp.com/auth/{provider}/callback.",
    rubric: RUBRICS.crossSessionCueRecall,
    metadata: { difficulty: "medium", tags: ["cross-session-cue", "recall-trigger", "config-value"] },
  },
];

// =========================================================================
// MSR-2: Deep History Recall (5 sessions)
// =========================================================================

const MSR2_PROJECT = "/tmp/eval-project-msr2";

// --- Session 1: CI pipeline setup (~9 turns) -----------------------------

const WEEK_MON = Date.parse("2025-05-05T09:00:00Z");

const m2s1t1 = toolCall("write", { path: ".github/workflows/ci.yml", content: "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node-version: [18, 20, 22]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node-version }}\n      - run: npm ci\n      - run: npm test -- --coverage\n      - uses: codecov/codecov-action@v4\n        with:\n          token: ${{ secrets.CODECOV_TOKEN }}\n          fail_ci_if_error: true\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci\n      - run: npm run lint\n      - run: npm run typecheck\n" }, "I'll set up the GitHub Actions CI pipeline with a Node version matrix.");
const m2s1t2 = toolCall("write", { path: "jest.config.ts", content: "export default {\n  preset: 'ts-jest',\n  testEnvironment: 'node',\n  coverageThreshold: {\n    global: {\n      branches: 80,\n      functions: 85,\n      lines: 85,\n      statements: 85,\n    },\n  },\n  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/scripts/'],\n};\n" }, "Setting coverage thresholds: 80% branches, 85% for functions/lines/statements.");
const m2s1t3 = toolCall("bash", { command: "npm test -- --coverage 2>&1 | tail -15" });

const msr2Session1Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("Let's set up CI for the project. We need GitHub Actions running tests on PRs with a Node version matrix and code coverage."),
  m2s1t1.turn,
  toolResult(m2s1t1.id, "File written: .github/workflows/ci.yml"),
  text("CI pipeline created with:\n- Test matrix: Node 18, 20, 22\n- Coverage upload via Codecov (requires CODECOV_TOKEN secret)\n- Separate lint job running ESLint and TypeScript type checking\n- Triggers on push to main and all PRs"),
  userText("Good. Set up coverage thresholds too — I want at least 80% branch coverage."),
  m2s1t2.turn,
  toolResult(m2s1t2.id, "File written: jest.config.ts"),
  userText("Let's run the tests to see the current coverage."),
  m2s1t3.turn,
  toolResult(m2s1t3.id, "Test Suites: 8 passed, 0 failed\nTests: 34 passed, 0 failed\n\n----------|---------|----------|---------|---------|---\nFile      | % Stmts | % Branch | % Funcs | % Lines |\n----------|---------|----------|---------|---------|---\nAll files |   78.5  |   72.3   |   81.2  |   79.1  |\n----------|---------|----------|---------|---------|---\n\nCoverage threshold not met:\n  branches: 72.3% < 80%"),
  text("Current coverage is below the 80% branch threshold (72.3%). We'll need to add more tests as we build features. The CI will enforce this on PRs."),
], WEEK_MON));

const msr2Session1: SessionTranscript = {
  id: "msr2-session-1",
  label: "CI pipeline setup",
  projectPath: MSR2_PROJECT,
  turns: msr2Session1Turns,
  metadata: {
    totalTokens: msr2Session1Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "GitHub Actions CI: Node 18/20/22 matrix, Codecov, 80% branch coverage threshold (currently at 72.3%). Lint + typecheck in separate job.",
  },
};

// --- Session 2: Database schema design (~10 turns) -----------------------

const WEEK_TUE = Date.parse("2025-05-06T09:30:00Z");

const m2s2t1 = toolCall("write", { path: "prisma/schema.prisma", content: 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel User {\n  id        String   @id @default(cuid())\n  email     String   @unique\n  name      String?\n  role      Role     @default(MEMBER)\n  createdAt DateTime @default(now())\n  updatedAt DateTime @updatedAt\n  posts     Post[]\n  comments  Comment[]\n\n  @@index([email])\n  @@index([role])\n}\n\nmodel Post {\n  id          String    @id @default(cuid())\n  title       String\n  content     String\n  slug        String    @unique\n  published   Boolean   @default(false)\n  publishedAt DateTime?\n  authorId    String\n  author      User      @relation(fields: [authorId], references: [id], onDelete: Cascade)\n  tags        Tag[]\n  comments    Comment[]\n  viewCount   Int       @default(0)\n  createdAt   DateTime  @default(now())\n  updatedAt   DateTime  @updatedAt\n\n  @@index([authorId])\n  @@index([slug])\n  @@index([published, publishedAt])\n}\n\nmodel Comment {\n  id        String   @id @default(cuid())\n  content   String\n  authorId  String\n  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)\n  postId    String\n  post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)\n  parentId  String?\n  parent    Comment? @relation("CommentThread", fields: [parentId], references: [id])\n  children  Comment[] @relation("CommentThread")\n  createdAt DateTime @default(now())\n\n  @@index([postId])\n  @@index([authorId])\n  @@index([parentId])\n}\n\nmodel Tag {\n  id    String @id @default(cuid())\n  name  String @unique\n  posts Post[]\n\n  @@index([name])\n}\n\nenum Role {\n  ADMIN\n  EDITOR\n  MEMBER\n}\n' });
const m2s2t2 = toolCall("bash", { command: "npx prisma migrate dev --name initial-schema 2>&1" });
const m2s2t3 = toolCall("bash", { command: "npx prisma migrate dev --name add-post-search-index 2>&1" });

const msr2Session2Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("Time to design the database schema. We're building a blog platform with users, posts, comments, and tags. Using Prisma with PostgreSQL."),
  m2s2t1.turn,
  toolResult(m2s2t1.id, "File written: prisma/schema.prisma"),
  text("Schema designed with four models:\n- **User**: cuid ID, unique email, optional name, role enum (ADMIN/EDITOR/MEMBER), timestamps\n- **Post**: cuid ID, title, content, unique slug, published flag with publishedAt timestamp, viewCount, author relation with cascade delete\n- **Comment**: self-referential for threaded comments (parentId), cascade delete on user or post removal\n- **Tag**: many-to-many with Post via implicit join table\n\nIndexes on: User.email, User.role, Post.authorId, Post.slug, Post.published+publishedAt (composite), Comment.postId, Comment.authorId, Comment.parentId, Tag.name."),
  userText("Looks good. Let's create the initial migration."),
  m2s2t2.turn,
  toolResult(m2s2t2.id, "Prisma Migrate created migration: 20250506_initial_schema\n\nApplied migration `20250506_initial_schema` to database.\n\nCreated 4 tables: User, Post, Comment, Tag\nCreated 1 enum: Role\nCreated 1 implicit many-to-many table: _PostToTag"),
  userText("We'll need full-text search on posts. Let's add a GIN index for that."),
  m2s2t3.turn,
  toolResult(m2s2t3.id, "Prisma Migrate created migration: 20250506_add_post_search_index\n\nApplied migration with raw SQL:\nCREATE INDEX post_search_idx ON \"Post\" USING GIN (to_tsvector('english', title || ' ' || content));"),
  userText("What about the cascade delete behavior — if a user is deleted, their posts and comments go too?"),
  text("Yes, cascade deletes are configured:\n- User deletion → all Posts by that user are deleted → all Comments on those posts are deleted\n- User deletion → all Comments by that user are also deleted (separate cascade)\n- Post deletion → all Comments on that post are deleted\n- Comment deletion → all child comments in the thread are NOT auto-deleted (we'd need to handle that in application code or add onDelete: Cascade to the self-relation)\n\nThe Tag model has no cascade — deleting a tag just removes the association."),
  userText("Good catch on the comment threading. Let's leave it for now and handle orphan cleanup in app code."),
  text("Noted. The migration names are:\n1. `20250506_initial_schema` — creates all tables, enums, and basic indexes\n2. `20250506_add_post_search_index` — adds GIN index for full-text search on Post title+content"),
], WEEK_TUE));

const msr2Session2: SessionTranscript = {
  id: "msr2-session-2",
  label: "Database schema design",
  projectPath: MSR2_PROJECT,
  turns: msr2Session2Turns,
  metadata: {
    totalTokens: msr2Session2Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "Prisma + PostgreSQL schema: User, Post, Comment (threaded), Tag. Two migrations: initial_schema + GIN full-text search index. Cascade deletes on User→Post→Comment. Role enum: ADMIN/EDITOR/MEMBER.",
  },
};

// --- Session 3: API endpoint implementation (~9 turns) -------------------

const WEEK_WED = Date.parse("2025-05-07T10:00:00Z");

const m2s3t1 = toolCall("write", { path: "src/routes/posts.ts", content: "import { Router } from 'express';\nimport { prisma } from '../db';\nimport { requireAuth, requireRole } from '../auth/middleware';\nimport { z } from 'zod';\n\nconst router = Router();\n\nconst CreatePostSchema = z.object({\n  title: z.string().min(1).max(200),\n  content: z.string().min(1),\n  slug: z.string().regex(/^[a-z0-9-]+$/).max(100),\n  tags: z.array(z.string()).optional(),\n});\n\nrouter.get('/', async (req, res) => {\n  const { page = '1', limit = '20', search } = req.query as Record<string, string>;\n  const skip = (parseInt(page) - 1) * parseInt(limit);\n  const where = search\n    ? { published: true, OR: [{ title: { contains: search } }, { content: { contains: search } }] }\n    : { published: true };\n  const [posts, total] = await Promise.all([\n    prisma.post.findMany({ where, skip, take: parseInt(limit), include: { author: { select: { id: true, name: true } }, tags: true }, orderBy: { publishedAt: 'desc' } }),\n    prisma.post.count({ where }),\n  ]);\n  res.json({ posts, total, page: parseInt(page), limit: parseInt(limit) });\n});\n\nrouter.post('/', requireAuth, async (req, res) => {\n  const body = CreatePostSchema.parse(req.body);\n  const post = await prisma.post.create({\n    data: { ...body, authorId: (req as any).userId, tags: body.tags ? { connectOrCreate: body.tags.map(t => ({ where: { name: t }, create: { name: t } })) } : undefined },\n  });\n  res.status(201).json(post);\n});\n\nrouter.put('/:id/publish', requireAuth, requireRole('EDITOR', 'ADMIN'), async (req, res) => {\n  const post = await prisma.post.update({\n    where: { id: req.params.id },\n    data: { published: true, publishedAt: new Date() },\n  });\n  res.json(post);\n});\n\nexport default router;\n" });
const m2s3t2 = toolCall("write", { path: "src/middleware/error-handler.ts", content: "import type { Request, Response, NextFunction } from 'express';\nimport { ZodError } from 'zod';\nimport { Prisma } from '@prisma/client';\n\nexport function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {\n  if (err instanceof ZodError) {\n    return res.status(400).json({\n      error: 'Validation error',\n      details: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),\n    });\n  }\n\n  if (err instanceof Prisma.PrismaClientKnownRequestError) {\n    if (err.code === 'P2002') {\n      const target = (err.meta?.target as string[])?.join(', ') ?? 'unknown';\n      return res.status(409).json({ error: `Duplicate value for: ${target}` });\n    }\n    if (err.code === 'P2025') {\n      return res.status(404).json({ error: 'Resource not found' });\n    }\n  }\n\n  console.error('Unhandled error:', err);\n  res.status(500).json({ error: 'Internal server error' });\n}\n" }, "Adding centralized error handling. Zod validation errors return 400 with details. Prisma P2002 (unique constraint) returns 409, P2025 (not found) returns 404.");
const m2s3t3 = toolCall("bash", { command: "npx jest tests/routes/posts.test.ts --verbose 2>&1 | tail -20" });

const msr2Session3Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("Let's implement the API routes. Starting with the posts endpoint — CRUD operations with pagination, search, and role-based publishing."),
  m2s3t1.turn,
  toolResult(m2s3t1.id, "File written: src/routes/posts.ts"),
  text("Posts routes created:\n- `GET /posts` — list published posts with pagination (default 20/page) and optional search\n- `POST /posts` — create post (requires auth), validates with Zod schema (title max 200 chars, slug must match /^[a-z0-9-]+$/)\n- `PUT /posts/:id/publish` — publish post (requires EDITOR or ADMIN role)\n\nInput validation uses Zod. Tags use connectOrCreate for automatic tag creation."),
  userText("We need centralized error handling too. Zod errors should return 400, Prisma unique constraint violations should return 409."),
  m2s3t2.turn,
  toolResult(m2s3t2.id, "File written: src/middleware/error-handler.ts"),
  userText("Run the posts route tests."),
  m2s3t3.turn,
  toolResult(m2s3t3.id, "PASS tests/routes/posts.test.ts\n  GET /posts\n    ✓ returns paginated published posts (15ms)\n    ✓ filters by search query (12ms)\n    ✓ returns empty array for no matches (5ms)\n  POST /posts\n    ✓ creates post with valid data (18ms)\n    ✓ rejects invalid slug format (4ms)\n    ✓ returns 401 without auth (3ms)\n    ✓ creates tags on the fly (14ms)\n  PUT /posts/:id/publish\n    ✓ publishes post for EDITOR (8ms)\n    ✓ rejects MEMBER role (4ms)\n    ✓ returns 404 for unknown post (3ms)\n\nTests: 10 passed, 0 failed"),
  text("All 10 route tests pass. The error handler catches:\n- ZodError → 400 with field-level details\n- Prisma P2002 (unique constraint) → 409 with the conflicting field name\n- Prisma P2025 (record not found) → 404\n- Everything else → 500 'Internal server error'"),
], WEEK_WED));

const msr2Session3: SessionTranscript = {
  id: "msr2-session-3",
  label: "API endpoint implementation",
  projectPath: MSR2_PROJECT,
  turns: msr2Session3Turns,
  metadata: {
    totalTokens: msr2Session3Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "Posts CRUD routes with Zod validation, pagination (20/page), search. Role-based publishing (EDITOR/ADMIN). Centralized error handler: Zod→400, P2002→409, P2025→404.",
  },
};

// --- Session 4: Frontend integration (~8 turns) --------------------------

const WEEK_THU = Date.parse("2025-05-08T09:00:00Z");

const m2s4t1 = toolCall("write", { path: "src/client/api.ts", content: "const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';\n\ninterface FetchOptions {\n  method?: string;\n  body?: unknown;\n  token?: string;\n}\n\nexport async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {\n  const headers: Record<string, string> = { 'Content-Type': 'application/json' };\n  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;\n  const res = await fetch(`${BASE_URL}${path}`, {\n    method: opts.method ?? 'GET',\n    headers,\n    body: opts.body ? JSON.stringify(opts.body) : undefined,\n  });\n  if (!res.ok) {\n    const error = await res.json().catch(() => ({ error: res.statusText }));\n    throw new ApiError(res.status, error.error ?? 'Unknown error', error.details);\n  }\n  return res.json();\n}\n\nexport class ApiError extends Error {\n  constructor(public status: number, message: string, public details?: unknown) {\n    super(message);\n    this.name = 'ApiError';\n  }\n}\n" });
const m2s4t2 = toolCall("write", { path: "src/client/hooks/usePosts.ts", content: "import useSWR from 'swr';\nimport { apiFetch } from '../api';\n\ninterface PostsResponse {\n  posts: Post[];\n  total: number;\n  page: number;\n  limit: number;\n}\n\nexport function usePosts(page = 1, search?: string) {\n  const params = new URLSearchParams({ page: String(page), limit: '20' });\n  if (search) params.set('search', search);\n  return useSWR<PostsResponse>(`/posts?${params}`, (url) => apiFetch(url), {\n    revalidateOnFocus: false,\n    dedupingInterval: 5000,\n  });\n}\n" }, "Using SWR for data fetching with 5-second deduping interval and focus revalidation disabled.");
const m2s4t3 = toolCall("write", { path: "src/client/components/ErrorBoundary.tsx", content: "import React from 'react';\nimport { ApiError } from '../api';\n\ninterface Props { children: React.ReactNode; fallback?: React.ReactNode; }\ninterface State { error: Error | null; }\n\nexport class ErrorBoundary extends React.Component<Props, State> {\n  state: State = { error: null };\n  static getDerivedStateFromError(error: Error) { return { error }; }\n  render() {\n    if (this.state.error) {\n      if (this.state.error instanceof ApiError) {\n        return <div className=\"error-panel\">\n          <h2>Something went wrong</h2>\n          <p>{this.state.error.message}</p>\n          {this.state.error.status === 404 && <p>The requested resource was not found.</p>}\n          <button onClick={() => this.setState({ error: null })}>Try again</button>\n        </div>;\n      }\n      return this.props.fallback ?? <div>Unexpected error</div>;\n    }\n    return this.props.children;\n  }\n}\n" });

const msr2Session4Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("Let's build the frontend integration. We're using Next.js with SWR for data fetching."),
  m2s4t1.turn,
  toolResult(m2s4t1.id, "File written: src/client/api.ts"),
  text("API client created with:\n- Base URL from `NEXT_PUBLIC_API_URL` env var (defaults to localhost:3000)\n- Custom `ApiError` class carrying status code and details\n- Bearer token injection for authenticated requests"),
  userText("Now the data fetching hooks and error display."),
  m2s4t2.turn,
  toolResult(m2s4t2.id, "File written: src/client/hooks/usePosts.ts"),
  m2s4t3.turn,
  toolResult(m2s4t3.id, "File written: src/client/components/ErrorBoundary.tsx"),
  text("Frontend integration:\n- `usePosts()` hook with SWR (5s deduping, no focus revalidation)\n- `ErrorBoundary` component with ApiError-aware display (shows user-friendly messages, special handling for 404)\n- State management via SWR cache (no Redux/Zustand needed for this use case)"),
  userText("What about the API URL in production?"),
  text("Set `NEXT_PUBLIC_API_URL` in the production environment. The `NEXT_PUBLIC_` prefix ensures Next.js includes it in the client bundle. For staging, you might use `https://staging-api.ourapp.com`. The default localhost:3000 is only for local development."),
], WEEK_THU));

const msr2Session4: SessionTranscript = {
  id: "msr2-session-4",
  label: "Frontend integration",
  projectPath: MSR2_PROJECT,
  turns: msr2Session4Turns,
  metadata: {
    totalTokens: msr2Session4Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "Next.js frontend: API client with ApiError class, SWR hooks (5s dedup, no focus revalidation), ErrorBoundary with status-aware display. NEXT_PUBLIC_API_URL env var for base URL.",
  },
};

// --- Session 5: Performance optimization (~9 turns) ----------------------

const WEEK_FRI = Date.parse("2025-05-09T10:00:00Z");

const m2s5t1 = toolCall("bash", { command: "npx prisma query-log analyze 2>&1 | head -20" }, "Let me check the query performance.");
const m2s5t2 = toolCall("read", { path: "src/routes/posts.ts" });
const m2s5t3 = toolCall("edit", { path: "src/routes/posts.ts", old: "prisma.post.findMany({ where, skip, take: parseInt(limit), include: { author: { select: { id: true, name: true } }, tags: true }, orderBy: { publishedAt: 'desc' } })", new: "prisma.post.findMany({ where, skip, take: parseInt(limit), include: { author: { select: { id: true, name: true } }, tags: { select: { id: true, name: true } }, _count: { select: { comments: true } } }, orderBy: { publishedAt: 'desc' } })" }, "Adding comment count to the query and selecting only needed tag fields to reduce payload size.");
const m2s5t4 = toolCall("write", { path: "src/middleware/cache.ts", content: "import type { Request, Response, NextFunction } from 'express';\n\nconst cache = new Map<string, { data: string; timestamp: number }>();\nconst DEFAULT_TTL_MS = 60_000; // 1 minute\n\nexport function cacheMiddleware(ttlMs = DEFAULT_TTL_MS) {\n  return (req: Request, res: Response, next: NextFunction) => {\n    if (req.method !== 'GET') return next();\n    const key = req.originalUrl;\n    const cached = cache.get(key);\n    if (cached && Date.now() - cached.timestamp < ttlMs) {\n      res.setHeader('X-Cache', 'HIT');\n      return res.json(JSON.parse(cached.data));\n    }\n    const originalJson = res.json.bind(res);\n    res.json = (body: any) => {\n      cache.set(key, { data: JSON.stringify(body), timestamp: Date.now() });\n      res.setHeader('X-Cache', 'MISS');\n      return originalJson(body);\n    };\n    next();\n  };\n}\n" }, "In-memory cache middleware with 1-minute TTL. Returns X-Cache header (HIT/MISS) for debugging.");
const m2s5t5 = toolCall("bash", { command: "npx autocannon -c 50 -d 10 http://localhost:3000/posts 2>&1" });

const msr2Session5Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("The posts listing page is slow — let's optimize the queries and add caching."),
  m2s5t1.turn,
  toolResult(m2s5t1.id, "Slow queries:\n  1. SELECT * FROM \"Post\" ... JOIN \"User\" JOIN \"Tag\" — avg 45ms (N+1 on tags)\n  2. SELECT COUNT(*) FROM \"Post\" WHERE published = true — avg 12ms\n  3. Full-text search query — avg 89ms without GIN index hit\n\nRecommendation: Select only needed columns, use the GIN index for search"),
  m2s5t2.turn,
  toolResult(m2s5t2.id, "[... current posts route code ...]"),
  text("Issues found:\n1. Tag relation loads all fields — we only need id and name\n2. No comment count included (forces N+1 on the frontend)\n3. The full-text search isn't using our GIN index (using Prisma `contains` instead of raw SQL)\n\nLet me optimize the query."),
  m2s5t3.turn,
  toolResult(m2s5t3.id, "File edited: src/routes/posts.ts"),
  userText("Good. Let's also add response caching for the GET endpoints."),
  m2s5t4.turn,
  toolResult(m2s5t4.id, "File written: src/middleware/cache.ts"),
  userText("Run a quick load test."),
  m2s5t5.turn,
  toolResult(m2s5t5.id, "Running 10s test @ http://localhost:3000/posts\n50 connections\n\nStat         2.5%    50%     97.5%   99%     Avg     Max\nLatency (ms) 2       8       45      62      12.3    89\nReq/Sec      580     820     950     980     812     990\n\n8,234 requests in 10s\n812 req/s average\n\nWith cache warmed:\nStat         2.5%    50%     97.5%   99%     Avg     Max\nLatency (ms) 0       1       3       5       1.2     12\nReq/Sec      3200    4100    4800    4950    4050    5100\n\n40,500 requests in 10s\n4,050 req/s average (~5x improvement)"),
  text("Performance results:\n- Without cache: 812 req/s, avg 12.3ms latency\n- With cache (1-min TTL): 4,050 req/s, avg 1.2ms latency — a **5x improvement**\n- The X-Cache header lets us verify cache behavior in production\n\nFor the full-text search optimization, we should switch from Prisma's `contains` to `$queryRaw` with `to_tsquery()` to use the GIN index. The current search bypasses the index."),
], WEEK_FRI));

const msr2Session5: SessionTranscript = {
  id: "msr2-session-5",
  label: "Performance optimization",
  projectPath: MSR2_PROJECT,
  turns: msr2Session5Turns,
  metadata: {
    totalTokens: msr2Session5Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "Query optimization: select-only tag fields, add comment _count. In-memory cache middleware (1-min TTL, X-Cache header). Load test: 812→4050 req/s (5x improvement). Full-text search not yet using GIN index.",
  },
};

// --- MSR-2 Questions (15, 3 per session) ---------------------------------

const msr2Questions: EvalQuestion[] = [
  // Session 1 questions
  {
    id: "msr2-q1",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-1",
    question: "What Node.js versions are in the CI test matrix?",
    referenceAnswer: "Node 18, 20, and 22.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "medium", tags: ["config-value", "ci"] },
  },
  {
    id: "msr2-q2",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-1",
    question: "What were the code coverage thresholds set in jest.config.ts?",
    referenceAnswer: "80% for branches, 85% for functions, lines, and statements. The current coverage was below threshold: branches at 72.3%.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 5, difficulty: "medium", tags: ["config-value", "coverage"] },
  },
  {
    id: "msr2-q3",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-1",
    question: "What code coverage tool is used and how is it integrated into CI?",
    referenceAnswer: "Codecov, integrated via the codecov/codecov-action@v4 GitHub Action. It requires a CODECOV_TOKEN secret and is configured to fail CI if the upload fails (fail_ci_if_error: true).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "hard", tags: ["ci", "tooling"] },
  },

  // Session 2 questions
  {
    id: "msr2-q4",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-2",
    question: "What are the four database models in the Prisma schema?",
    referenceAnswer: "User, Post, Comment, and Tag. Plus a Role enum (ADMIN, EDITOR, MEMBER).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "easy", tags: ["schema", "database"] },
  },
  {
    id: "msr2-q5",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-2",
    question: "What database migrations were created and what did they do?",
    referenceAnswer: "Two migrations: (1) 20250506_initial_schema — creates all tables (User, Post, Comment, Tag), the Role enum, and the implicit _PostToTag join table. (2) 20250506_add_post_search_index — adds a GIN index for full-text search on Post title+content using to_tsvector('english', title || ' ' || content).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 5, difficulty: "medium", tags: ["migration", "database"] },
  },
  {
    id: "msr2-q6",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-2",
    question: "What is the cascade delete behavior when a user is deleted?",
    referenceAnswer: "User deletion cascades to: all Posts by that user (which then cascades to their Comments), and all Comments authored by that user. However, threaded comment children are NOT auto-deleted — orphan cleanup must be handled in application code.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 7, difficulty: "hard", tags: ["database", "architecture"] },
  },

  // Session 3 questions
  {
    id: "msr2-q7",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-3",
    question: "What validation rules does the CreatePostSchema enforce?",
    referenceAnswer: "Title: string, min 1 char, max 200 chars. Content: string, min 1 char. Slug: string, must match /^[a-z0-9-]+$/, max 100 chars. Tags: optional array of strings.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "medium", tags: ["validation", "api"] },
  },
  {
    id: "msr2-q8",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-3",
    question: "What Prisma error codes does the error handler catch, and what HTTP status does each map to?",
    referenceAnswer: "P2002 (unique constraint violation) maps to HTTP 409 Conflict with the conflicting field name. P2025 (record not found) maps to HTTP 404. ZodError maps to HTTP 400 with field-level details.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 5, difficulty: "medium", tags: ["error-handling", "api"] },
  },
  {
    id: "msr2-q9",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-3",
    question: "What roles are required to publish a post?",
    referenceAnswer: "EDITOR or ADMIN role, enforced by the requireRole('EDITOR', 'ADMIN') middleware on the PUT /posts/:id/publish endpoint.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "easy", tags: ["authorization", "api"] },
  },

  // Session 4 questions
  {
    id: "msr2-q10",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-4",
    question: "What data fetching library is used on the frontend, and what are its configuration settings?",
    referenceAnswer: "SWR with revalidateOnFocus disabled and a 5-second dedupingInterval.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 5, difficulty: "medium", tags: ["frontend", "config-value"] },
  },
  {
    id: "msr2-q11",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-4",
    question: "What environment variable controls the API base URL in the frontend?",
    referenceAnswer: "NEXT_PUBLIC_API_URL. The NEXT_PUBLIC_ prefix ensures Next.js includes it in the client bundle. It defaults to http://localhost:3000.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 9, difficulty: "easy", tags: ["config-value", "frontend"] },
  },
  {
    id: "msr2-q12",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-4",
    question: "How does the ErrorBoundary component handle different types of errors?",
    referenceAnswer: "For ApiError instances, it shows the error message with a user-friendly panel and a 'Try again' button. For 404 status specifically, it adds 'The requested resource was not found.' For non-ApiError errors, it shows a generic 'Unexpected error' fallback (or a custom fallback if provided via props).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 7, difficulty: "hard", tags: ["frontend", "error-handling"] },
  },

  // Session 5 questions
  {
    id: "msr2-q13",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-5",
    question: "What were the load test results before and after caching?",
    referenceAnswer: "Without cache: 812 req/s average, 12.3ms avg latency. With cache (1-min TTL): 4,050 req/s average, 1.2ms avg latency — a 5x improvement.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 9, difficulty: "easy", tags: ["performance", "number"] },
  },
  {
    id: "msr2-q14",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-5",
    question: "What is the cache TTL and what header indicates cache hits?",
    referenceAnswer: "1-minute TTL (60,000ms). The X-Cache response header indicates HIT or MISS.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 7, difficulty: "easy", tags: ["config-value", "caching"] },
  },
  {
    id: "msr2-q15",
    dimension: "recall",
    scenario: "msr-2-deep-history",
    sessionRef: "msr2-session-5",
    question: "Why is the full-text search not fully optimized, and what was the recommendation?",
    referenceAnswer: "The Prisma 'contains' query doesn't use the GIN index that was created in the database schema session. The recommendation is to switch from Prisma's contains to $queryRaw with to_tsquery() to hit the GIN index. The current search averages 89ms without the index hit.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 9, difficulty: "hard", tags: ["performance", "cross-session"] },
  },
];

// =========================================================================
// MSR-3: Cross-Model Sessions (2 sessions)
// =========================================================================

const MSR3_PROJECT = "/tmp/eval-project-msr3";

// --- Session 1: Architecture decisions (model: Sonnet) -------------------

const MSR3_DAY1 = Date.parse("2025-05-10T09:00:00Z");

const m3s1t1 = toolCall("write", { path: "docs/architecture.md", content: "# Architecture Decision Records\n\n## ADR-001: Event-Driven Architecture\n\nWe're using an event-driven architecture with a message broker (RabbitMQ) for inter-service communication.\n\n**Decision**: Event sourcing for the order service, CQRS for read-heavy endpoints.\n\n**Rationale**:\n- Order history requires full audit trail (event sourcing)\n- Product catalog is read 100x more than written (CQRS with materialized views)\n- Services need loose coupling for independent deployment\n\n**Rejected alternatives**:\n- Direct REST calls between services (tight coupling, cascading failures)\n- Shared database (schema coupling, scaling bottleneck)\n- Apache Kafka (overkill for our throughput — <1000 events/sec)\n\n## ADR-002: Database Per Service\n\nEach microservice owns its database.\n\n- Order service: PostgreSQL (transactional integrity)\n- Product service: PostgreSQL + Redis (cache layer)\n- User service: PostgreSQL\n- Notification service: MongoDB (flexible schema for notification templates)\n- Search service: Elasticsearch\n" });
const m3s1t2 = toolCall("write", { path: "src/shared/events.ts", content: "export const EVENTS = {\n  ORDER_CREATED: 'order.created',\n  ORDER_PAID: 'order.paid',\n  ORDER_SHIPPED: 'order.shipped',\n  ORDER_CANCELLED: 'order.cancelled',\n  PRODUCT_UPDATED: 'product.updated',\n  PRODUCT_STOCK_LOW: 'product.stock.low',\n  USER_REGISTERED: 'user.registered',\n  USER_VERIFIED: 'user.verified',\n} as const;\n\nexport interface OrderCreatedEvent {\n  orderId: string;\n  userId: string;\n  items: Array<{ productId: string; quantity: number; price: number }>;\n  total: number;\n  timestamp: string;\n}\n\nexport interface ProductStockLowEvent {\n  productId: string;\n  currentStock: number;\n  threshold: number;\n  timestamp: string;\n}\n" });
const m3s1t3 = toolCall("write", { path: "src/shared/retry-policy.ts", content: "export interface RetryConfig {\n  maxRetries: number;\n  initialDelayMs: number;\n  maxDelayMs: number;\n  backoffMultiplier: number;\n}\n\nexport const DEFAULT_RETRY: RetryConfig = {\n  maxRetries: 3,\n  initialDelayMs: 1000,\n  maxDelayMs: 30000,\n  backoffMultiplier: 2,\n};\n\nexport const CRITICAL_RETRY: RetryConfig = {\n  maxRetries: 5,\n  initialDelayMs: 500,\n  maxDelayMs: 60000,\n  backoffMultiplier: 3,\n};\n\nexport async function withRetry<T>(\n  fn: () => Promise<T>,\n  config: RetryConfig = DEFAULT_RETRY,\n): Promise<T> {\n  let lastError: Error;\n  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {\n    try {\n      return await fn();\n    } catch (err) {\n      lastError = err as Error;\n      if (attempt < config.maxRetries) {\n        const delay = Math.min(\n          config.initialDelayMs * config.backoffMultiplier ** attempt,\n          config.maxDelayMs,\n        );\n        await new Promise((r) => setTimeout(r, delay));\n      }\n    }\n  }\n  throw lastError!;\n}\n" }, "Retry policy with exponential backoff: DEFAULT_RETRY (3 attempts, 1s initial, 2x backoff, 30s max) and CRITICAL_RETRY (5 attempts, 500ms initial, 3x backoff, 60s max).");

const msr3Session1Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("We're designing a microservices architecture for an e-commerce platform. I need help documenting the key architecture decisions and setting up the shared event system."),
  m3s1t1.turn,
  toolResult(m3s1t1.id, "File written: docs/architecture.md"),
  text("Architecture decisions documented:\n\n**ADR-001**: Event-driven architecture with RabbitMQ. Event sourcing for the order service (audit trail), CQRS for the product catalog (read-heavy). Rejected: direct REST (coupling), shared DB (scaling), Kafka (overkill for <1000 events/sec).\n\n**ADR-002**: Database per service — PostgreSQL for order/product/user services, MongoDB for notifications (flexible templates), Elasticsearch for search. Product service also uses Redis as a cache layer."),
  userText("Now the shared event types."),
  m3s1t2.turn,
  toolResult(m3s1t2.id, "File written: src/shared/events.ts"),
  text("Eight events defined across four domains:\n- Order: created, paid, shipped, cancelled\n- Product: updated, stock.low\n- User: registered, verified\n\nEach event has a typed payload interface (e.g., `OrderCreatedEvent` includes orderId, userId, items array with quantity and price, total, and timestamp)."),
  userText("We also need a shared retry policy for event consumers."),
  m3s1t3.turn,
  toolResult(m3s1t3.id, "File written: src/shared/retry-policy.ts"),
  text("Two retry policies:\n- `DEFAULT_RETRY`: 3 attempts, 1s initial delay, 2x backoff, 30s max delay\n- `CRITICAL_RETRY`: 5 attempts, 500ms initial delay, 3x backoff, 60s max delay\n\nThe `withRetry()` utility handles exponential backoff automatically."),
  userText("Perfect. One more thing — the stock low threshold should be configurable per product but default to 10 units."),
  text("Got it. The `product.stock.low` event includes the `threshold` field. The default threshold of 10 units should be stored in the product service's config (`STOCK_LOW_THRESHOLD=10`) but overridable per product in the database (a `lowStockThreshold` column on the Product table, nullable, falling back to the env default)."),
], MSR3_DAY1));

const msr3Session1: SessionTranscript = {
  id: "msr3-session-1",
  label: "Architecture decisions (Sonnet)",
  projectPath: MSR3_PROJECT,
  turns: msr3Session1Turns,
  metadata: {
    totalTokens: msr3Session1Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "E-commerce microservices architecture: event-driven with RabbitMQ, event sourcing for orders, CQRS for products. DB-per-service pattern. 8 event types. Retry policies (DEFAULT: 3×2x, CRITICAL: 5×3x). Model: claude-sonnet-4-6.",
  },
};

// --- Session 2: Implementation (model: Opus) -----------------------------

const MSR3_DAY2 = Date.parse("2025-05-11T10:00:00Z");

const m3s2t1 = toolCall("read", { path: "docs/architecture.md" }, "Let me review the architecture decisions from yesterday.");
const m3s2t2 = toolCall("write", { path: "services/order/src/event-store.ts", content: "import { Pool } from 'pg';\n\ninterface DomainEvent {\n  aggregateId: string;\n  eventType: string;\n  payload: unknown;\n  version: number;\n  timestamp: Date;\n}\n\nexport class EventStore {\n  constructor(private pool: Pool) {}\n\n  async append(event: Omit<DomainEvent, 'timestamp'>): Promise<void> {\n    await this.pool.query(\n      'INSERT INTO domain_events (aggregate_id, event_type, payload, version, timestamp) VALUES ($1, $2, $3, $4, NOW())',\n      [event.aggregateId, event.eventType, JSON.stringify(event.payload), event.version],\n    );\n  }\n\n  async getEvents(aggregateId: string, afterVersion = 0): Promise<DomainEvent[]> {\n    const result = await this.pool.query(\n      'SELECT * FROM domain_events WHERE aggregate_id = $1 AND version > $2 ORDER BY version ASC',\n      [aggregateId, afterVersion],\n    );\n    return result.rows;\n  }\n\n  async getLatestVersion(aggregateId: string): Promise<number> {\n    const result = await this.pool.query(\n      'SELECT COALESCE(MAX(version), 0) as version FROM domain_events WHERE aggregate_id = $1',\n      [aggregateId],\n    );\n    return result.rows[0].version;\n  }\n}\n" }, "Implementing the event store for the order service. This stores domain events in PostgreSQL as documented in ADR-001.");
const m3s2t3 = toolCall("write", { path: "services/order/src/order-aggregate.ts", content: "import { EventStore } from './event-store';\nimport { EVENTS, OrderCreatedEvent } from '../../../src/shared/events';\n\ninterface OrderState {\n  id: string;\n  status: 'created' | 'paid' | 'shipped' | 'cancelled';\n  items: Array<{ productId: string; quantity: number; price: number }>;\n  total: number;\n}\n\nexport class OrderAggregate {\n  private state: OrderState | null = null;\n  private version = 0;\n\n  constructor(private eventStore: EventStore, private id: string) {}\n\n  async load(): Promise<void> {\n    const events = await this.eventStore.getEvents(this.id);\n    for (const event of events) {\n      this.apply(event.eventType, event.payload);\n      this.version = event.version;\n    }\n  }\n\n  async create(userId: string, items: OrderState['items']): Promise<void> {\n    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n    await this.eventStore.append({\n      aggregateId: this.id,\n      eventType: EVENTS.ORDER_CREATED,\n      payload: { orderId: this.id, userId, items, total, timestamp: new Date().toISOString() } satisfies OrderCreatedEvent,\n      version: this.version + 1,\n    });\n  }\n\n  private apply(eventType: string, payload: unknown): void {\n    switch (eventType) {\n      case EVENTS.ORDER_CREATED: {\n        const e = payload as OrderCreatedEvent;\n        this.state = { id: e.orderId, status: 'created', items: e.items, total: e.total };\n        break;\n      }\n      case EVENTS.ORDER_PAID:\n        if (this.state) this.state.status = 'paid';\n        break;\n      case EVENTS.ORDER_SHIPPED:\n        if (this.state) this.state.status = 'shipped';\n        break;\n      case EVENTS.ORDER_CANCELLED:\n        if (this.state) this.state.status = 'cancelled';\n        break;\n    }\n  }\n}\n" });
const m3s2t4 = toolCall("write", { path: "services/order/src/rabbitmq-publisher.ts", content: "import amqplib from 'amqplib';\nimport { withRetry, CRITICAL_RETRY } from '../../../src/shared/retry-policy';\n\nlet connection: amqplib.Connection | null = null;\nlet channel: amqplib.Channel | null = null;\n\nconst EXCHANGE_NAME = 'domain_events';\nconst EXCHANGE_TYPE = 'topic';\n\nexport async function initPublisher(url: string): Promise<void> {\n  connection = await withRetry(() => amqplib.connect(url), CRITICAL_RETRY);\n  channel = await connection.createChannel();\n  await channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });\n}\n\nexport async function publishEvent(routingKey: string, payload: unknown): Promise<void> {\n  if (!channel) throw new Error('Publisher not initialized');\n  channel.publish(\n    EXCHANGE_NAME,\n    routingKey,\n    Buffer.from(JSON.stringify(payload)),\n    { persistent: true, contentType: 'application/json', timestamp: Date.now() },\n  );\n}\n\nexport async function shutdown(): Promise<void> {\n  await channel?.close();\n  await connection?.close();\n}\n" }, "RabbitMQ publisher using a topic exchange called 'domain_events'. Uses the CRITICAL_RETRY policy from session 1 for connection establishment.");

const msr3Session2Turns: ConversationTurn[] = estimateTokens(stamp([
  userText("Let's implement the order service based on the architecture we designed yesterday. Start with the event store and order aggregate."),
  m3s2t1.turn,
  toolResult(m3s2t1.id, "# Architecture Decision Records\n\n## ADR-001: Event-Driven Architecture\n...[full content]...\n\n## ADR-002: Database Per Service\n..."),
  m3s2t2.turn,
  toolResult(m3s2t2.id, "File written: services/order/src/event-store.ts"),
  text("Event store implemented using PostgreSQL (as per ADR-002: order service uses PostgreSQL for transactional integrity). Events are stored with aggregate_id, event_type, payload (JSON), version (for optimistic concurrency), and timestamp."),
  m3s2t3.turn,
  toolResult(m3s2t3.id, "File written: services/order/src/order-aggregate.ts"),
  text("Order aggregate with event sourcing:\n- States: created → paid → shipped → cancelled\n- `load()` replays events to rebuild state\n- `create()` appends an ORDER_CREATED event using the shared event types\n- Total calculated as sum of (price × quantity) per item"),
  userText("Now the RabbitMQ publisher to broadcast events to other services."),
  m3s2t4.turn,
  toolResult(m3s2t4.id, "File written: services/order/src/rabbitmq-publisher.ts"),
  text("RabbitMQ publisher configured:\n- Topic exchange named `domain_events` (durable)\n- Uses CRITICAL_RETRY policy (5 attempts, 3x backoff) for initial connection — this is from the retry policy we defined in session 1\n- Messages are persistent with JSON content type and timestamp\n- Routing keys match event names (e.g., `order.created`) for topic-based subscription"),
  userText("Good. The event store table — what columns does it have?"),
  text("The `domain_events` table has 5 columns:\n1. `aggregate_id` (string) — the order ID\n2. `event_type` (string) — matches EVENTS constants (e.g., 'order.created')\n3. `payload` (JSON) — the full event data\n4. `version` (integer) — for ordering and optimistic concurrency\n5. `timestamp` (timestamptz) — set to NOW() on insert\n\nThe version column prevents concurrent writes: if two processes try to append the same version, the unique constraint on (aggregate_id, version) will reject one."),
], MSR3_DAY2));

const msr3Session2: SessionTranscript = {
  id: "msr3-session-2",
  label: "Implementation (Opus)",
  projectPath: MSR3_PROJECT,
  turns: msr3Session2Turns,
  metadata: {
    totalTokens: msr3Session2Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description: "Order service implementation: EventStore (PG), OrderAggregate with event sourcing, RabbitMQ publisher (topic exchange, CRITICAL_RETRY). Model: claude-opus-4-6.",
  },
};

// --- MSR-3 Questions (6) -------------------------------------------------

const msr3Questions: EvalQuestion[] = [
  {
    id: "msr3-q1",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1",
    question: "Why was RabbitMQ chosen over Kafka for the message broker?",
    referenceAnswer: "Kafka was rejected as overkill for the expected throughput of less than 1000 events per second. RabbitMQ was chosen as the message broker for inter-service communication.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "medium", tags: ["decision-rationale", "architecture"] },
  },
  {
    id: "msr3-q2",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1",
    question: "What database does each microservice use?",
    referenceAnswer: "Order service: PostgreSQL (transactional integrity). Product service: PostgreSQL + Redis (cache layer). User service: PostgreSQL. Notification service: MongoDB (flexible schema for notification templates). Search service: Elasticsearch.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 1, difficulty: "medium", tags: ["architecture", "database"] },
  },
  {
    id: "msr3-q3",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1",
    question: "What are the two retry policies and their configurations?",
    referenceAnswer: "DEFAULT_RETRY: 3 max retries, 1000ms initial delay, 2x backoff multiplier, 30000ms max delay. CRITICAL_RETRY: 5 max retries, 500ms initial delay, 3x backoff multiplier, 60000ms max delay.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 7, difficulty: "hard", tags: ["config-value", "architecture"] },
  },
  {
    id: "msr3-q4",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1",
    question: "What is the default stock low threshold and how is it configurable?",
    referenceAnswer: "Default threshold is 10 units, stored in STOCK_LOW_THRESHOLD env var. It can be overridden per product via a lowStockThreshold column on the Product table (nullable, falls back to the env default).",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 9, difficulty: "hard", tags: ["config-value", "decision-rationale"] },
  },
  {
    id: "msr3-q5",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1,msr3-session-2",
    question: "What are the eight event types defined in the shared events module, and which domains do they belong to?",
    referenceAnswer: "Order domain: order.created, order.paid, order.shipped, order.cancelled. Product domain: product.updated, product.stock.low. User domain: user.registered, user.verified.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { turnIndex: 5, difficulty: "medium", tags: ["enumeration", "events"] },
  },
  {
    id: "msr3-q6",
    dimension: "recall",
    scenario: "msr-3-cross-model",
    sessionRef: "msr3-session-1,msr3-session-2",
    question: "How does the RabbitMQ publisher reference decisions from the architecture session?",
    referenceAnswer: "The publisher uses the CRITICAL_RETRY policy (5 attempts, 3x backoff) defined in the architecture session for establishing the RabbitMQ connection. It uses a topic exchange named 'domain_events' (durable), which supports the event-driven architecture defined in ADR-001. Messages are persistent and use event names as routing keys (e.g., 'order.created') for topic-based subscription.",
    rubric: RUBRICS.multiSessionRecall,
    metadata: { difficulty: "hard", tags: ["synthesis", "cross-session", "cross-model"] },
  },
];

// =========================================================================
// Export
// =========================================================================

export const scenarios: ScenarioDefinition[] = [
  {
    id: "msr-1-sequential",
    name: "MSR-1: Sequential Feature Development",
    dimension: "recall",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [msr1Session1, msr1Session2, msr1Session3],
    questions: msr1Questions,
  },
  {
    id: "msr-2-deep-history",
    name: "MSR-2: Deep History Recall",
    dimension: "recall",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [
      msr2Session1,
      msr2Session2,
      msr2Session3,
      msr2Session4,
      msr2Session5,
    ],
    questions: msr2Questions,
  },
  {
    id: "msr-3-cross-model",
    name: "MSR-3: Cross-Model Sessions",
    dimension: "recall",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [msr3Session1, msr3Session2],
    questions: msr3Questions,
  },
];
