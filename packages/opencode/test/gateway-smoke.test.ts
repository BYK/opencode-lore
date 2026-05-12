import { describe, test, expect, afterAll } from "bun:test";
import { startInProcess, probeGateway } from "../src/index";

/**
 * Smoke tests for the in-process gateway startup.
 *
 * These exercise the real startInProcess → loadConfig → startServer path
 * on an ephemeral port so they don't collide with a running gateway.
 */

// Track servers to stop after tests. startServer returns { stop, port, hosts }
// but startInProcess doesn't expose the stop handle — we import startServer
// directly for cleanup.
let stopServer: (() => void) | null = null;

afterAll(() => {
  stopServer?.();
});

describe("in-process gateway startup", () => {
  test("probeGateway returns false for a port with nothing listening", async () => {
    // Use a random high port that's almost certainly not in use.
    const result = await probeGateway("http://127.0.0.1:19876", 500);
    expect(result).toBe(false);
  });

  test("startInProcess starts the gateway and responds to health checks", async () => {
    // Use port 0 via env var so the OS assigns an ephemeral port.
    // loadConfig reads LORE_LISTEN_PORT; startInProcess parses the URL port.
    // We need to start the server first to discover the actual port, so we
    // use the gateway API directly for this test. Use a variable to prevent
    // tsc from resolving the module at compile time.
    const gwPkg = "@loreai/gateway";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = await import(gwPkg) as any;
    const config = gw.loadConfig();
    config.port = 0; // ephemeral

    const server = gw.startServer(config) as { stop: () => void; port: number; hosts: string[] };
    stopServer = server.stop;
    const port = server.port;
    const base = `http://127.0.0.1:${port}`;

    // The server should be immediately healthy (Bun.serve is synchronous).
    const healthy = await probeGateway(base, 2000);
    expect(healthy).toBe(true);

    // Verify the health endpoint returns expected shape.
    const res = await fetch(`${base}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("startInProcess returns true on success", async () => {
    // Start a fresh server via startInProcess on another ephemeral port.
    // Since startInProcess parses the port from the URL, we first need a
    // free port. Bind a temporary TCP server, grab its port, close it, then
    // pass that port to startInProcess.
    const tmpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("tmp"),
    });
    const freePort = tmpServer.port;
    tmpServer.stop(true);

    // Small delay to ensure the port is released.
    await Bun.sleep(50);

    const base = `http://127.0.0.1:${freePort}`;
    const result = await startInProcess(base);
    expect(result).toBe(true);

    // Verify the gateway is actually serving.
    const healthy = await probeGateway(base, 2000);
    expect(healthy).toBe(true);
  });

  test("startInProcess handles EADDRINUSE gracefully", async () => {
    // Occupy a port with a server that responds to /health.
    const occupier = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname === "/health") {
          return Response.json({ status: "ok" });
        }
        return new Response("occupied", { status: 404 });
      },
    });
    const occupiedPort = occupier.port;

    try {
      const base = `http://127.0.0.1:${occupiedPort}`;
      // startInProcess should catch EADDRINUSE and fall back to probing,
      // which succeeds because our occupier responds to /health.
      const result = await startInProcess(base);
      expect(result).toBe(true);
    } finally {
      occupier.stop(true);
    }
  });
});
