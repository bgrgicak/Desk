/**
 * Integration tests for `DELETE /agents/:id`.
 *
 * Real Postgres, real HTTP, memory scheduler. Verifies the agent row goes
 * away, FK cascades clean up chats + messages + workspace memberships, and
 * cross-tenant isolation is honored (existence-hiding 404 for foreign ids).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let alphaToken: string;
let alphaUserId: string;
let alphaWorkspaceId: string;
let betaToken: string;
let betaUserId: string;

function request(
  method: string,
  urlPath: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
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

async function seedUser(suffix: string): Promise<{
  userId: string;
  token: string;
  workspaceId: string;
}> {
  const userId = generateId("user");
  const username = `agentdel_${suffix}`;
  const password = `pw-${suffix}`;
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
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
  const login = await request("POST", "/auth/login", null, { username, password });
  const token = (login.body as { token: string }).token;
  return { userId, token, workspaceId };
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-agent-delete-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-agent-delete-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });

  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  ({ userId: alphaUserId, token: alphaToken, workspaceId: alphaWorkspaceId } =
    await seedUser("alpha"));
  ({ userId: betaUserId, token: betaToken } = await seedUser("beta"));
  void betaUserId;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

async function insertAgent(userId: string, name: string): Promise<string> {
  const id = generateId("agent");
  await queries.agents.insert(pool, {
    id,
    userId,
    name,
    model: "opencode/gpt-5-nano",
  });
  return id;
}

describe("DELETE /agents/:id", () => {
  it("deletes the agent row and cascades chats + workspace memberships", async () => {
    // Rule: cannot delete the user's last agent. Seed a sibling so the
    // happy-path delete is legal.
    const keeperId = await insertAgent(alphaUserId, "keeper-happy");
    const agentId  = await insertAgent(alphaUserId, "disposable");
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?)`,
      [alphaWorkspaceId, agentId],
    );

    // Create a chat owned by this agent so we can prove the cascade fires.
    const chatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: chatId,
      workspaceId: alphaWorkspaceId,
      agentId,
      title: "chat-for-disposable",
    });

    const del = await request("DELETE", `/agents/${agentId}`, alphaToken);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const agentRows = await pool.query("SELECT id FROM agents WHERE id = ?", [agentId]);
    expect(agentRows.rowCount).toBe(0);

    const chatRows = await pool.query("SELECT id FROM chats WHERE id = ?", [chatId]);
    expect(chatRows.rowCount).toBe(0);

    const wsAgentRows = await pool.query(
      "SELECT * FROM workspace_agents WHERE agent_id = ?",
      [agentId],
    );
    expect(wsAgentRows.rowCount).toBe(0);

    const refetch = await request("GET", `/agents/${agentId}`, alphaToken);
    expect(refetch.status).toBe(404);

    // Clean up the sibling so subsequent tests start from a known state.
    await queries.agents.remove(pool, keeperId);
  });

  it("refuses to delete the user's last agent with 400", async () => {
    const onlyAgentId = await insertAgent(alphaUserId, "only-agent");

    const res = await request("DELETE", `/agents/${onlyAgentId}`, alphaToken);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION" });

    // Row is still there.
    const rows = await pool.query("SELECT id FROM agents WHERE id = ?", [onlyAgentId]);
    expect(rows.rowCount).toBe(1);

    // Sanity: once a sibling exists, deletion is allowed.
    const siblingId = await insertAgent(alphaUserId, "sibling");
    const delOk = await request("DELETE", `/agents/${onlyAgentId}`, alphaToken);
    expect(delOk.status).toBe(200);
    await queries.agents.remove(pool, siblingId);
  });

  it("returns 404 on a missing id", async () => {
    // Seed so the last-agent guard doesn't preempt the not-found check.
    const keeperId = await insertAgent(alphaUserId, "keeper-missing");
    const res = await request("DELETE", "/agents/agent_does_not_exist", alphaToken);
    expect(res.status).toBe(404);
    await queries.agents.remove(pool, keeperId);
  });

  it("hides foreign agents behind a 404 (cross-tenant isolation)", async () => {
    const foreignAgentId = await insertAgent(alphaUserId, "alpha-only");

    const res = await request("DELETE", `/agents/${foreignAgentId}`, betaToken);
    expect(res.status).toBe(404);

    // Alpha's row is untouched.
    const rows = await pool.query("SELECT id FROM agents WHERE id = ?", [foreignAgentId]);
    expect(rows.rowCount).toBe(1);

    await queries.agents.remove(pool, foreignAgentId);
  });
});
