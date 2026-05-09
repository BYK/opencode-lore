/**
 * Sentry instrumentation.
 *
 * By default, Sentry is enabled in production builds (where esbuild
 * injects a real semver string via LORE_CLI_VERSION) and disabled in
 * dev mode (VERSION falls back to "dev").
 *
 * Explicit control via SENTRY_ENABLED env var:
 *   - SENTRY_ENABLED=1  → force on  (useful for local dev testing)
 *   - SENTRY_ENABLED=0  → force off (opt out in production)
 *
 * When force-enabled in dev mode, environment is set to "development";
 * production builds always use "production".
 *
 * This file is imported as a side-effect from both entry points:
 *   - src/cli/bin.ts  (standalone binary)
 *   - src/index.ts    (npm bundle / direct execution)
 *
 * Static imports are used (not dynamic) because the CJS npm bundle
 * does not support top-level await. The modules are loaded but
 * Sentry.init() only runs when the gate passes.
 */
import * as Sentry from "@sentry/bun";
import { log } from "@loreai/core";
import { VERSION } from "./src/cli/version";

/**
 * Build-time debug ID for sourcemap resolution, injected by esbuild.
 *
 * During the build, esbuild's `define` replaces this identifier with a
 * placeholder UUID string literal. After esbuild finishes, the build
 * script replaces the placeholder with the real debug ID (derived from
 * the sourcemap content hash). The same-length swap keeps sourcemap
 * character positions valid.
 */
declare const __SENTRY_DEBUG_ID__: string | undefined;

/**
 * Register the build-time debug ID with the Sentry SDK's native discovery.
 *
 * The SDK reads `globalThis._sentryDebugIds` (a map of Error.stack → debugId)
 * during event processing to populate `debug_meta.images`, which the server
 * uses to match uploaded sourcemaps.
 *
 * This is the ESM-safe alternative to prepending an IIFE snippet — placing
 * the registration here (inside the module, after all imports) is valid ESM
 * and feeds the SDK's existing mechanism directly.
 */
if (typeof __SENTRY_DEBUG_ID__ !== "undefined") {
  try {
    const stack = new Error().stack;
    if (stack) {
      const g = globalThis as any;
      g._sentryDebugIds = g._sentryDebugIds || {};
      g._sentryDebugIds[stack] = __SENTRY_DEBUG_ID__;
    }
  } catch (_) {
    // Non-critical — sourcemap resolution degrades gracefully
  }
}

const sentryEnvVar = process.env.SENTRY_ENABLED?.trim();
const isDev = VERSION === "dev";
const sentryEnabled =
  sentryEnvVar === "1" ? true : sentryEnvVar === "0" ? false : !isDev;

if (sentryEnabled && !Sentry.isInitialized()) {
  Sentry.init({
    dsn: "https://0282201d6a3df3bc46423e61012ae62b@o275100.ingest.us.sentry.io/4511355222622208",

    release: VERSION,
    environment: isDev ? "development" : "production",

    // Adds request headers and IP for users, for more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/bun/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    // Capture 100% of transactions and logs
    tracesSampleRate: 1.0,
    enableLogs: true,
  });

  // Bridge core's log.* calls → Sentry structured logs + error capture
  log.registerSink({
    info: (message, attrs) => Sentry.logger.info(message, attrs),
    warn: (message, attrs) => Sentry.logger.warn(message, attrs),
    error: (message, attrs) => Sentry.logger.error(message, attrs),
    captureException: (err) => Sentry.captureException(err),
  });
}
