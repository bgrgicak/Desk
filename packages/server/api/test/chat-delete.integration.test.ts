/**
 * Integration tests for `DELETE /chats/:id` (feature-gap-matrix.md §4.2.4).
 *
 * Real Postgres, real filesystem — follows the harness
 * used by workspace-scoped-listing.integration.test.ts and multi-ws.test.ts.
 * Seeds one user with two chats (plus a second tenant) and exercises the
 * delete route end-to-end: DB rows vanish, on-disk directories land in
 * `~/Desk/.trash/`, scheduler refs are cancelled, and a `chat.deleted` WS
 * event fires.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
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
let alpha: SeededUser;
let beta: SeededUser;

interface SeededUser {
  userId: string;
  token: string;
  workspaceId: string;
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

function openWs(token: string): Promise<{ socket: net.Socket; frames: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const frames: Buffer[] = [];
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET /ws?token=${token} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });

    let headersDone = false;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx >= 0) {
          headersDone = true;
          const rest = buf.subarray(idx + 4);
          if (rest.length > 0) frames.push(rest);
          resolve({ socket, frames });
        }
      } else {
        frames.push(chunk);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("WS open timeout")), 5000);
  });
}

/**
 * Parses accumulated WS text frames and returns the decoded payloads in
 * order. Only text frames (opcode 0x1) with an unmasked server-to-client
 * layout are expected here.
 */
function parseWsFrames(raw: Buffer): string[] {
  const messages: string[] = [];
  let offset = 0;
  while (offset + 2 <= raw.length) {
    const byte1 = raw[offset];
    const byte2 = raw[offset + 1];
    const opcode = byte1 & 0x0f;
    let payloadLen = byte2 & 0x7f;
    let cursor = offset + 2;
    if (payloadLen === 126) {
      if (cursor + 2 > raw.length) break;
      payloadLen = raw.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > raw.length) break;
      payloadLen = Number(raw.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (cursor + payloadLen > raw.length) break;
    if (opcode === 0x1) {
      messages.push(raw.subarray(cursor, cursor + payloadLen).toString("utf-8"));
    }
    offset = cursor + payloadLen;
  }
  return messages;
}

async function seedUser(suffix: string, broadcastUserId?: string): Promise<SeededUser> {
  const userId = broadcastUserId ?? generateId("user");
  const username = `chatdel_${suffix}`;
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

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: `agent-${suffix}`,
    model: "opencode/big-pickle",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );

  const login = await request("POST", "/auth/login", null, { username, password });
  const token = (login.body as { token: string }).token;

  return { userId, token, workspaceId, agentId };
}

