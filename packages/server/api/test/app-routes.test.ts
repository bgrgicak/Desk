import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let home: string;
let userId: string;
let dbPath: string;

function getServerPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function appOpts(): AppOptions {
  return {
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
    broadcastUserId: userId,
  };
}

let servers: http.Server[] = [];

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp(appOpts());
    server.listen(0, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function request(
  port: number,
  method: string,
  reqPath: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-routes-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-routes-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "app-routes-test",
    passwordHash: "$2b$10$placeholder",
    email: "app-routes@example.com",
  });
});

afterEach(async () => {
  await clearSessions(pool);
  clearConnections();
});

afterAll(async () => {
  for (const s of servers) s.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
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
    // Re-seed the user — DELETE /me wipes it, and other tests in this
    // file expect the row to exist when they issue a session against it.
    await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
    await queries.users.insert(pool, {
      id: userId,
      username: "delete-me-test",
      passwordHash: "$2b$10$placeholder",
      email: "delete-me@example.com",
    });
    const server = await startServer();
    const port = getServerPort(server);
    const token = await issueSession(pool, userId);

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
    // Re-seed in case a prior test deleted the user.
    await pool.query(
      `INSERT INTO users (id, username, password_hash, email)
            VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [userId, "unknown-route-test", "$2b$10$placeholder", "unknown@example.com"],
    );
    const server = await startServer();
    const port = getServerPort(server);
    const token = await issueSession(pool, userId);

    const res = await request(port, "GET", "/nonexistent", token);
    expect(res.status).toBe(404);
  });
});
