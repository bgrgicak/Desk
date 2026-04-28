/**
 * Integration tests for message firing, PATCH/DELETE/logs, and note versioning.
 *
 * Covers:
 *   - PATCH / DELETE / GET logs on /chats/{id}/messages/{id}
 *   - Note versioning via note-history
 *   - POST /chats/{id}/messages deduplication
 *   - POST /chats/{id}/messages/{id}/run (force-fire)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, type PoolClient } from "@desk/db";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_internal_msg_fire_${workerId}`;

function adminConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let chatId: string;
let runManager: ReturnType<typeof createRunManager>;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "msgfire-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-fire-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  runManager = createRunManager({
    pool,
    execRunFn: async (runId, _a, _p, onLog) => {
      onLog({ runId, seq: 0, kind: "stdout", payload: "## Summary\n\nThe chat discussed vacation plans." });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, wsRows[0].id, agentRows[0].id, "Fire Chat"],
  );

  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
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
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

function postJson(pathStr: string, body: unknown, bearer: string | null): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    const payload = JSON.stringify(body);
    headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: pathStr, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function insertPendingMessage(content: unknown): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state, execute_at)
     VALUES ($1, $2, 'system', $3, 'pending', now() + interval '1 hour')`,
    [id, chatId, JSON.stringify(content)],
  );
  return id;
}

describe("PATCH / DELETE / logs on /chats/{id}/messages/{id}", () => {
  async function userRequest(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const loginRes = await postJson("/auth/login", { username: "msgfire-user", password: "pw" }, null);
    const userTok = (loginRes.body as { token: string }).token;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${userTok}` };
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it("PATCH updates a note message's body", async () => {
    const requestId = await insertPendingMessage({ type: "ai_note_request" });
    const { childIds } = await runManager.fireMessage(requestId);
    const noteId = childIds[0];

    const patched = await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${noteId}`,
      { content: { type: "note", body: "User-edited summary." } },
    );
    expect(patched.status).toBe(200);
    const updated = patched.body as { content: { type: string; body: string } };
    expect(updated.content.body).toBe("User-edited summary.");
  });

  it("PATCH rejects arbitrary state values (only cancelled/paused/pending allowed)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "x" });
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "running" });
    expect(res.status).toBe(400);
  });

  it("PATCH executeAt:null on a scheduled row clears the schedule", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "Scheduled→Todo" });
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { executeAt: null });
    expect(res.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
    expect(row?.executeAt).toBeUndefined();
  });

  it("PATCH state:pending+executeAt:null restores a cancelled row to plain todo", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "Complete→Todo" });
    const cancel = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "cancelled" });
    expect(cancel.status).toBe(200);
    expect((cancel.body as { state: string }).state).toBe("cancelled");

    const restore = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, {
      state: "pending",
      executeAt: null,
      cron: null,
    });
    expect(restore.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
    expect(row?.executeAt).toBeUndefined();
    expect(row?.cron).toBeUndefined();
  });

  it("PATCH state:pending on a cancelled row with executeAt stays pending with schedule intact", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "Complete→Scheduled" });
    const cancel = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "cancelled" });
    expect(cancel.status).toBe(200);

    const resume = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "pending" });
    expect(resume.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
    expect(row?.executeAt).toBeDefined();
  });

  it("PATCH state:pending on an already-pending row is a no-op (does not 400)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "no-op pending" });
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "pending" });
    expect(res.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
  });

  it("PATCH state:pending restores a succeeded row to pending (re-run)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "succeeded→todo" });
    await pool.query(
      `UPDATE messages SET state = 'succeeded', execute_at = NULL,
                           started_at = now(), ended_at = now()
       WHERE id = $1`,
      [mid],
    );
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, {
      state: "pending",
      executeAt: null,
      cron: null,
    });
    expect(res.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
  });

  it("PATCH state:pending restores a failed row to pending (re-run)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "failed→todo" });
    await pool.query(
      `UPDATE messages SET state = 'failed', execute_at = NULL,
                           started_at = now(), ended_at = now()
       WHERE id = $1`,
      [mid],
    );
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, {
      state: "pending",
      executeAt: null,
      cron: null,
    });
    expect(res.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("pending");
  });

  it("PATCH state:pending on a running row is rejected", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "running guard" });
    await pool.query(`UPDATE messages SET state = 'running' WHERE id = $1`, [mid]);
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "pending" });
    expect(res.status).toBe(400);
  });

  it("DELETE removes the message", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "delete me" });
    const res = await userRequest("DELETE", `/chats/${chatId}/messages/${mid}`);
    expect(res.status).toBe(200);
    expect(await queries.messages.findById(pool, mid)).toBeNull();
  });

  it("GET /chats/{id}/messages/{id}/logs returns the log body after a fire", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "log me" });
    await runManager.fireMessage(mid);

    const res = await userRequest("GET", `/chats/${chatId}/messages/${mid}/logs`);
    expect(res.status).toBe(200);
    const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    expect(text).toContain("vacation plans");
  });

  it("GET logs returns 404 for a message with no log file", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "no log yet" });
    const res = await userRequest("GET", `/chats/${chatId}/messages/${mid}/logs`);
    expect(res.status).toBe(404);
  });

  it("POST /run on a pending row dispatches the agent and the run finalizes", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "drag to active" });
    const res = await userRequest("POST", `/chats/${chatId}/messages/${mid}/run`);
    expect(res.status).toBe(200);

    for (let i = 0; i < 50; i++) {
      const row = await queries.messages.findById(pool, mid);
      if (row?.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("succeeded");
    expect(row?.startedAt).toBeDefined();
    expect(row?.endedAt).toBeDefined();
  });

  it("POST /run re-fires a succeeded row", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "rerun me" });
    await pool.query(
      `UPDATE messages SET state = 'succeeded', execute_at = NULL,
                           started_at = now() - interval '1 hour',
                           ended_at = now() - interval '1 hour'
       WHERE id = $1`,
      [mid],
    );
    const before = await queries.messages.findById(pool, mid);
    const beforeStart = before?.startedAt;

    const res = await userRequest("POST", `/chats/${chatId}/messages/${mid}/run`);
    expect(res.status).toBe(200);

    for (let i = 0; i < 50; i++) {
      const row = await queries.messages.findById(pool, mid);
      if (row?.state === "succeeded" && row.startedAt && row.startedAt !== beforeStart) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("succeeded");
    expect(row?.startedAt).not.toBe(beforeStart);
  });

  it("POST /run on a running row is a no-op (returns the row unchanged)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "already running" });
    await pool.query(`UPDATE messages SET state = 'running' WHERE id = $1`, [mid]);
    const res = await userRequest("POST", `/chats/${chatId}/messages/${mid}/run`);
    expect(res.status).toBe(200);
    const row = await queries.messages.findById(pool, mid);
    expect(row?.state).toBe("running");
  });

  it("POST /run rejects a wrong chatId with 404", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "wrong chat" });
    const res = await userRequest("POST", `/chats/chat_does_not_exist/messages/${mid}/run`);
    expect(res.status).toBe(404);
  });
});

describe("Note versioning via note-history (G6)", () => {
  async function userRequest(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const loginRes = await postJson("/auth/login", { username: "msgfire-user", password: "pw" }, null);
    const userTok = (loginRes.body as { token: string }).token;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${userTok}` };
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it("PATCH on a note snapshots the previous body and surfaces it via GET /note-history", async () => {
    const requestId = await insertPendingMessage({ type: "ai_note_request" });
    const { childIds } = await runManager.fireMessage(requestId);
    const noteId = childIds[0];

    const beforeHistory = await userRequest("GET", `/chats/${chatId}/messages/${noteId}/note-history`);
    expect((beforeHistory.body as { versions: unknown[] }).versions.length).toBe(0);

    const patched = await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${noteId}`,
      { content: { type: "note", body: "User rewrite 1." } },
    );
    expect(patched.status).toBe(200);

    const afterFirst = await userRequest("GET", `/chats/${chatId}/messages/${noteId}/note-history`);
    const versionsA = (afterFirst.body as { versions: Array<{ body: string }> }).versions;
    expect(versionsA.length).toBe(1);
    expect(versionsA[0].body).toContain("vacation plans");

    await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${noteId}`,
      { content: { type: "note", body: "User rewrite 2." } },
    );

    const afterSecond = await userRequest("GET", `/chats/${chatId}/messages/${noteId}/note-history`);
    const versionsB = (afterSecond.body as { versions: Array<{ body: string }> }).versions;
    expect(versionsB.length).toBe(2);
    expect(versionsB[0].body).toBe("User rewrite 1.");
    expect(versionsB[1].body).toContain("vacation plans");
  });

  it("firing an ai_note_request snapshots the prior note before the new child lands", async () => {
    const firstRequest = await insertPendingMessage({ type: "ai_note_request" });
    const { childIds: firstChildIds } = await runManager.fireMessage(firstRequest);
    const firstNoteId = firstChildIds[0];

    const secondRequest = await insertPendingMessage({ type: "ai_note_request" });
    await runManager.fireMessage(secondRequest);

    const history = await userRequest(
      "GET",
      `/chats/${chatId}/messages/${firstNoteId}/note-history`,
    );
    const versions = (history.body as { versions: Array<{ body: string }> }).versions;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0].body).toContain("vacation plans");
  });
});

describe("POST /chats/{id}/messages dedupes trigger content (G2)", () => {
  async function userRequest(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const loginRes = await postJson("/auth/login", { username: "msgfire-user", password: "pw" }, null);
    const userTok = (loginRes.body as { token: string }).token;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${userTok}` };
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it("creates a user message with the text and a trigger with agent_turn referencing it", async () => {
    const uniqueText = `unique-body-${Date.now()}`;

    const sent = await userRequest(
      "POST",
      `/chats/${chatId}/messages`,
      { content: uniqueText },
    );
    expect(sent.status).toBe(201);

    const { rows: rawRows } = await pool.query(
      `SELECT id, role, content FROM messages WHERE chat_id = $1`,
      [chatId],
    );
    // SQLite stores JSON as TEXT; parse at the test boundary.
    const rows = rawRows.map((r) => ({
      ...r,
      content: JSON.parse(r.content as string) as { type?: string; text?: string; userMessageId?: string },
    }));

    const textRows = rows.filter((r) =>
      r.content?.type === "text" && r.content?.text === uniqueText,
    );
    expect(textRows.length).toBe(1);
    expect(textRows[0].role).toBe("user");

    const triggerRows = rows.filter((r) => r.content?.type === "agent_turn");
    const ourTrigger = triggerRows.find((r) =>
      r.content.userMessageId === textRows[0].id,
    );
    expect(ourTrigger).toBeDefined();
  });
});
