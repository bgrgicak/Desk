/**
 * End-to-end test for POST /internal/messages/fire (M6b).
 *
 * Verifies that firing a pending scheduled message claims it atomically,
 * runs the agent in-process, finalizes the state, and emits a child
 * output message. Also covers:
 *   - idempotence: firing the same message twice only fires once
 *   - ai_note_request content produces a note-content child
 *   - auth rejection (missing/wrong token, non-loopback not testable here)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { resetInternalTokenCache } from "../src/auth/internal.js";

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

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let chatId: string;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "msgfire-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-fire-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const tokenPath = path.join(home, "internal-token");
  token = "qwertyuiopasdfghjklzxcvbnm123456";
  await fs.writeFile(tokenPath, token, { mode: 0o600 });
  process.env.DESK_INTERNAL_TOKEN_PATH = tokenPath;
  resetInternalTokenCache();

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async (runId, _a, _p, onLog) => {
      onLog({ runId, seq: 0, kind: "stdout", payload: "## Summary\n\nThe chat discussed vacation plans." });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  // Seed a chat so messages have a home.
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
  clearSessions();
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  resetInternalTokenCache();
  delete process.env.DESK_INTERNAL_TOKEN_PATH;
  delete process.env.DESK_HOME;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

function postInternal(pathStr: string, body: unknown, bearer: string | null): Promise<{ status: number; body: unknown }> {
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

describe("POST /internal/messages/fire", () => {
  it("rejects missing token", async () => {
    const res = await postInternal("/internal/messages/fire", { messageId: "msg_x" }, null);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const res = await postInternal("/internal/messages/fire", { messageId: "msg_x" }, "not-the-real-token-zzzzzzzzzzzzzzz");
    expect(res.status).toBe(401);
  });

  it("returns 400 when messageId is missing", async () => {
    const res = await postInternal("/internal/messages/fire", {}, token);
    expect(res.status).toBe(400);
  });

  it("fires a pending text message, runs the agent, produces a text child", async () => {
    const messageId = await insertPendingMessage({ type: "text", text: "Summarize X." });

    const res = await postInternal("/internal/messages/fire", { messageId }, token);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; fired: boolean; childIds: string[] };
    expect(body.fired).toBe(true);
    expect(body.childIds.length).toBe(1);

    // Parent message transitioned to succeeded.
    const parent = await queries.messages.findById(pool, messageId);
    expect(parent?.state).toBe("succeeded");
    expect(parent?.startedAt).toBeDefined();
    expect(parent?.endedAt).toBeDefined();

    // Child message attributed to parent, with text content.
    const child = await queries.messages.findById(pool, body.childIds[0]);
    expect(child?.parentId).toBe(messageId);
    expect(child?.role).toBe("agent");
    const content = child!.content as { type: "text"; text: string };
    expect(content.type).toBe("text");
    expect(content.text).toContain("vacation plans");
  });

  it("fires an ai_note_request message, producing a note-content child", async () => {
    const messageId = await insertPendingMessage({ type: "ai_note_request" });

    const res = await postInternal("/internal/messages/fire", { messageId }, token);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; fired: boolean; childIds: string[] };
    expect(body.fired).toBe(true);
    expect(body.childIds.length).toBe(1);

    const child = await queries.messages.findById(pool, body.childIds[0]);
    const content = child!.content as { type: string; body?: string };
    expect(content.type).toBe("note");
    expect(content.body).toContain("vacation plans");
  });

  it("is idempotent — second fire on the same message is a no-op", async () => {
    const messageId = await insertPendingMessage({ type: "text", text: "Idempotence test." });

    const first = await postInternal("/internal/messages/fire", { messageId }, token);
    expect((first.body as { fired: boolean }).fired).toBe(true);

    const second = await postInternal("/internal/messages/fire", { messageId }, token);
    expect((second.body as { fired: boolean }).fired).toBe(false);
    expect((second.body as { childIds: string[] }).childIds.length).toBe(0);
  });

  it("no-op for a non-existent messageId (fired:false, no state change)", async () => {
    const res = await postInternal("/internal/messages/fire", { messageId: "msg_does_not_exist_12345" }, token);
    expect(res.status).toBe(200);
    expect((res.body as { fired: boolean }).fired).toBe(false);
  });
});

describe("PATCH / DELETE / logs on /chats/{id}/messages/{id}", () => {
  async function userRequest(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    // Get a user session token.
    const loginRes = await postInternal("/auth/login", { username: "msgfire-user", password: "pw" }, null);
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
    // Fire an ai_note_request to produce a note message.
    const requestId = await insertPendingMessage({ type: "ai_note_request" });
    const fireRes = await postInternal("/internal/messages/fire", { messageId: requestId }, token);
    const { childIds } = fireRes.body as { childIds: string[] };
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

  it("PATCH rejects arbitrary state values (only cancelled/pending allowed)", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "x" });
    const res = await userRequest("PATCH", `/chats/${chatId}/messages/${mid}`, { state: "running" });
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
    await postInternal("/internal/messages/fire", { messageId: mid }, token);

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
});

describe("Note versioning via note-history (G6)", () => {
  async function userRequest(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const loginRes = await postInternal("/auth/login", { username: "msgfire-user", password: "pw" }, null);
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
    // Create a note-content message by firing an ai_note_request.
    const requestId = await insertPendingMessage({ type: "ai_note_request" });
    const fireRes = await postInternal("/internal/messages/fire", { messageId: requestId }, token);
    const { childIds } = fireRes.body as { childIds: string[] };
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
    // Newest first.
    expect(versionsB[0].body).toBe("User rewrite 1.");
    expect(versionsB[1].body).toContain("vacation plans");
  });

  it("firing an ai_note_request snapshots the prior note before the new child lands", async () => {
    // First fire: produces the initial note.
    const firstRequest = await insertPendingMessage({ type: "ai_note_request" });
    const firstFire = await postInternal("/internal/messages/fire", { messageId: firstRequest }, token);
    const firstNoteId = (firstFire.body as { childIds: string[] }).childIds[0];

    // Second fire: should snapshot the first note before inserting the new one.
    const secondRequest = await insertPendingMessage({ type: "ai_note_request" });
    await postInternal("/internal/messages/fire", { messageId: secondRequest }, token);

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
    const loginRes = await postInternal("/auth/login", { username: "msgfire-user", password: "pw" }, null);
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

    const { rows } = await pool.query(
      `SELECT id, role, content FROM messages WHERE chat_id = $1`,
      [chatId],
    );

    const textRows = rows.filter((r: { content: { type?: string; text?: string } }) =>
      r.content?.type === "text" && r.content?.text === uniqueText,
    );
    expect(textRows.length).toBe(1);
    expect(textRows[0].role).toBe("user");

    const triggerRows = rows.filter((r: { content: { type?: string } }) => r.content?.type === "agent_turn");
    const ourTrigger = triggerRows.find((r: { content: { userMessageId?: string } }) =>
      r.content.userMessageId === textRows[0].id,
    );
    expect(ourTrigger).toBeDefined();
  });

});
