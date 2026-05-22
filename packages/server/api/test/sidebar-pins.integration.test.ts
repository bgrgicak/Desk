/**
 * Integration tests for the sidebar Pinned section's two endpoints:
 *
 *  • POST/DELETE /workspaces/{id}/library-pins — now accepts directory
 *    paths in addition to files. Previously rejected anything that
 *    wasn't a file or `.app/` directory (statFile vs statPath).
 *
 *  • POST/DELETE /workspaces/{id}/chat-pins — new endpoint for pinning
 *    a chat by id. The chat list response carries `pinned: true` after
 *    POST and `pinned: false` after DELETE.
 *
 * Real SQLite, real filesystem.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { runMigrations, queries, hashPassword } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let alpha: SeededUser;

interface SeededUser {
  userId: string;
  token: string;
  workspaceId: string;
  workspacePath: string;
  agentId: string;
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

async function seedUser(suffix: string): Promise<SeededUser> {
  const userId = generateId("user");
  const username = `sidebar_${suffix}`;
  const password = `pw-${suffix}`;
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
    email: `${username}@example.com`,
  });

  const workspaceId = generateId("workspace");
  const ws = await queries.workspaces.insert(pool, {
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
    model: "anthropic/claude-haiku-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );

  const login = await request("POST", "/auth/login", null, { email: `${username}@example.com`, password });
  const token = (login.body as { token: string }).token;

  return { userId, token, workspaceId, workspacePath: ws.path, agentId };
}

async function createChat(owner: SeededUser, title: string): Promise<string> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId: owner.workspaceId,
    agentId: owner.agentId,
    title,
  });
  return chatId;
}

/** Creates a real directory inside the workspace library so the path is statable. */
async function mkLibraryDir(slug: string, relPath: string): Promise<string> {
  const abs = path.join(home, slug, relPath);
  await fs.mkdir(abs, { recursive: true });
  return relPath.split(path.sep).join("/");
}

async function writeLibraryFile(slug: string, relPath: string, body: string): Promise<string> {
  const abs = path.join(home, slug, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return relPath.split(path.sep).join("/");
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sidebar-pins-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sidebar-pins-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });

  const broadcastUserId = generateId("user");
  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  alpha = await seedUser("alpha");
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

describe("library-pins accepts directories", () => {
  it("pins a plain directory (not just files and .app dirs) and surfaces it in the library list", async () => {
    const folderPath = await mkLibraryDir(alpha.workspacePath, "Projects/Q2");

    const pin = await request("POST", `/workspaces/${alpha.workspaceId}/library-pins`, alpha.token, {
      path: folderPath,
    });
    expect(pin.status).toBe(201);

    // GET /library?pinned=true returns every pinned entry workspace-wide;
    // the sidebar uses this view rather than walking the recursive tree.
    const list = await request("GET", `/library?workspaceId=${encodeURIComponent(alpha.workspaceId)}&pinned=true`, alpha.token);
    expect(list.status).toBe(200);
    const folders = (list.body as { folders: { path: string; pinned?: boolean }[] }).folders;
    const ours = folders.find((f) => f.path === folderPath);
    expect(ours).toBeDefined();
    expect(ours!.pinned).toBe(true);

    const unpin = await request("DELETE", `/workspaces/${alpha.workspaceId}/library-pins`, alpha.token, {
      path: folderPath,
    });
    expect(unpin.status).toBe(200);

    const after = await request("GET", `/library?workspaceId=${encodeURIComponent(alpha.workspaceId)}&pinned=true`, alpha.token);
    const foldersAfter = (after.body as { folders: { path: string; pinned?: boolean }[] }).folders;
    expect(foldersAfter.find((f) => f.path === folderPath)).toBeUndefined();
  });

  it("still accepts regular files (regression — relaxing the stat check shouldn't break files)", async () => {
    const filePath = await writeLibraryFile(alpha.workspacePath, "notes.md", "hi");
    const pin = await request("POST", `/workspaces/${alpha.workspaceId}/library-pins`, alpha.token, {
      path: filePath,
    });
    expect(pin.status).toBe(201);
  });

  it("rejects pins for paths that do not exist", async () => {
    const res = await request("POST", `/workspaces/${alpha.workspaceId}/library-pins`, alpha.token, {
      path: "does-not-exist/never",
    });
    // statPath throws NotFoundError → mapped to 404 by the error handler.
    expect(res.status).toBe(404);
  });
});

describe("chat-pins endpoint", () => {
  it("pins a chat, surfaces pinned: true in /chats list, and unpins cleanly", async () => {
    const chatId = await createChat(alpha, "pin me");

    const list1 = await request("GET", `/chats?workspaceId=${encodeURIComponent(alpha.workspaceId)}`, alpha.token);
    expect(list1.status).toBe(200);
    const before = (list1.body as { id: string; pinned?: boolean }[]).find((c) => c.id === chatId);
    expect(before?.pinned ?? false).toBe(false);

    const pin = await request("POST", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, { chatId });
    expect(pin.status).toBe(201);

    const list2 = await request("GET", `/chats?workspaceId=${encodeURIComponent(alpha.workspaceId)}`, alpha.token);
    const pinned = (list2.body as { id: string; pinned?: boolean }[]).find((c) => c.id === chatId);
    expect(pinned?.pinned).toBe(true);

    const unpin = await request("DELETE", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, { chatId });
    expect(unpin.status).toBe(200);

    const list3 = await request("GET", `/chats?workspaceId=${encodeURIComponent(alpha.workspaceId)}`, alpha.token);
    const after = (list3.body as { id: string; pinned?: boolean }[]).find((c) => c.id === chatId);
    expect(after?.pinned ?? false).toBe(false);
  });

  it("is idempotent on repeat POSTs", async () => {
    const chatId = await createChat(alpha, "double-pin");
    const a = await request("POST", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, { chatId });
    const b = await request("POST", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, { chatId });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("404s when the chat does not belong to the workspace", async () => {
    // A chat under a workspace the user does not own would have been
    // ownership-rejected earlier. Use a syntactically-valid but absent id
    // so the pinChat path lookup throws NotFoundError.
    const res = await request("POST", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, {
      chatId: "chat_does_not_exist",
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty body with 400", async () => {
    const res = await request("POST", `/workspaces/${alpha.workspaceId}/chat-pins`, alpha.token, {});
    expect(res.status).toBe(400);
  });
});
