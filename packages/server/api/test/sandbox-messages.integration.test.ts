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

function sandboxPost(body: unknown, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/sandbox/messages",
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
