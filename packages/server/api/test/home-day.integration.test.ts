import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries, hashPassword } from "@roomy-ai/db";
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
let token: string;
let userId: string;
let workspaceId: string;
let agentId: string;

function request(
  method: string,
  pathStr: string,
  authToken: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
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

async function insertChat(title: string): Promise<string> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId,
    agentId,
    title,
  });
  return chatId;
}

async function sleepForTimestamp(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2));
}

async function insertMessage(data: {
  chatId: string;
  role: "user" | "agent" | "system";
  text: string;
  kind?: "chat" | "task" | "task_run";
  state?: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "paused";
  title?: string | null;
}): Promise<string> {
  await sleepForTimestamp();
  const id = generateId("message");
  await queries.messages.insert(pool, {
    id,
    chatId: data.chatId,
    role: data.role,
    content: { type: "text", text: data.text },
    kind: data.kind,
    state: data.state,
    title: data.title,
  });
  return id;
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-home-day-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-home-day-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  userId = generateId("user");
  const username = "home_day_user";
  const password = "home-day-pass";
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
    email: `${username}@example.com`,
  });

  workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "Home Day Room",
    description: "",
    icon: "sun",
    color: "blue",
  });

  agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "Home Day Agent",
    model: "anthropic/claude-haiku-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  const login = await request("POST", "/auth/login", null, {
    email: `${username}@example.com`,
    password,
  });
  token = login.body.token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

describe("GET /home/day", () => {
  it("returns typed Home items for task and chat activity", async () => {
    const needsTaskChat = await insertChat("Needs task chat");
    const needsTaskId = await insertMessage({
      chatId: needsTaskChat,
      role: "user",
      text: "Approve deployment checklist",
      kind: "task",
      state: "pending",
      title: "Approve deployment",
    });
    await pool.query(`UPDATE chats SET unread = 1 WHERE id = ?`, [needsTaskChat]);

    const runningTaskChat = await insertChat("Running task chat");
    const runningTaskId = await insertMessage({
      chatId: runningTaskChat,
      role: "user",
      text: "Build release notes",
      kind: "task",
      state: "running",
      title: "Build release notes",
    });
    const runningTaskThreadChat = await insertChat("Running task thread");
    await queries.messages.setThreadChatId(pool, runningTaskId, runningTaskThreadChat);

    const doneTaskChat = await insertChat("Done task chat");
    const doneTaskId = await insertMessage({
      chatId: doneTaskChat,
      role: "user",
      text: "Ship RSS feed",
      kind: "task",
      state: "succeeded",
      title: "Ship RSS feed",
    });

    const unreadChat = await insertChat("Design review");
    await insertMessage({
      chatId: unreadChat,
      role: "agent",
      text: "I reviewed the mocks and need your call on option B.",
      state: "succeeded",
    });

    const runningChat = await insertChat("Migration help");
    const trigger = await insertMessage({
      chatId: runningChat,
      role: "user",
      text: "Help migrate the API route",
      state: "succeeded",
    });
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'running')`,
      [generateId("message"), runningChat, JSON.stringify({ type: "agent_turn", userMessageId: trigger })],
    );

    const recentChat = await insertChat("Weekly planning");
    await insertMessage({
      chatId: recentChat,
      role: "user",
      text: "Capture next week's project priorities.",
      state: "succeeded",
    });

    const taskShapedChat = await insertChat("Task-shaped chat");
    const taskShapedTaskId = await insertMessage({
      chatId: taskShapedChat,
      role: "user",
      text: "This task-shaped chat should only appear as a task card.",
      kind: "task",
      state: "succeeded",
      title: "Task-shaped dedupe",
    });

    const failedChat = await insertChat("Failed chat");
    const failedTrigger = await insertMessage({
      chatId: failedChat,
      role: "user",
      text: "Try the migration again",
      state: "succeeded",
    });
    const failedAgentTurnId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'failed')`,
      [failedAgentTurnId, failedChat, JSON.stringify({ type: "agent_turn", userMessageId: failedTrigger })],
    );

    const res = await request("GET", "/home/day", token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      counts: { needsInput: 3, active: 2, done: 3 },
    });

    const allItems = [
      ...res.body.sections.needsInput,
      ...res.body.sections.active,
      ...res.body.sections.done,
    ];
    for (const item of allItems) {
      expect(item.room).toEqual({
        id: workspaceId,
        name: "Home Day Room",
        color: "blue",
        icon: "sun",
      });
      if (item.kind === "task") {
        expect(Object.keys(item).sort()).toEqual([
          "href",
          "id",
          "kind",
          "preview",
          "room",
          "status",
          "statusLabel",
          "task",
          "title",
          "updatedAt",
        ]);
        expect(item.id).toBe(item.task.id);
        expect(item.task.kind).toBe("task");
        expect(item.href).toContain("task=");
        expect(item.href).not.toContain("chat=");
      } else {
        expect(item.kind).toBe("chat");
        expect(Object.keys(item).sort()).toEqual([
          "chat",
          "href",
          "id",
          "kind",
          "preview",
          "room",
          "status",
          "statusLabel",
          "title",
          "updatedAt",
        ]);
        expect(item.id).toBe(item.chat.id);
        expect(item.href).toContain("chat=");
        expect(item.href).not.toContain("task=");
      }
    }

    expect(res.body.sections.needsInput.map((i: any) => i.id).sort()).toEqual(
      [needsTaskId, unreadChat, failedChat].sort(),
    );
    expect(res.body.sections.active.map((i: any) => i.id).sort()).toEqual(
      [runningTaskId, runningChat].sort(),
    );
    expect(res.body.sections.done.map((i: any) => i.id).sort()).toEqual(
      [doneTaskId, recentChat, taskShapedTaskId].sort(),
    );
    expect(res.body.sections.needsInput.every((i: any) => i.status === "needs_input" && i.statusLabel === "Needs input")).toBe(true);
    expect(res.body.sections.active.every((i: any) => i.status === "active" && i.statusLabel === "Active")).toBe(true);
    expect(res.body.sections.done.every((i: any) => i.status === "done" && i.statusLabel === "Done")).toBe(true);
    expect(allItems.some((i: any) => i.id === needsTaskChat)).toBe(false);
    expect(allItems.some((i: any) => i.id === runningTaskThreadChat)).toBe(false);
    expect(allItems.some((i: any) => i.id === doneTaskChat)).toBe(false);
    expect(allItems.some((i: any) => i.id === taskShapedChat)).toBe(false);
    expect(allItems.filter((i: any) => i.id === taskShapedTaskId && i.kind === "task")).toHaveLength(1);
    expect(allItems.some((i: any) => i.id === runningChat && i.href.includes("chat="))).toBe(true);
    expect(allItems.find((i: any) => i.id === failedChat)?.chat.latestFailedMessageId).toBe(failedAgentTurnId);
  });
});
