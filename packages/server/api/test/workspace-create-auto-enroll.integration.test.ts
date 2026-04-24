/**
 * Integration test for `POST /workspaces` auto-enrolling an agent.
 *
 * A freshly-created workspace has no agents until one is enrolled, which
 * means chat creation rejects every agentId. To keep new workspaces
 * chat-ready by default, `createWorkspace` auto-enrolls the caller's
 * first agent (from `listByUser`) and marks it default. Users can override
 * the enrollment via the settings modal afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, queries, hashPassword } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_ws_autoenroll_${workerId}`;

function adminConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let userId: string;

function request(
  method: string,
  urlPath: string,
  t: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (t) headers.Authorization = `Bearer ${t}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
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
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-autoenroll-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "autoenroll",
    passwordHash: await hashPassword("pw"),
    email: "autoenroll@example.com",
  });
  const login = await request("POST", "/auth/login", null, {
    username: "autoenroll",
    password: "pw",
  });
  token = (login.body as { token: string }).token;
});

afterAll(async () => {
  clearSessions();
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  delete process.env.DESK_HOME;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
});

async function insertAgent(name: string): Promise<string> {
  const id = generateId("agent");
  await queries.agents.insert(pool, {
    id,
    userId,
    name,
    instructions: "",
    model: "anthropic/claude-sonnet-4-5",
    toolAllowlist: [],
  });
  return id;
}

describe("POST /workspaces — auto-enroll caller's first agent", () => {
  it("enrolls the first agent from listByUser and marks it default", async () => {
    // Insert two agents; `listByUser` orders by name, so "alpha" is first.
    const alphaId = await insertAgent("alpha");
    await insertAgent("zeta");

    const res = await request("POST", "/workspaces", token, {
      name: "fresh",
    });
    expect(res.status).toBe(201);
    const ws = res.body as { id: string };

    const memberships = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].agentId).toBe(alphaId);
  });

  it("skips enrollment for a user with no agents (does not crash)", async () => {
    // Build a second user with zero agents and confirm workspace creation
    // still succeeds — no agent gets enrolled, and chat creation would
    // require the user to enroll one manually.
    const otherUserId = generateId("user");
    await queries.users.insert(pool, {
      id: otherUserId,
      username: "noagents",
      passwordHash: await hashPassword("pw"),
      email: "noagents@example.com",
    });
    const login = await request("POST", "/auth/login", null, {
      username: "noagents",
      password: "pw",
    });
    const otherToken = (login.body as { token: string }).token;

    const res = await request("POST", "/workspaces", otherToken, {
      name: "empty",
    });
    expect(res.status).toBe(201);
    const ws = res.body as { id: string };

    const memberships = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(memberships).toHaveLength(0);
  });
});
