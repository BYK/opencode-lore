/**
 * Safe process exit for the Bun standalone binary.
 *
 * Bun 1.3.x panics with "A C++ exception occurred" when NAPI modules (e.g.
 * onnxruntime-node loaded by @huggingface/transformers) are cleaned up during
 * normal process.exit() teardown. This module provides `safeExit()` which uses
 * libc `_exit()` via FFI to skip atexit handlers and NAPI teardown.
 *
 * Falls back to `process.exit()` when:
 *  - Not running under Bun (Node.js handles NAPI teardown correctly)
 *  - `bun:ffi` is unavailable
 *  - All FFI dlopen attempts fail
 *
 * `_exit()` skips: atexit handlers, stdio flushing, NAPI destructor hooks.
 * This is safe for the gateway because:
 *  - SQLite WAL mode handles incomplete writes (journal recovery)
 *  - The embedding worker is unref'd and exits on its own
 *  - stderr output was already flushed before shutdown() completed
 */
export function safeExit(code: number): never {
  // Only use FFI _exit under Bun (the runtime that has the NAPI teardown bug).
  if (typeof globalThis.Bun !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
      const libs =
        process.platform === "win32"
          ? ["msvcrt.dll"]
          : process.platform === "darwin"
            ? ["libSystem.B.dylib"]
            : ["libc.so.6"];
      for (const name of libs) {
        try {
          dlopen(name, {
            _exit: { args: [FFIType.int], returns: FFIType.void },
          }).symbols._exit(code);
        } catch {
          /* try next lib */
        }
      }
    } catch {
      /* bun:ffi not available — fall through to process.exit */
    }
  }

  process.exit(code);
}
