/**
 * Integration test for `POST /workspaces` auto-enrolling an agent.
 *
 * A freshly-created workspace has no agents until one is enrolled, which
 * means chat creation rejects every agentId. To keep new workspaces
 * chat-ready by default, `createWorkspace` auto-enrolls the caller's
 * first agent or creates a default opencode-backed agent when none exists.
 * Users can change the agent model via the settings modal afterwards.
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-autoenroll-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-autoenroll-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
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
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

async function insertAgent(name: string): Promise<string> {
  const id = generateId("agent");
  await queries.agents.insert(pool, {
    id,
    userId,
    name,
    model: "anthropic/claude-haiku-4-5",
  });
  return id;
}

describe("POST /workspaces — ensure a default workspace agent", () => {
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

    const deleteRes = await request("DELETE", `/agents/${alphaId}`, token);
    expect(deleteRes.status).toBe(400);

    const stillEnrolled = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(stillEnrolled).toHaveLength(1);
    expect(stillEnrolled[0].agentId).toBe(alphaId);
  });

  it("creates and enrolls a default Anthropic agent for a user with no agents", async () => {
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
      name: "test-memory",
    });
    expect(res.status).toBe(201);
    const ws = res.body as { id: string };

    const memberships = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(memberships).toHaveLength(1);

    const agent = await queries.agents.findById(pool, memberships[0].agentId);
    expect(agent).toMatchObject({
      userId: otherUserId,
      name: "Desk",
      model: "anthropic/claude-haiku-4-5",
    });

    const listRes = await request("GET", `/workspaces/${ws.id}/agents`, otherToken);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toMatchObject([
      { id: memberships[0].agentId, model: "anthropic/claude-haiku-4-5" },
    ]);

    const patchRes = await request("PATCH", `/agents/${memberships[0].agentId}`, otherToken, {
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({
      id: memberships[0].agentId,
      model: "anthropic/claude-sonnet-4-5",
    });

    const removeRes = await request(
      "DELETE",
      `/workspaces/${ws.id}/agents/${memberships[0].agentId}`,
      otherToken,
    );
    expect(removeRes.status).toBe(400);

    const stillEnrolled = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(stillEnrolled).toHaveLength(1);
  });

  it("repairs an existing workspace that has no enrolled agent", async () => {
    const repairUserId = generateId("user");
    await queries.users.insert(pool, {
      id: repairUserId,
      username: "repair-noagents",
      passwordHash: await hashPassword("pw"),
      email: "repair-noagents@example.com",
    });
    const login = await request("POST", "/auth/login", null, {
      username: "repair-noagents",
      password: "pw",
    });
    const repairToken = (login.body as { token: string }).token;
    const ws = await queries.workspaces.insert(pool, {
      id: generateId("workspace"),
      userId: repairUserId,
      name: "legacy-empty",
      path: "legacy-empty",
    });

    const before = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(before).toHaveLength(0);

    const listRes = await request("GET", `/workspaces/${ws.id}/agents`, repairToken);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toMatchObject([
      { name: "Desk", model: "anthropic/claude-haiku-4-5" },
    ]);

    const after = await queries.workspaceAgents.listForWorkspace(pool, ws.id);
    expect(after).toHaveLength(1);
  });
});
