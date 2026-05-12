import { describe, test, expect, afterAll } from "bun:test";
import { probeGateway } from "../src/index";

/**
 * Smoke tests for the in-process gateway startup.
 *
 * These exercise startGateway from @loreai/gateway directly (which is what
 * the plugin's startInProcess delegates to). Tests use ephemeral ports so
 * they don't collide with a running gateway.
 */

// Track shutdown handles to clean up after tests.
const shutdowns: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const shutdown of shutdowns) {
    await shutdown();
  }
});

describe("in-process gateway startup", () => {
  test("probeGateway returns false for a port with nothing listening", async () => {
    // Use a random high port that's almost certainly not in use.
    const result = await probeGateway("http://127.0.0.1:19876", 500);
    expect(result).toBe(false);
  });

  test("startGateway starts the gateway and responds to health checks", async () => {
    // Use the gateway API directly with an ephemeral port.
    const gwPkg = "@loreai/gateway";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = await import(gwPkg) as any;
    const config = gw.loadConfig();
    config.port = 0; // ephemeral

    const server = gw.startServer(config) as { stop: () => void; port: number; hosts: string[] };
    shutdowns.push(async () => server.stop());
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

  test("startServer with explicit port starts on that port", async () => {
    // Use startServer directly (lighter than startGateway — avoids
    // embedding worker init which triggers Bun NAPI teardown crashes).
    const gwPkg = "@loreai/gateway";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = await import(gwPkg) as any;

    // Find a free port first.
    const tmpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("tmp"),
    });
    const freePort = tmpServer.port!;
    tmpServer.stop(true);

    // Small delay to ensure the port is released.
    await Bun.sleep(50);

    const config = gw.loadConfig();
    config.port = freePort;
    const server = gw.startServer(config) as { stop: () => void; port: number; hosts: string[] };
    shutdowns.push(async () => server.stop());

    expect(server.port).toBe(freePort);

    // Verify the gateway is actually serving.
    const base = `http://127.0.0.1:${server.port}`;
    const healthy = await probeGateway(base, 2000);
    expect(healthy).toBe(true);
  });

  test("probeGateway returns true for a running health endpoint", async () => {
    // Occupy a port with a server that responds to /health like a lore gateway.
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
      const result = await probeGateway(base, 2000);
      expect(result).toBe(true);
    } finally {
      occupier.stop(true);
    }
  });
});
