import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceASlug: string;
let workspaceBSlug: string;
let workspaceAId: string;
let workspaceBId: string;
let otherUserWorkspaceSlug: string;
let chatA: string;
let chatB: string;
let agentId: string;
let userId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-search-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "search-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-search-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceAId = wsRows[0].id;
  workspaceASlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceASlug);

  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id;

  // Spin up a second workspace owned by the same user.
  workspaceBId = generateId("workspace");
  workspaceBSlug = `wsb-${workspaceBId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
    [workspaceBId, userId, "WS B", workspaceBSlug],
  );
  await ensureWorkspaceLayout(home, workspaceBSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id;
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceBId, agentId],
  );

  chatA = generateId("chat");
  chatB = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [chatA, workspaceAId, agentId, "Chat A", chatB, workspaceBId, agentId, "Chat B"],
  );

  await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId: chatA,
    role: "user",
    content: { type: "text", text: "I want to track my kanban board state." },
  });
  await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId: chatB,
    role: "user",
    content: { type: "text", text: "Generate a watercolor of an owl." },
  });

  const otherUserId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'search-other', 'hash', 'search-other@example.com')`,
    [otherUserId],
  );
  const otherWorkspaceId = generateId("workspace");
  otherUserWorkspaceSlug = `other-${otherWorkspaceId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
    [otherWorkspaceId, otherUserId, "Other WS", otherUserWorkspaceSlug],
  );
  await ensureWorkspaceLayout(home, otherUserWorkspaceSlug);
  const otherAgentId = generateId("agent");
  await pool.query(
    `INSERT INTO agents (id, user_id, name, model) VALUES (?, ?, 'Other Agent', 'opencode/big-pickle')`,
    [otherAgentId, otherUserId],
  );
  const otherChatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [otherChatId, otherWorkspaceId, otherAgentId, "Other Chat"],
  );
  await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId: otherChatId,
    role: "user",
    content: { type: "text", text: "Private lemur discussion." },
  });

  const runManager = createRunManager({ pool });
  server = createApp({
    pool,
    storage: { pool, home },
    runManager,
    broadcastUserId: userId,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
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

function sandboxGet(
  urlPath: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { "X-Desk-Sandbox-Token": token },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function issueSandboxToken(workspaceId: string): Promise<string> {
  const token = `tok_${crypto.randomBytes(16).toString("hex")}`;
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  return token;
}

describe("GET /sandbox/search/messages", () => {
  it("returns hits scoped to the session's workspace by default", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("kanban")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ workspaceSlug: string; snippet: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
    for (const hit of body.hits) {
      expect(hit.workspaceSlug).toBe(workspaceASlug);
    }
  });

  it("does not surface hits from a different workspace by default", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("watercolor")}`,
      token,
    );
    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("widens to all of the user's workspaces when workspace=*", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("watercolor")}&workspace=*`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ workspaceSlug: string }> };
    expect(body.hits.length).toBe(1);
    expect(body.hits[0].workspaceSlug).toBe(workspaceBSlug);
  });

  it("rejects an explicit workspace slug not owned by the sandbox user", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("lemur")}&workspace=${encodeURIComponent(otherUserWorkspaceSlug)}`,
      token,
    );
    expect(res.status).toBe(404);
  });

  it("filters by chat when chat=<id> is passed", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("kanban")}&chat=${chatA}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ chatId: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
    for (const hit of body.hits) {
      expect(hit.chatId).toBe(chatA);
    }
  });

  it("rejects missing or invalid sandbox token with 401", async () => {
    const res = await sandboxGet(
      `/sandbox/search/messages?q=anything`,
      "tok_does-not-exist",
    );
    expect(res.status).toBe(401);
  });
});
