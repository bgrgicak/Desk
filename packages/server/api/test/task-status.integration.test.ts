/**
 * REST-level integration test for server-decorated taskStatus. Pins the
 * wire contract: every task message returned by the API carries the
 * computed `taskStatus`, and it matches across surfaces (cross-chat
 * listing, per-chat listing, single-message PATCH/run). Reproduces the
 * exact cross-surface drift the user reported in the inline TaskResultCard
 * vs the Tasks-page badge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId, type Message } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let workspaceId: string;
let anchorChatId: string;

function request(
  method: string,
  pathStr: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-task-status-db-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-task-status-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({ pool, execRunFn: async () => ({ exitCode: 0 }) });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  const userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "ts_user",
    passwordHash: await hashPassword("ts-pw-XX"),
    email: "ts@example.com",
  });
  workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "TS-WS",
    description: "",
    icon: "",
  });
  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "TS-Agent",
    model: "anthropic/claude-haiku-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );
  anchorChatId = generateId("chat");
  await queries.chats.insert(pool, { id: anchorChatId, workspaceId, agentId, title: "Anchor" });

  const login = await request("POST", "/auth/login", { username: "ts_user", password: "ts-pw-XX" });
  token = (login.body as { token: string }).token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await pool.end();
  await fs.rm(home, { recursive: true, force: true });
});

describe("API decorates task messages with taskStatus on every surface", () => {
  it("GET /messages returns taskStatus on every task row — and 'todo' for a fresh, idle task", async () => {
    const taskId = generateId("message");
    await queries.messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "fresh task" },
      kind: "task",
      state: "pending",
    });

    const res = await request("GET", "/messages?kind=task");
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const fresh = items.find((m) => m.id === taskId);
    expect(fresh).toBeDefined();
    expect(fresh!.taskStatus).toBe("todo");
  });

  it("GET /chats/:id/messages returns the same taskStatus the cross-chat listing does", async () => {
    // Reproduces the user's exact bug shape: same message id, two
    // surfaces, must agree.
    const taskId = generateId("message");
    await queries.messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "consistency probe" },
      kind: "task",
      state: "pending",
    });

    const crossRes = await request("GET", `/messages?chatId=${anchorChatId}&kind=task`);
    const chatRes = await request("GET", `/chats/${anchorChatId}/messages?view=full`);
    expect(crossRes.status).toBe(200);
    expect(chatRes.status).toBe(200);

    const crossTask = (crossRes.body as { items: Message[] }).items.find((m) => m.id === taskId);
    const chatTask = (chatRes.body as { items: Message[] }).items.find((m) => m.id === taskId);
    expect(crossTask?.taskStatus).toBeDefined();
    expect(chatTask?.taskStatus).toBeDefined();
    expect(chatTask!.taskStatus).toBe(crossTask!.taskStatus);
  });

  it("reflects 'active' when the task's thread chat has a running agent_turn — the exact regression that crossed surfaces", async () => {
    const taskId = generateId("message");
    const threadChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: threadChatId,
      workspaceId,
      agentId: (await queries.agents.findById(pool, (await queries.chats.findById(pool, anchorChatId))!.agentId))!.id,
      title: "Thread",
    });
    await queries.messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "build markdown app" },
      kind: "task",
      state: "pending",
    });
    await queries.messages.setThreadChatId(pool, taskId, threadChatId);
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state)
       VALUES (?, ?, 'system', '{"type":"agent_turn","userMessageId":"u"}', 'chat', 'running')`,
      [generateId("message"), threadChatId],
    );

    const res = await request("GET", `/messages?chatId=${anchorChatId}&kind=task`);
    const task = (res.body as { items: Message[] }).items.find((m) => m.id === taskId);
    expect(task?.taskStatus).toBe("active");
  });

  it("PATCH /chats/:id/messages/:id returns the freshly-decorated taskStatus on the response body", async () => {
    const taskId = generateId("message");
    await queries.messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "to be marked done" },
      kind: "task",
      state: "pending",
    });

    const res = await request("PATCH", `/chats/${anchorChatId}/messages/${taskId}`, {
      state: "cancelled",
    });
    expect(res.status).toBe(200);
    expect((res.body as Message).taskStatus).toBe("complete");
  });

  it("POST /chats/:id/messages with kind='task' and no schedule auto-runs the task so it lands as 'active'", async () => {
    // Fresh chat so the dispatcher takes the no-thread-shell branch (the
    // TasksPage composer always sends into a new chat — see TasksRoute.onCreateTask).
    const freshChatId = generateId("chat");
    const agent = await queries.agents.findById(
      pool,
      (await queries.chats.findById(pool, anchorChatId))!.agentId,
    );
    await queries.chats.insert(pool, {
      id: freshChatId,
      workspaceId,
      agentId: agent!.id,
      title: "Auto-run task chat",
    });

    const sendRes = await request("POST", `/chats/${freshChatId}/messages`, {
      content: "do the thing",
      kind: "task",
      title: "do the thing",
    });
    expect(sendRes.status).toBe(201);
    const created = sendRes.body as Message;
    expect(created.kind).toBe("task");

    // The dispatcher fires the task synchronously via runMessage before
    // responding; the task_run child carries the running state, which the
    // status selector reads as 'active'.
    const listRes = await request("GET", `/messages?chatId=${freshChatId}&kind=task`);
    expect(listRes.status).toBe(200);
    const task = (listRes.body as { items: Message[] }).items.find((m) => m.id === created.id);
    expect(task?.taskStatus).toBe("active");
  });

  it("POST /chats/:id/messages with kind='task' and a future schedule stays 'scheduled' (no auto-run)", async () => {
    const freshChatId = generateId("chat");
    const agent = await queries.agents.findById(
      pool,
      (await queries.chats.findById(pool, anchorChatId))!.agentId,
    );
    await queries.chats.insert(pool, {
      id: freshChatId,
      workspaceId,
      agentId: agent!.id,
      title: "Scheduled task chat",
    });

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sendRes = await request("POST", `/chats/${freshChatId}/messages`, {
      content: "do the thing later",
      kind: "task",
      title: "do the thing later",
      executeAt: future,
    });
    expect(sendRes.status).toBe(201);
    const created = sendRes.body as Message;

    const listRes = await request("GET", `/messages?chatId=${freshChatId}&kind=task`);
    const task = (listRes.body as { items: Message[] }).items.find((m) => m.id === created.id);
    expect(task?.taskStatus).toBe("scheduled");
  });

  it("does not stamp taskStatus on non-task rows — keeps the field meaningful for clients", async () => {
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "plain chat" },
    });
    const res = await request("GET", `/chats/${anchorChatId}/messages?view=full`);
    const found = (res.body as { items: Message[] }).items.find((m) => m.id === messageId);
    expect(found).toBeDefined();
    expect(found!.taskStatus).toBeUndefined();
  });
});

describe("GET /messages?taskStatus filter", () => {
  // Each test allocates a dedicated workspace + chat so the seed set is
  // isolated from sibling tests that also insert tasks into the shared
  // anchor. This lets us assert on exact counts.
  async function seedWorkspaceWithMixedTasks(): Promise<{
    workspaceId: string;
    chatId: string;
    needsInputId: string;
    scheduledId: string;
    completeId: string;
    todoId: string;
  }> {
    const userRow = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
    const userId = userRow.rows[0].id;
    const agentRow = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
    const agentId = agentRow.rows[0].id;
    const wsId = generateId("workspace");
    await queries.workspaces.insert(pool, {
      id: wsId,
      userId,
      name: `WS-${wsId.slice(-6)}`,
      description: "",
      icon: "",
    });
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [wsId, agentId],
    );
    const chatId = generateId("chat");
    await queries.chats.insert(pool, { id: chatId, workspaceId: wsId, agentId, title: "Filter chat" });

    // needs_input: pending task whose chat is unread + latest agent message succeeded
    const needsInputId = generateId("message");
    await queries.messages.insert(pool, {
      id: needsInputId,
      chatId,
      role: "user",
      content: { type: "text", text: "needs input task" },
      kind: "task",
      state: "pending",
    });
    const needsInputChatId = generateId("chat");
    await queries.chats.insert(pool, { id: needsInputChatId, workspaceId: wsId, agentId, title: "Needs-input thread" });
    await queries.messages.setThreadChatId(pool, needsInputId, needsInputChatId);
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state, created_at)
       VALUES (?, ?, 'agent', '{"type":"text","text":"please confirm"}', 'chat', 'succeeded', ?)`,
      [generateId("message"), needsInputChatId, new Date()],
    );
    await pool.query(`UPDATE chats SET unread = 1 WHERE id = ?`, [needsInputChatId]);

    // scheduled: pending task with executeAt set in the future
    const scheduledId = generateId("message");
    await queries.messages.insert(pool, {
      id: scheduledId,
      chatId,
      role: "user",
      content: { type: "text", text: "scheduled task" },
      kind: "task",
      state: "pending",
      executeAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // complete: cancelled task
    const completeId = generateId("message");
    await queries.messages.insert(pool, {
      id: completeId,
      chatId,
      role: "user",
      content: { type: "text", text: "completed task" },
      kind: "task",
      state: "cancelled",
    });

    // todo: plain pending task, no schedule, idle chat
    const todoId = generateId("message");
    await queries.messages.insert(pool, {
      id: todoId,
      chatId,
      role: "user",
      content: { type: "text", text: "idle task" },
      kind: "task",
      state: "pending",
    });

    return { workspaceId: wsId, chatId, needsInputId, scheduledId, completeId, todoId };
  }

  it("returns only tasks whose computed taskStatus matches the filter", async () => {
    const seed = await seedWorkspaceWithMixedTasks();
    const res = await request(
      "GET",
      `/messages?workspaceId=${seed.workspaceId}&kind=task&taskStatus=needs_input`,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const ids = items.map((m) => m.id).sort();
    expect(ids).toEqual([seed.needsInputId]);
  });

  it("filters by computed status, not raw message.state — pending+cron returns under taskStatus=scheduled", async () => {
    const seed = await seedWorkspaceWithMixedTasks();
    const res = await request(
      "GET",
      `/messages?workspaceId=${seed.workspaceId}&kind=task&taskStatus=scheduled`,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    expect(items.map((m) => m.id)).toEqual([seed.scheduledId]);
    expect(items[0].state).toBe("pending");
    expect(items[0].taskStatus).toBe("scheduled");
  });

  it("accepts a comma-separated list of statuses (OR semantics)", async () => {
    const seed = await seedWorkspaceWithMixedTasks();
    const res = await request(
      "GET",
      `/messages?workspaceId=${seed.workspaceId}&kind=task&taskStatus=needs_input,complete`,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const ids = items.map((m) => m.id).sort();
    expect(ids).toEqual([seed.completeId, seed.needsInputId].sort());
  });

  it("rejects unknown taskStatus values with 400", async () => {
    const res = await request("GET", `/messages?kind=task&taskStatus=bogus`);
    expect(res.status).toBe(400);
  });
});
