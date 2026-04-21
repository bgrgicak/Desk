import { describe, it, expect, afterEach, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

function stubOpts(): AppOptions {
  return {
    pool: {} as any,
    storage: {} as any,
    runManager: { enqueueRun: async () => ({}), cancelRun: async () => {}, cancelJob: async () => {}, adapter: {} } as any,
    broadcastUserId: "usr_apptest",
  };
}

function getServerPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

let servers: http.Server[] = [];

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp(stubOpts());
    server.listen(0, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

afterEach(() => {
  clearSessions();
  clearConnections();
});

afterAll(() => {
  for (const s of servers) s.close();
});

describe("app route dispatch", () => {
  it("GET /openapi.json returns a valid spec without auth", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const res = await request(port, "GET", "/openapi.json");
    expect(res.status).toBe(200);

    const spec = res.body as Record<string, unknown>;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths).toBeTruthy();
    expect(Object.keys(spec.paths as object).length).toBeGreaterThan(10);
  });

  it("DELETE /me returns 200 with ok message", async () => {
    const server = await startServer();
    const port = getServerPort(server);
    const token = issueSession("usr_test");

    const res = await request(port, "DELETE", "/me", token);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
  });

  it("unauthenticated request returns 401", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const res = await request(port, "GET", "/me");
    expect(res.status).toBe(401);
  });

  it("unknown route returns 404", async () => {
    const server = await startServer();
    const port = getServerPort(server);
    const token = issueSession("usr_test");

    const res = await request(port, "GET", "/nonexistent", token);
    expect(res.status).toBe(404);
  });
});