async function createChatWithPayload(
  owner: SeededUser,
  title: string,
): Promise<{
  chatId: string;
  userMessageId: string;
  scheduledMessageId: string;
  attachmentRel: string;
}> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId: owner.workspaceId,
    agentId: owner.agentId,
    title,
  });
  const ws = await queries.workspaces.findById(pool, owner.workspaceId);
  const wsPath = ws!.path;

  const userMessageId = generateId("message");
  await queries.messages.insert(pool, {
    id: userMessageId,
    chatId,
    role: "user",
    content: { type: "text", text: "hello" },
  });

  // Insert a pending scheduled message. Deleting the chat cascades messages,
  // so the poll loop will never pick this up after deletion.
  const scheduledMessageId = generateId("message");
  await queries.messages.insert(pool, {
    id: scheduledMessageId,
    chatId,
    role: "system",
    content: { type: "text", text: "scheduled" },
    state: "pending",
    executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  // Seed an on-disk attachment + a log, both under the chat's hidden tree.
  const attachmentsDir = path.join(home, wsPath, ".chats", chatId, "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });
  await fs.writeFile(path.join(attachmentsDir, "hello.txt"), "chat artifact");

  const logsDir = path.join(home, wsPath, ".chats", chatId, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, `${scheduledMessageId}.log`), "stdout\tready\n");

  const attachmentRel = `.chats/${chatId}/attachments/hello.txt`;
  return { chatId, userMessageId, scheduledMessageId, attachmentRel };
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-delete-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-delete-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });

  // Alpha is the broadcast user — all events route to sockets authenticated
  // with Alpha's token. Beta exists only to prove cross-tenant isolation and
  // never subscribes.
  const alphaUserId = generateId("user");
  server = createApp({
    pool,
    storage: { pool, home },
    runManager,
    broadcastUserId: alphaUserId,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  alpha = await seedUser("alpha", alphaUserId);
  beta = await seedUser("beta");
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

describe("DELETE /chats/:id", () => {
  it("deletes the chat, cascades messages, and trashes on-disk dirs", async () => {
    const { chatId, scheduledMessageId } = await createChatWithPayload(
      alpha,
      "happy-path chat",
    );

    const ws = await openWs(alpha.token);

    const del = await request("DELETE", `/chats/${chatId}`, alpha.token);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const get = await request("GET", `/chats/${chatId}`, alpha.token);
    expect(get.status).toBe(404);

    const msgs = await request("GET", `/chats/${chatId}/messages`, alpha.token);
    expect(msgs.status).toBe(404);

    const { rows: chatRows } = await pool.query(
      "SELECT id FROM chats WHERE id = ?",
      [chatId],
    );
    expect(chatRows).toHaveLength(0);
    const { rows: msgRows } = await pool.query(
      "SELECT id FROM messages WHERE chat_id = ?",
      [chatId],
    );
    expect(msgRows).toHaveLength(0);

    // Scheduled message row is gone (FK cascade) — the poll loop will never
    // pick it up again since the row no longer exists.
    const row = await queries.messages.findById(pool, scheduledMessageId);
    expect(row).toBeNull();

    // On-disk chat dir moved to trash. The entire `.chats/{chatId}/`
    // subtree — logs, attachments, notes — relocates together.
    const alphaWs = await queries.workspaces.findById(pool, alpha.workspaceId);
    const live = path.join(home, alphaWs!.path, ".chats", chatId);
    await expect(fs.stat(live)).rejects.toThrow();

    const trashed = await fs.readdir(path.join(home, ".trash", ".chats"));
    expect(trashed.some((n) => n.startsWith(`${chatId}-`))).toBe(true);

    // WS event received.
    await new Promise((r) => setTimeout(r, 200));
    const messages = parseWsFrames(Buffer.concat(ws.frames));
    const deleted = messages
      .map((m) => {
        try { return JSON.parse(m); } catch { return null; }
      })
      .filter((e): e is { type: string; payload: { chatId: string; workspaceId: string } } =>
        !!e && e.type === "chat.deleted",
      );
    expect(deleted).toHaveLength(1);
    expect(deleted[0].payload).toEqual({ chatId, workspaceId: alpha.workspaceId });

    ws.socket.destroy();
  });

  it("cross-tenant: 404 when user X deletes user Y's chat; Y's chat untouched", async () => {
    const { chatId: betaChatId } = await createChatWithPayload(beta, "beta's chat");
    const res = await request("DELETE", `/chats/${betaChatId}`, alpha.token);
    expect(res.status).toBe(404);

    // Beta's chat still intact in DB.
    const still = await queries.chats.findById(pool, betaChatId);
    expect(still?.id).toBe(betaChatId);
  });

  it("returns 404 for an unknown chat id", async () => {
    const res = await request("DELETE", "/chats/cht_doesnotexist", alpha.token);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed chat id (matches existing chat-route behavior)", async () => {
    // PATCH/GET /chats/:id treat bare strings as lookups against the DB and
    // return 404 when they don't resolve. DELETE matches that shape rather
    // than inventing a 400 path.
    const res = await request("DELETE", "/chats/notaprefix", alpha.token);
    expect(res.status).toBe(404);
  });

  it("DELETE /workspaces/:id still cascades chats correctly (no regression)", async () => {
    // Create a fresh workspace + chat under alpha so the cascade is proven
    // end-to-end without re-using state from the happy-path test.
    const wsId = generateId("workspace");
    await queries.workspaces.insert(pool, {
      id: wsId,
      userId: alpha.userId,
      name: "cascade-check",
      description: "",
      icon: "",
    });
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [wsId, alpha.agentId],
    );

    const chatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: chatId,
      workspaceId: wsId,
      agentId: alpha.agentId,
      title: "cascade chat",
    });
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "user",
      content: { type: "text", text: "cascade" },
    });

    const del = await request("DELETE", `/workspaces/${wsId}`, alpha.token);
    expect(del.status).toBe(200);

    const { rows: chatRows } = await pool.query("SELECT id FROM chats WHERE id = ?", [chatId]);
    expect(chatRows).toHaveLength(0);
    const { rows: msgRows } = await pool.query("SELECT id FROM messages WHERE id = ?", [messageId]);
    expect(msgRows).toHaveLength(0);
  });
});
