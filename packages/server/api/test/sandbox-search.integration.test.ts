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
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";
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
let foreignWorkspaceSlug: string;
let workspaceAId: string;
let workspaceBId: string;
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
  await fs.mkdir(path.join(workspaceRootPath(home, workspaceASlug), "tools"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRootPath(home, workspaceASlug), "tools", "volume-converter.md"),
    "Volume converter for cubic meter to cubic inch calculations.",
    "utf-8",
  );

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
  await fs.mkdir(path.join(workspaceRootPath(home, workspaceBSlug), "tools"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRootPath(home, workspaceBSlug), "tools", "watercolor-reference.md"),
    "Watercolor owl reference library item.",
    "utf-8",
  );

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

  const foreignUserId = generateId("user");
  const foreignAgentId = generateId("agent");
  const foreignWorkspaceId = generateId("workspace");
  const foreignChatId = generateId("chat");
  foreignWorkspaceSlug = `foreign-${foreignWorkspaceId.slice(-6)}`;
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email) VALUES (?, ?, ?, ?)`,
    [foreignUserId, "other-search-user", "pw", "other-search@example.com"],
  );
  await pool.query(
    `INSERT INTO agents (id, user_id, name) VALUES (?, ?, ?)`,
    [foreignAgentId, foreignUserId, "Other Agent"],
  );
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
    [foreignWorkspaceId, foreignUserId, "Foreign WS", foreignWorkspaceSlug],
  );
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [foreignWorkspaceId, foreignAgentId],
  );
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [foreignChatId, foreignWorkspaceId, foreignAgentId, "Foreign Chat"],
  );
  await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId: foreignChatId,
    role: "user",
    content: {
      type: "text",
      text: "top secret foreign workspace keyword watercolor watercolor watercolor",
    },
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

  it("does not widen to other workspaces when workspace=* is passed", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("watercolor")}&workspace=*&limit=1`,
      token,
    );
    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("rejects an explicit owned workspace slug outside the sandbox session workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("watercolor")}&workspace=${workspaceBSlug}`,
      token,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an explicit workspace slug not owned by the sandbox agent's user", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("foreign")}&workspace=${foreignWorkspaceSlug}`,
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

  it("rejects chat filters outside the sandbox session workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search/messages?q=${encodeURIComponent("watercolor")}&chat=${chatB}`,
      token,
    );
    expect(res.status).toBe(404);
  });

  it("rejects missing or invalid sandbox token with 401", async () => {
    const res = await sandboxGet(
      `/sandbox/search/messages?q=anything`,
      "tok_does-not-exist",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /sandbox/search", () => {
  it("uses the universal search backend scoped to the sandbox workspace by default", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search?q=${encodeURIComponent("Chat A")}&kind=chat`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ type: string; id: string; workspaceSlug: string }> };
    expect(body.hits.some((hit) => hit.type === "chat" && hit.id === chatA && hit.workspaceSlug === workspaceASlug)).toBe(true);
  });

  it("does not surface chat hits from a different workspace by default", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search?q=${encodeURIComponent("watercolor")}&scope=chats&kind=message`,
      token,
    );

    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("does not widen universal search when workspace=* is passed", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search?q=${encodeURIComponent("watercolor")}&workspace=*&scope=chats&kind=message`,
      token,
    );

    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("does not widen universal library search when workspace=* is passed", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search?q=${encodeURIComponent("watercolor reference")}&workspace=*&scope=library`,
      token,
    );

    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("rejects an explicit owned workspace slug outside the sandbox session workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/search?q=${encodeURIComponent("watercolor")}&workspace=${workspaceBSlug}`,
      token,
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /sandbox/find/library", () => {
  it("defaults library discovery to the sandbox session workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/library?q=${encodeURIComponent("volume converter")}&kind=note`,
      token,
    );

    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string; workspaceSlug: string }> };
    expect(body.hits.some((hit) => hit.path === "tools/volume-converter.md" && hit.workspaceSlug === workspaceASlug)).toBe(true);
    expect(body.hits.every((hit) => hit.workspaceSlug === workspaceASlug)).toBe(true);
  });

  it("does not widen library discovery when workspace=* is passed", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/library?q=${encodeURIComponent("watercolor reference")}&workspace=*&kind=note`,
      token,
    );

    expect(res.status).toBe(200);
    expect((res.body as { hits: unknown[] }).hits).toEqual([]);
  });

  it("rejects an explicit owned workspace slug outside the sandbox session workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/library?q=${encodeURIComponent("watercolor reference")}&workspace=${workspaceBSlug}&kind=note`,
      token,
    );

    expect(res.status).toBe(404);
  });

  it("keeps /sandbox/find/artifacts as a compatibility alias", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("volume converter")}&kind=note`,
      token,
    );

    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string; workspaceSlug: string }> };
    expect(body.hits.some((hit) => hit.path === "tools/volume-converter.md" && hit.workspaceSlug === workspaceASlug)).toBe(true);
  });

  it("rejects missing or invalid sandbox token with 401", async () => {
    const res = await sandboxGet(`/sandbox/find/library?q=volume`, "tok_does-not-exist");
    expect(res.status).toBe(401);
  });
});
