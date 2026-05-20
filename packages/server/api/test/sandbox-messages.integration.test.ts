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
import { ensureLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceId: string;
let agentId: string;
let sourceChatId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-messages-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "sandbox-messages-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-messages-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string }>("SELECT id FROM workspaces LIMIT 1");
  workspaceId = wsRows[0].id;
  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id;

  sourceChatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [sourceChatId, workspaceId, agentId, "Source investigation chat"],
  );

  const runManager = createRunManager({ pool });
  server = createApp({ pool, storage: { pool, home }, runManager });
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

async function issueSandboxToken(): Promise<string> {
  const token = `tok_${crypto.randomBytes(16).toString("hex")}`;
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  return token;
}

function sandboxPost(body: unknown, token: string, urlPath = "/sandbox/messages"): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
          "X-Desk-Sandbox-Token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

describe("POST /sandbox/messages", () => {
  it("creates a simple task in a fresh chat with context attachments", async () => {
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      chatId: sourceChatId,
      newChat: true,
      title: "Stabilize blank replies",
      content: "Investigate the blank reply issue",
      attachments: [{ path: `.chats/${sourceChatId}/artifacts/report.md`, name: "report.md" }],
    }, token);

    expect(res.status).toBe(201);
    expect(res.body.chat.id).not.toBe(sourceChatId);
    expect(res.body.chat.goal).toBe("task");
    expect(res.body.message.chatId).toBe(res.body.chat.id);
    expect(res.body.message.kind).toBe("task");
    expect(res.body.message.executeAt).toBeUndefined();
    expect(res.body.message.cron).toBeUndefined();
    expect(res.body.message.attachments).toEqual([
      { path: `.chats/${sourceChatId}/artifacts/report.md`, name: "report.md" },
    ]);
    expect(res.body.message.content.text).toContain(`Originating chat: ${sourceChatId}`);
  });

  it("keeps scheduled and recurring tasks on the existing chat path", async () => {
    const token = await issueSandboxToken();
    const scheduled = await sandboxPost({
      chatId: sourceChatId,
      newChat: true,
      content: "Run later",
      executeAt: "2026-05-01T09:00:00Z",
    }, token);
    expect(scheduled.status).toBe(400);
    expect(scheduled.body.message).toMatch(/simple manual tasks/);

    const recurring = await sandboxPost({
      chatId: sourceChatId,
      newChat: true,
      content: "Run daily",
      cron: "0 9 * * *",
    }, token);
    expect(recurring.status).toBe(400);
    expect(recurring.body.message).toMatch(/simple manual tasks/);
  });

  it("rejects unsafe attachment paths before creating the fresh chat", async () => {
    const token = await issueSandboxToken();
    const before = await pool.query<{ count: number }>("SELECT COUNT(*) AS count FROM chats");
    const res = await sandboxPost({
      chatId: sourceChatId,
      newChat: true,
      title: "Unsafe attachment",
      content: "This should not create a chat",
      attachments: [{ path: "/etc/passwd", name: "passwd" }],
    }, token);
    const after = await pool.query<{ count: number }>("SELECT COUNT(*) AS count FROM chats");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid attachment path/);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});

describe("POST /sandbox/messages/reschedule", () => {
  async function createScheduledTask(token: string, executeAt = "2026-06-01T09:00:00Z") {
    const create = await sandboxPost({
      chatId: sourceChatId,
      title: "Daily review",
      content: "Review the build",
      executeAt,
    }, token);
    expect(create.status).toBe(201);
    return create.body as { id: string; chatId: string; executeAt?: string; cron?: string; createdAt: string; title?: string };
  }

  it("updates executeAt in place — same id, same created_at, state pending", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token);

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
      executeAt: "2026-06-02T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.createdAt).toBe(created.createdAt);
    expect(res.body.executeAt).toBe("2026-06-02T09:00:00.000Z");
    expect(res.body.cron).toBeFalsy();
    expect(res.body.state).toBe("pending");

    // Confirm the row count for this chat did not grow.
    const { rows } = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND kind = 'task'",
      [sourceChatId],
    );
    expect(rows[0].count).toBe(1);
  });

  it("swaps a one-shot task to recurring by clearing executeAt when cron is provided", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-06-10T09:00:00Z");

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
      cron: "0 9 * * 1-5",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.cron).toBe("0 9 * * 1-5");
    expect(res.body.executeAt).toBeTruthy();
    // rescheduleMessage recomputes executeAt from the cron expression; it
    // should no longer equal the original one-shot timestamp.
    expect(res.body.executeAt).not.toBe("2026-06-10T09:00:00Z");
  });

  it("optionally updates title and content alongside the schedule", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-07-01T09:00:00Z");

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
      executeAt: "2026-07-02T09:00:00Z",
      title: "Weekly review",
      content: "Updated body",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Weekly review");
    expect(res.body.content).toEqual({ type: "text", text: "Updated body" });
  });

  it("resurrects a cancelled task by resetting state to pending", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-08-01T09:00:00Z");
    await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
    }, token, "/sandbox/messages/cancel");

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
      executeAt: "2026-08-15T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("pending");
    expect(res.body.executeAt).toBe("2026-08-15T09:00:00.000Z");
  });

  it("rejects when neither executeAt nor cron is supplied", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-09-01T09:00:00Z");

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/executeAt or cron/);
  });

  it("rejects executeAt and cron together", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-09-15T09:00:00Z");

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: created.id,
      executeAt: "2026-09-16T09:00:00Z",
      cron: "0 9 * * *",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mutually exclusive/);
  });

  it("rejects messages from a different chat", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-10-01T09:00:00Z");
    const otherChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [otherChatId, workspaceId, agentId, "Other chat"],
    );

    const res = await sandboxPost({
      chatId: otherChatId,
      messageId: created.id,
      executeAt: "2026-10-02T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(404);
  });

  it("rejects non-task message kinds", async () => {
    const token = await issueSandboxToken();
    const chatMsgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, created_at, updated_at)
       VALUES (?, ?, 'user', '{"type":"text","text":"hi"}', 'chat', ?, ?)`,
      [chatMsgId, sourceChatId, new Date(), new Date()],
    );

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: chatMsgId,
      executeAt: "2026-11-01T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only task messages/);
  });
});
