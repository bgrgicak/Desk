/**
 * Integration tests for chat threads.
 *
 * Threads are normal chats anchored to a parent message via
 * `messages.thread_chat_id` on the anchor row. Coverage:
 *
 *   - schema mapping: `threadChatId` round-trips through Zod and the row mapper
 *   - same-workspace thread creation from a project parent
 *   - mounted anchor message appears first in `GET /chats/:id/messages`
 *   - duplicate creation returns 409
 *   - project parents may not target a different workspace (400)
 *   - hub parents may target any owned workspace
 *   - thread activity bumps only the thread chat, not the parent
 *   - scheduler prompt context includes the anchor + thread-starting message
 *   - the parent chat transcript does not include thread messages
 *   - the WS `message.updated` payload patches anchor `threadChatId`
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
import { generateId, MessageSchema, type Chat, type Message, type WsEvent } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { createThread, sendMessage } from "../src/routes/chats.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;

interface SeededUser {
  userId: string;
  token: string;
  /** Project workspace. */
  projectWs: string;
  /** Second project workspace, for cross-workspace assertions. */
  otherProjectWs: string;
  /** Hub workspace for this user. */
  hubWs: string;
  agentId: string;
  /** Chat in `projectWs`. */
  projectChat: string;
  /** Chat in `hubWs`. */
  hubChat: string;
}

let alpha: SeededUser;

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
  const username = `threads_${suffix}`;
  const password = `pw-${suffix}`;
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
    email: `${username}@example.com`,
  });

  const projectWs = generateId("workspace");
  const otherProjectWs = generateId("workspace");
  const hubWs = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: projectWs,
    userId,
    name: `proj-${suffix}`,
  });
  await queries.workspaces.insert(pool, {
    id: otherProjectWs,
    userId,
    name: `other-${suffix}`,
  });
  await queries.workspaces.insert(pool, {
    id: hubWs,
    userId,
    name: `hub-${suffix}`,
    kind: "hub",
  });

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: `agent-${suffix}`,
    model: "opencode/big-pickle",
  });
  for (const ws of [projectWs, otherProjectWs, hubWs]) {
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [ws, agentId],
    );
  }

  const projectChat = generateId("chat");
  await queries.chats.insert(pool, {
    id: projectChat,
    workspaceId: projectWs,
    agentId,
    title: "project chat",
  });
  const hubChat = generateId("chat");
  await queries.chats.insert(pool, {
    id: hubChat,
    workspaceId: hubWs,
    agentId,
    title: "hub chat",
  });

  const login = await request("POST", "/auth/login", null, { username, password });
  const token = (login.body as { token: string }).token;

  return {
    userId,
    token,
    projectWs,
    otherProjectWs,
    hubWs,
    agentId,
    projectChat,
    hubChat,
  };
}

async function seedAnchor(chatId: string, text = "anchor"): Promise<string> {
  const id = generateId("message");
  await queries.messages.insert(pool, {
    id,
    chatId,
    role: "user",
    content: { type: "text", text },
  });
  return id;
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-threads-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-threads-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  // No-op exec: the API path tests don't care about the agent actually
  // running, only about the DB rows and WS events emitted around the fire.
  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
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
  delete process.env.DESK_HOME;
});

describe("threadChatId schema mapping", () => {
  it("MessageSchema accepts and round-trips threadChatId", () => {
    const parsed = MessageSchema.parse({
      id: "m_1",
      chatId: "c_1",
      role: "user",
      content: { type: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00.000Z",
      threadChatId: "c_thread",
    });
    expect(parsed.threadChatId).toBe("c_thread");
  });

  it("findById returns threadChatId once setThreadChatId is applied", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "with thread");
    const threadChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: threadChatId,
      workspaceId: alpha.projectWs,
      agentId: alpha.agentId,
      title: "thread",
    });
    const updated = await queries.messages.setThreadChatId(pool, anchorId, threadChatId);
    expect(updated?.threadChatId).toBe(threadChatId);

    const fetched = await queries.messages.findById(pool, anchorId);
    expect(fetched?.threadChatId).toBe(threadChatId);
  });
});

describe("createThread — same workspace from project parent", () => {
  it("creates a thread chat, links the anchor, and inserts the user message + agent_turn trigger", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "let's discuss");
    const events: WsEvent[] = [];
    const result = await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "expand on this please" },
      (e) => events.push(e),
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    expect(result.threadChat.workspaceId).toBe(alpha.projectWs);
    expect(result.threadChat.agentId).toBe(alpha.agentId);
    expect(result.threadStartMessage.chatId).toBe(result.threadChat.id);
    expect(result.threadStartMessage.role).toBe("user");
    expect(result.anchorMessage.id).toBe(anchorId);
    expect(result.anchorMessage.threadChatId).toBe(result.threadChat.id);

    // The trigger row exists, is pending, and points at the user message.
    const trigger = await queries.messages.findById(pool, result.triggerId);
    expect(trigger?.state).toBe("pending");
    expect((trigger?.content as { type: string; userMessageId: string }).userMessageId).toBe(
      result.threadStartMessage.id,
    );

    // Emits message.updated for the anchor with the new threadChatId.
    const update = events.find(
      (e) => e.type === "message.updated" && (e.payload as Message).id === anchorId,
    );
    expect(update).toBeDefined();
    expect(((update as { payload: Message }).payload).threadChatId).toBe(
      result.threadChat.id,
    );
  });

  it("rejects empty content with 400", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "anchor for empty");
    await expect(
      createThread(
        pool,
        alpha.projectChat,
        anchorId,
        { content: "   " },
        () => {},
        { actorUserId: alpha.userId, userId: alpha.userId },
      ),
    ).rejects.toThrow();
  });

  it("returns 409 when the anchor already has a thread", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "two-thread anchor");
    await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "first thread" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const res = await request(
      "POST",
      `/chats/${alpha.projectChat}/messages/${anchorId}/thread`,
      alpha.token,
      { content: "second attempt" },
    );
    expect(res.status).toBe(409);
  });
});

