/**
 * Integration tests for message firing, PATCH/DELETE/logs, and summary versioning.
 *
 * Covers:
 *   - PATCH / DELETE / GET logs on /chats/{id}/messages/{id}
 *   - Summary versioning via summary-history
 *   - POST /chats/{id}/messages deduplication
 *   - POST /chats/{id}/messages/{id}/run (force-fire)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, queries } from "@agent-desk/db";
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
let chatId: string;
let runManager: ReturnType<typeof createRunManager>;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-fire-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "msgfire-user";
  process.env.DESK_SEED_PASSWORD = "pw";
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
    home,
    reflectWorkspace: async (input) => ({
      journal: `# Journal\n\nManual reflection for ${input.workspaceId} with ${input.activity.length} activity item(s).`,
    }),
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
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
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
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
     VALUES (?, ?, 'system', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'))`,
    [id, chatId, JSON.stringify(content)],
  );
  return id;
}

async function insertScheduledTask(content: unknown, executeAt: string): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, kind, state, execute_at)
     VALUES (?, ?, 'user', ?, 'task', 'pending', ?)`,
    [id, chatId, JSON.stringify(content), executeAt],
  );
  return id;
}

async function insertScheduledReflection(workspaceId: string, executeAt: string): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, kind, state, execute_at, cron)
     VALUES (?, ?, 'system', ?, 'task', 'pending', ?, '0 3 * * *')`,
    [id, chatId, JSON.stringify({ type: "reflection_request", workspaceId }), executeAt],
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

  it("PATCH updates a summary message's body", async () => {
    const requestId = await insertPendingMessage({ type: "summary_request" });
    const { childIds } = await runManager.fireMessage(requestId);
    const summaryId = childIds[0];

    const patched = await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${summaryId}`,
      { content: { type: "summary", body: "User-edited summary." } },
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
                           started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
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
                           started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
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
    await pool.query(`UPDATE messages SET state = 'running' WHERE id = ?`, [mid]);
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

  it("POST /run manually fires a scheduled task without completing the parent", async () => {
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    const mid = await insertScheduledTask({ type: "text", text: "manual scheduled" }, executeAt);

    const res = await userRequest("POST", `/chats/${chatId}/messages/${mid}/run`);
    expect(res.status).toBe(200);

    for (let i = 0; i < 50; i++) {
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM messages WHERE parent_id = ? AND kind = 'task_run'`,
        [mid],
      );
      if (rows[0]?.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const parent = await queries.messages.findById(pool, mid);
    expect(parent?.state).toBe("pending");
    expect(parent?.executeAt).toBe(executeAt);

    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM messages WHERE parent_id = ? AND kind = 'task_run'`,
      [mid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("succeeded");

    const { rows: outputRows } = await pool.query<{ content: string }>(
      `SELECT child.content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [mid],
    );
    expect(JSON.parse(outputRows[0].content).type).toBe("events");
  });

  it("POST /run manually fires a scheduled reflection like a task", async () => {
    const { rows: wsRows } = await pool.query<{ id: string }>("SELECT id FROM workspaces LIMIT 1");
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    const mid = await insertScheduledReflection(wsRows[0].id, executeAt);

    const before = await queries.messages.findById(pool, mid);
    expect(before?.state).toBe("pending");

    const res = await userRequest("POST", `/chats/${chatId}/messages/${mid}/run`);
    expect(res.status).toBe(200);
    expect((res.body as { kind: string; state: string }).kind).toBe("task");
    expect((res.body as { state: string }).state).toBe("pending");

    for (let i = 0; i < 50; i++) {
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM messages WHERE parent_id = ? AND kind = 'task_run'`,
        [mid],
      );
      if (rows[0]?.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const parent = await queries.messages.findById(pool, mid);
    expect(parent?.state).toBe("pending");
    expect(parent?.executeAt).toBe(executeAt);

    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM messages WHERE parent_id = ? AND kind = 'task_run'`,
      [mid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("succeeded");
  });

  it("POST /run re-fires a succeeded row", async () => {
    const mid = await insertPendingMessage({ type: "text", text: "rerun me" });
    await pool.query(
      `UPDATE messages SET state = 'succeeded', execute_at = NULL,
                           started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'),
                           ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
       WHERE id = ?`,
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
    await pool.query(`UPDATE messages SET state = 'running' WHERE id = ?`, [mid]);
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

describe("Summary versioning via summary-history", () => {
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

  it("PATCH on a summary snapshots the previous body and surfaces it via GET /summary-history", async () => {
    const requestId = await insertPendingMessage({ type: "summary_request" });
    const { childIds } = await runManager.fireMessage(requestId);
    const summaryId = childIds[0];

    const beforeHistory = await userRequest("GET", `/chats/${chatId}/messages/${summaryId}/summary-history`);
    expect((beforeHistory.body as { versions: unknown[] }).versions.length).toBe(0);

    const patched = await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${summaryId}`,
      { content: { type: "summary", body: "User rewrite 1." } },
    );
    expect(patched.status).toBe(200);

    const afterFirst = await userRequest("GET", `/chats/${chatId}/messages/${summaryId}/summary-history`);
    const versionsA = (afterFirst.body as { versions: Array<{ body: string }> }).versions;
    expect(versionsA.length).toBe(1);
    expect(versionsA[0].body).toContain("vacation plans");
    const historyDir = path.join(home, "workspaces", "desk", ".chats", chatId, "notes", ".history");
    const historyFiles = await fs.readdir(historyDir);
    expect(historyFiles.some((name) => name.endsWith(`-${summaryId}.md`))).toBe(true);
    await expect(
      fs.stat(path.join(home, "workspaces", "desk", ".chats", chatId, "summary-history")),
    ).rejects.toThrow();

    await userRequest(
      "PATCH",
      `/chats/${chatId}/messages/${summaryId}`,
      { content: { type: "summary", body: "User rewrite 2." } },
    );

    const afterSecond = await userRequest("GET", `/chats/${chatId}/messages/${summaryId}/summary-history`);
    const versionsB = (afterSecond.body as { versions: Array<{ body: string }> }).versions;
    expect(versionsB.length).toBe(2);
    expect(versionsB[0].body).toBe("User rewrite 1.");
    expect(versionsB[1].body).toContain("vacation plans");
  });

  it("firing a summary_request snapshots the prior summary before the new child lands", async () => {
    const firstRequest = await insertPendingMessage({ type: "summary_request" });
    const { childIds: firstChildIds } = await runManager.fireMessage(firstRequest);
    const firstSummaryId = firstChildIds[0];

    const secondRequest = await insertPendingMessage({ type: "summary_request" });
    await runManager.fireMessage(secondRequest);

    const history = await userRequest(
      "GET",
      `/chats/${chatId}/messages/${firstSummaryId}/summary-history`,
    );
    const versions = (history.body as { versions: Array<{ body: string }> }).versions;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0].body).toContain("vacation plans");
  });

  it("surfaces legacy note-history snapshots after the summary rename", async () => {
    const requestId = await insertPendingMessage({ type: "summary_request" });
    const { childIds } = await runManager.fireMessage(requestId);
    const summaryId = childIds[0];
    const legacyNoteDir = path.join(home, "workspaces", "desk", ".chats", chatId, "note-history");
    const legacySummaryDir = path.join(home, "workspaces", "desk", ".chats", chatId, "summary-history");
    await fs.mkdir(legacyNoteDir, { recursive: true });
    await fs.mkdir(legacySummaryDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyNoteDir, `2026-05-04T10-00-00.000Z-${summaryId}.md`),
      "Legacy note-history body.",
      "utf-8",
    );
    await fs.writeFile(
      path.join(legacySummaryDir, `2026-05-04T10-01-00.000Z-${summaryId}.md`),
      "Legacy summary-history body.",
      "utf-8",
    );

    const history = await userRequest(
      "GET",
      `/chats/${chatId}/messages/${summaryId}/summary-history`,
    );
    const versions = (history.body as { versions: Array<{ body: string }> }).versions;
    expect(versions.some((version) => version.body === "Legacy note-history body.")).toBe(true);
    expect(versions.some((version) => version.body === "Legacy summary-history body.")).toBe(true);
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
      `SELECT id, role, content FROM messages WHERE chat_id = ?`,
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
