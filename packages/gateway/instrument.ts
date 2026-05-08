/**
 * Sentry instrumentation — prod-only.
 *
 * Gated by LORE_CLI_VERSION: in dev mode the constant is undefined and
 * VERSION falls back to "dev", so Sentry is never initialized. In binary
 * and npm builds, esbuild injects a real semver string.
 *
 * This file is imported as a side-effect from both entry points:
 *   - src/cli/bin.ts  (standalone binary)
 *   - src/index.ts    (npm bundle / direct execution)
 *
 * Static imports are used (not dynamic) because the CJS npm bundle
 * does not support top-level await. The modules are loaded but
 * Sentry.init() only runs when VERSION is a real semver string.
 */
import * as Sentry from "@sentry/bun";
import { log } from "@loreai/core";
import { VERSION } from "./src/cli/version";

if (VERSION !== "dev" && !Sentry.isInitialized()) {
  Sentry.init({
    dsn: "https://0282201d6a3df3bc46423e61012ae62b@o275100.ingest.us.sentry.io/4511355222622208",

    release: VERSION,

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