describe("createThread — workspace targeting policy", () => {
  it("project parent cannot target a different workspace", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "project anchor");
    const res = await request(
      "POST",
      `/chats/${alpha.projectChat}/messages/${anchorId}/thread`,
      alpha.token,
      { content: "wrong workspace", workspaceId: alpha.otherProjectWs },
    );
    expect(res.status).toBe(400);
  });

  it("hub parent can target a project workspace", async () => {
    const anchorId = await seedAnchor(alpha.hubChat, "hub anchor");
    const res = await request(
      "POST",
      `/chats/${alpha.hubChat}/messages/${anchorId}/thread`,
      alpha.token,
      { content: "into project", workspaceId: alpha.otherProjectWs },
    );
    expect(res.status).toBe(201);
    const body = res.body as { chat: Chat; message: Message };
    expect(body.chat.workspaceId).toBe(alpha.otherProjectWs);
    expect(body.message.chatId).toBe(body.chat.id);
  });
});

describe("listByChat — mounted anchor", () => {
  it("returns the anchor as the first item in the thread chat transcript", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "anchor for transcript");
    const result = await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "thread reply" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const listed = await queries.messages.listByChat(pool, result.threadChat.id, {});
    // anchor is mounted first, then the thread-owned rows. The
    // start message and the agent_turn trigger are inserted in the
    // same millisecond so their relative order falls back to nanoid
    // tiebreak — assert the anchor is first and both thread-owned
    // rows are present rather than encoding a non-deterministic
    // tiebreak in the test.
    expect(listed.items[0].id).toBe(anchorId);
    const ids = listed.items.map((m) => m.id);
    expect(ids).toContain(result.threadStartMessage.id);
    expect(ids).toContain(result.triggerId);
  });

  it("the parent chat transcript does not include thread chat messages", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "isolated anchor");
    const result = await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "thread reply only in thread" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const parentList = await queries.messages.listByChat(pool, alpha.projectChat, {});
    const ids = new Set(parentList.items.map((m) => m.id));
    expect(ids.has(result.threadStartMessage.id)).toBe(false);
    expect(ids.has(result.triggerId)).toBe(false);
    // The anchor itself is in the parent chat normally.
    expect(ids.has(anchorId)).toBe(true);
  });
});

describe("scheduler context — listAgentContextByChat", () => {
  it("includes the mounted anchor + thread-starting message in the thread chat's agent context", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "anchor for context");
    const result = await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "thread starter" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const ctx = await queries.messages.listAgentContextByChat(pool, result.threadChat.id);
    const ids = ctx.map((m) => m.id);
    expect(ids[0]).toBe(anchorId);
    expect(ids).toContain(result.threadStartMessage.id);
  });
});

describe("activity isolation", () => {
  it("thread message activity does not bump the parent chat", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "isolation anchor");
    const beforeParent = await queries.chats.findById(pool, alpha.projectChat);
    // Sleep to ensure a later updated_at would be measurably newer.
    await new Promise((r) => setTimeout(r, 10));

    const result = await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "isolated activity" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const afterParent = await queries.chats.findById(pool, alpha.projectChat);
    const threadChat = await queries.chats.findById(pool, result.threadChat.id);
    // Parent updated_at is unchanged. The setThreadChatId call only
    // touches messages.updated_at on the anchor; chats.updated_at is the
    // chat-list ordering signal and should stay put.
    expect(afterParent?.updatedAt).toBe(beforeParent?.updatedAt);
    expect(threadChat).toBeTruthy();

    // A subsequent send into the thread chat bumps the thread, not parent.
    const beforeAnotherParent = await queries.chats.findById(pool, alpha.projectChat);
    await new Promise((r) => setTimeout(r, 10));
    await sendMessage(
      pool,
      result.threadChat.id,
      { content: "follow-up in thread" },
      () => {},
    );
    const afterSendParent = await queries.chats.findById(pool, alpha.projectChat);
    expect(afterSendParent?.updatedAt).toBe(beforeAnotherParent?.updatedAt);
  });
});

describe("anchor message JSON exposes threadChatId via API", () => {
  it("GET /chats/:id/messages returns the patched anchor with threadChatId set", async () => {
    const anchorId = await seedAnchor(alpha.projectChat, "json shape anchor");
    await createThread(
      pool,
      alpha.projectChat,
      anchorId,
      { content: "expose me" },
      () => {},
      { actorUserId: alpha.userId, userId: alpha.userId },
    );

    const res = await request(
      "GET",
      `/chats/${alpha.projectChat}/messages?view=full`,
      alpha.token,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const anchor = items.find((m) => m.id === anchorId);
    expect(anchor).toBeDefined();
    expect(anchor!.threadChatId).toBeTruthy();
  });
});
