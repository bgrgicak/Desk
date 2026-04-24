/**
 * Integration tests for `POST /workspaces/:id/default-agent`.
 *
 * The route auto-enrolls the agent into the workspace before flipping the
 * `is_default` flag — clicking "make default" on a globally-listed agent
 * must not 404 just because it isn't separately enrolled. Owner-mismatch is
 * still rejected (delegated to addAgentToWorkspace).
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
const testDbName = `desk_ws_default_agent_${workerId}`;

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
let workspaceId: string;

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

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-default-"));
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
    username: "wsd-agent",
    passwordHash: await hashPassword("pw"),
    email: "wsd-agent@example.com",
  });
  workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "primary",
    description: "",
    icon: "",
  });
  const login = await request("POST", "/auth/login", null, {
    username: "wsd-agent",
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

describe("POST /workspaces/:id/default-agent", () => {
  it("auto-enrolls a non-member agent and marks it default", async () => {
    const agentId = await insertAgent("auto-enroll-target");

    const res = await request(
      "POST",
      `/workspaces/${workspaceId}/default-agent`,
      token,
      { agentId },
    );
    expect(res.status).toBe(200);

    const list = await queries.workspaceAgents.listForWorkspace(pool, workspaceId);
    const row = list.find(m => m.agentId === agentId);
    expect(row).toBeTruthy();
    expect(row?.isDefault).toBe(true);

    // Exactly one default per workspace (enforced by partial unique index).
    const defaults = list.filter(m => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].agentId).toBe(agentId);
  });

  it("promotes an already-enrolled agent and demotes the previous default", async () => {
    const challenger = await insertAgent("challenger");
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
       VALUES ($1, $2, false)`,
      [workspaceId, challenger],
    );

    const before = await queries.workspaceAgents.getDefault(pool, workspaceId);
    expect(before?.agentId).not.toBe(challenger);

    const res = await request(
      "POST",
      `/workspaces/${workspaceId}/default-agent`,
      token,
      { agentId: challenger },
    );
    expect(res.status).toBe(200);

    const after = await queries.workspaceAgents.getDefault(pool, workspaceId);
    expect(after?.agentId).toBe(challenger);
  });
});
