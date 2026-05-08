/**
 * Bun → Node.js polyfills for the npm CJS bundle.
 *
 * Injected at esbuild bundle time via `inject`. Source code stays Bun-native;
 * these polyfills are invisible to developers and only activate when running
 * under Node.js.
 *
 * Polyfilled APIs:
 *  - Bun.serve()              → node:http createServer + WinterCG Request/Response
 *  - Bun.zstdCompressSync()   → node:zlib zstdCompressSync (Node ≥ 22.15)
 *  - Bun.zstdDecompressSync() → node:zlib zstdDecompressSync (Node ≥ 22.15)
 *  - Bun.which()              → child_process execFileSync which/where
 *  - Bun.main                 → null (only used in guarded direct-execution check)
 *
 * NOT polyfilled (already handled):
 *  - bun:sqlite   → esbuild plugin rewrites to node:sqlite
 *  - Bun.which()  → agents.ts already has a Node.js fallback
 *  - Bun.main     → index.ts checks `typeof Bun` first
 */

// Only install polyfills when Bun is not the runtime.
if (typeof globalThis.Bun === "undefined") {
  const http = require("node:http") as typeof import("node:http");
  const { Readable } = require("node:stream") as typeof import("node:stream");
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const cp = require("node:child_process") as typeof import("node:child_process");

  // ---------------------------------------------------------------------------
  // Bun.serve() → node:http
  // ---------------------------------------------------------------------------

  type ServeOptions = {
    port: number;
    hostname: string;
    fetch: (req: Request) => Response | Promise<Response>;
  };

  function serve(opts: ServeOptions) {
    const server = http.createServer(async (nodeReq, nodeRes) => {
      try {
        const url = `http://${opts.hostname}:${opts.port}${nodeReq.url}`;

        const body =
          nodeReq.method === "GET" || nodeReq.method === "HEAD"
            ? null
            : (Readable.toWeb(nodeReq) as unknown as ReadableStream);

        const req = new Request(url, {
          method: nodeReq.method,
          headers: nodeReq.headers as Record<string, string>,
          body,
          // @ts-expect-error — required for Node.js request body streaming
          duplex: "half",
        });

        const response = await opts.fetch(req);

        // Write status + headers
        const headerEntries: [string, string][] = [];
        response.headers.forEach((value, key) => {
          headerEntries.push([key, value]);
        });
        nodeRes.writeHead(response.status, Object.fromEntries(headerEntries));

        // Stream body
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              nodeRes.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        nodeRes.end();
      } catch (err) {
        console.error("[lore] polyfill: request handler error:", err);
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "content-type": "application/json" });
        }
        nodeRes.end(JSON.stringify({ error: "Internal server error" }));
      }
    });

    server.listen(opts.port, opts.hostname);

    return {
      stop: () => server.close(),
      get port() {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) return addr.port;
        return opts.port;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Bun.zstdCompressSync / Bun.zstdDecompressSync → node:zlib
  // ---------------------------------------------------------------------------

  function zstdCompressSync(buf: Uint8Array | Buffer): Buffer {
    return (zlib as any).zstdCompressSync(buf);
  }

  function zstdDecompressSync(buf: Uint8Array | Buffer): Buffer {
    return (zlib as any).zstdDecompressSync(buf);
  }

  // ---------------------------------------------------------------------------
  // Bun.which() → child_process fallback
  // ---------------------------------------------------------------------------

  function which(binary: string): string | null {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = cp.execFileSync(cmd, [binary], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const path = result.trim().split("\n")[0];
      return path || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Install the Bun global
  // ---------------------------------------------------------------------------

  (globalThis as any).Bun = {
    serve,
    zstdCompressSync,
    zstdDecompressSync,
    which,
    // Bun.main — set to null so `Bun.main === import.meta.path` is always
    // false under Node.js (prevents direct-execution code path in index.ts).
    main: null,
  };
}
