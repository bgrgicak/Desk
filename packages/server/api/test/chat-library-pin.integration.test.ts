/**
 * Integration test for `POST /chats/:id/library-refs`.
 *
 * Pinning a workspace-library file to a chat creates a symlink under
 * `.chats/{chatId}/attachments/` so the file shows up alongside ordinary
 * uploads in the chat's "In this chat" sidebar (`GET /chats/{id}/attachments`).
 * The library file itself is untouched — only a link is created.
 *
 * Real Postgres, real filesystem.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, type PoolClient } from "@desk/db";
import { runMigrations, queries, hashPassword } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_chat_library_pin_${workerId}`;

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

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let alpha: SeededUser;
let beta: SeededUser;

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
  const username = `pin_${suffix}`;
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
    instructions: "",
    model: "anthropic/claude-sonnet-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ($1, $2)`,
    [workspaceId, agentId],
  );

  const login = await request("POST", "/auth/login", null, { username, password });
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

/** Writes a real library file at `workspaces/{slug}/{relPath}` and returns its workspace-relative path. */
async function writeLibraryFile(slug: string, relPath: string, body: string): Promise<string> {
  const abs = path.join(home, "Desk", "workspaces", slug, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return relPath.split(path.sep).join("/");
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-library-pin-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });

  const broadcastUserId = generateId("user");
  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
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

  const admin = new Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

describe("POST /chats/:id/library-refs", () => {
  it("symlinks the library file under .chats/{id}/attachments/ and surfaces it via listAttachments", async () => {
    const chatId = await createChat(alpha, "pin happy");
    const libRel = await writeLibraryFile(alpha.workspacePath, "Notes/spec.md", "library body");

    const res = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: libRel });
    expect(res.status).toBe(201);
    const fileRef = res.body as { path: string; name: string; size: number };
    expect(fileRef.path).toBe(`.chats/${chatId}/attachments/spec.md`);
    expect(fileRef.name).toBe("spec.md");
    expect(fileRef.size).toBe("library body".length);

    // It is actually a symlink — the library file is unchanged, not copied.
    const linkAbs = path.join(home, "Desk", "workspaces", alpha.workspacePath, ".chats", chatId, "attachments", "spec.md");
    const lstat = await fs.lstat(linkAbs);
    expect(lstat.isSymbolicLink()).toBe(true);
    const targetAbs = path.join(home, "Desk", "workspaces", alpha.workspacePath, "Notes/spec.md");
    expect(await fs.readlink(linkAbs)).toBe(targetAbs);

    // listAttachments surfaces the pin alongside any other on-disk attachments.
    const list = await request("GET", `/chats/${chatId}/attachments`, alpha.token);
    expect(list.status).toBe(200);
    const items = list.body as { path: string; kind: string; size: number }[];
    const pinned = items.find((i) => i.path === `.chats/${chatId}/attachments/spec.md`);
    expect(pinned).toBeDefined();
    expect(pinned!.kind).toBe("attachment");
    expect(pinned!.size).toBe("library body".length);
  });

  it("is idempotent — pinning the same file twice does not create a -1 link", async () => {
    const chatId = await createChat(alpha, "pin idempotent");
    const libRel = await writeLibraryFile(alpha.workspacePath, "report.md", "report body");

    const a = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: libRel });
    expect(a.status).toBe(201);
    const b = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: libRel });
    expect(b.status).toBe(201);

    expect((a.body as { path: string }).path).toBe(`.chats/${chatId}/attachments/report.md`);
    expect((b.body as { path: string }).path).toBe(`.chats/${chatId}/attachments/report.md`);

    const attDir = path.join(home, "Desk", "workspaces", alpha.workspacePath, ".chats", chatId, "attachments");
    const entries = await fs.readdir(attDir);
    expect(entries.filter((n) => n.startsWith("report")).length).toBe(1);
  });

  it("disambiguates basename collisions — same basename, different library targets", async () => {
    const chatId = await createChat(alpha, "pin collision");
    const a = await writeLibraryFile(alpha.workspacePath, "FolderA/notes.txt", "A");
    const b = await writeLibraryFile(alpha.workspacePath, "FolderB/notes.txt", "B");

    const r1 = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: a });
    const r2 = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: b });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const p1 = (r1.body as { path: string }).path;
    const p2 = (r2.body as { path: string }).path;
    expect(p1).toBe(`.chats/${chatId}/attachments/notes.txt`);
    expect(p2).toBe(`.chats/${chatId}/attachments/notes-1.txt`);
  });

  it("dead links — deleting the library target makes the pin disappear from listAttachments", async () => {
    const chatId = await createChat(alpha, "pin stale");
    const libRel = await writeLibraryFile(alpha.workspacePath, "ephemeral.txt", "soon-gone");

    const pin = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: libRel });
    expect(pin.status).toBe(201);

    // Remove the library target. The symlink stays on disk but stat() fails,
    // so listAttachments must drop it from the response.
    await fs.unlink(path.join(home, "Desk", "workspaces", alpha.workspacePath, "ephemeral.txt"));

    const list = await request("GET", `/chats/${chatId}/attachments`, alpha.token);
    const items = list.body as { path: string }[];
    expect(items.find((i) => i.path === `.chats/${chatId}/attachments/ephemeral.txt`)).toBeUndefined();
  });

  it("rejects pinning a path that already lives inside the chat's attachments dir", async () => {
    const chatId = await createChat(alpha, "pin self-ref");
    const attDir = path.join(home, "Desk", "workspaces", alpha.workspacePath, ".chats", chatId, "attachments");
    await fs.mkdir(attDir, { recursive: true });
    await fs.writeFile(path.join(attDir, "already.txt"), "uploaded");

    const res = await request(
      "POST",
      `/chats/${chatId}/library-refs`,
      alpha.token,
      { path: `.chats/${chatId}/attachments/already.txt` },
    );
    expect(res.status).toBe(400);
  });

  it("404 when a different tenant pins another user's chat", async () => {
    const chatId = await createChat(alpha, "alpha private");
    const libRel = await writeLibraryFile(alpha.workspacePath, "private.txt", "x");

    const res = await request("POST", `/chats/${chatId}/library-refs`, beta.token, { path: libRel });
    expect(res.status).toBe(404);
  });

  it("404 when the library file does not exist", async () => {
    const chatId = await createChat(alpha, "pin missing");
    const res = await request("POST", `/chats/${chatId}/library-refs`, alpha.token, { path: "nope/missing.txt" });
    expect(res.status).toBe(404);
  });
});
