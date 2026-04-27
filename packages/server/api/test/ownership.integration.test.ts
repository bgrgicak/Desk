/**
 * Multi-user ownership integration test (G8).
 *
 * Seeds two users (A and B), gives each a workspace + agent + chat + message,
 * then asserts user B's session can't read or mutate user A's resources — all
 * cross-tenant accesses return 404 (not 403) to avoid leaking existence.
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
import { createRunManager, createMemoryAdapter } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_ownership_${workerId}`;

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

interface Seeded {
  userId: string;
  token: string;
  workspaceId: string;
  agentId: string;
  chatId: string;
  messageId: string;
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let alpha: Seeded;
let beta: Seeded;

async function seedUser(suffix: string): Promise<Seeded> {
  const userId = generateId("user");
  const username = `user_${suffix}`;
  const password = "pw-for-" + suffix;
  const passwordHash = await hashPassword(password);
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash,
    email: `${username}@example.com`,
  });

  const workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: `ws-${suffix}`,
    description: "",
    icon: "",
  });

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: `agent-${suffix}`,
    instructions: "",
    model: "anthropic/claude-sonnet-4-5",
  });

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES ($1, $2)`,
    [workspaceId, agentId],
  );

  const chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, `chat-${suffix}`],
  );

  const messageId = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [messageId, chatId, JSON.stringify({ type: "text", text: `hello from ${suffix}` })],
  );

  const login = await request("POST", "/auth/login", null, {
    username,
    password,
  });
  const token = (login.body as { token: string }).token;

  return { userId, token, workspaceId, agentId, chatId, messageId };
}

function request(
  method: string,
  pathStr: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathStr, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
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
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch {
    /* ok */
  }
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ownership-"));
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

  alpha = await seedUser("alpha");
  beta = await seedUser("beta");
});

afterAll(async () => {
  await clearSessions(pool);
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

describe("G8: cross-user access returns 404", () => {
  it("/workspaces returns only the caller's workspaces", async () => {
    const res = await request("GET", "/workspaces", beta.token);
    expect(res.status).toBe(200);
    const items = res.body as Array<{ id: string }>;
    expect(items.map((w) => w.id)).not.toContain(alpha.workspaceId);
    expect(items.map((w) => w.id)).toContain(beta.workspaceId);
  });

  it("GET /workspaces/{id} on a peer's workspace returns 404", async () => {
    const res = await request("GET", `/workspaces/${alpha.workspaceId}`, beta.token);
    expect(res.status).toBe(404);
  });

  it("PATCH /workspaces/{id} on a peer's workspace returns 404", async () => {
    const res = await request("PATCH", `/workspaces/${alpha.workspaceId}`, beta.token, {
      name: "attacker-rename",
    });
    expect(res.status).toBe(404);

    // Confirm unchanged.
    const ws = await queries.workspaces.findById(pool, alpha.workspaceId);
    expect(ws?.name).toBe("ws-alpha");
  });

  it("GET /agents/{id} on a peer's agent returns 404", async () => {
    const res = await request("GET", `/agents/${alpha.agentId}`, beta.token);
    expect(res.status).toBe(404);
  });

  it("GET /chats/{id} on a peer's chat returns 404", async () => {
    const res = await request("GET", `/chats/${alpha.chatId}`, beta.token);
    expect(res.status).toBe(404);
  });

  it("GET /chats/{id}/messages on a peer's chat returns 404", async () => {
    const res = await request("GET", `/chats/${alpha.chatId}/messages`, beta.token);
    expect(res.status).toBe(404);
  });

  it("POST /chats/{id}/messages on a peer's chat returns 404", async () => {
    const res = await request("POST", `/chats/${alpha.chatId}/messages`, beta.token, {
      content: "sneak in",
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /chats/{id}/messages/{id} on a peer's message returns 404", async () => {
    const res = await request(
      "PATCH",
      `/chats/${alpha.chatId}/messages/${alpha.messageId}`,
      beta.token,
      { content: { type: "text", text: "tamper" } },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /chats/{id}/messages/{id} on a peer's message returns 404", async () => {
    const res = await request(
      "DELETE",
      `/chats/${alpha.chatId}/messages/${alpha.messageId}`,
      beta.token,
    );
    expect(res.status).toBe(404);
  });

  it("POST /chats with a peer's workspace returns 404", async () => {
    const res = await request("POST", "/chats", beta.token, {
      workspaceId: alpha.workspaceId,
      agentId: beta.agentId,
      title: "sneaky",
    });
    expect(res.status).toBe(404);
  });

  it("owner still gets their own resources normally", async () => {
    const ws = await request("GET", `/workspaces/${alpha.workspaceId}`, alpha.token);
    expect(ws.status).toBe(200);
    const chat = await request("GET", `/chats/${alpha.chatId}`, alpha.token);
    expect(chat.status).toBe(200);
  });
});
