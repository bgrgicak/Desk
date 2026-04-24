import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId, type WsEvent } from "@desk/shared";
import { createRunManager } from "../src/runs.js";
import { createMemoryAdapter } from "../src/scheduleAdapter.js";
import type { LogEvent } from "@desk/runtime";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_scheduler_test_${workerId}`;

let pool: pg.Pool;
let agentId: string;
let chatId: string;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}

function adminConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: adminConnectionString() });
}

beforeAll(async () => {
  const admin = adminPool();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: testConnectionString() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id as string;
  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
     VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Test Chat"],
  );

  // Log files land under $DESK_HOME/Desk/workspaces/desk/.chats/{chatId}/logs/
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "desk-scheduler-"));
  process.env.DESK_HOME = tmpHome;
});

afterAll(async () => {
  if (pool) await pool.end();
  const admin = adminPool();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
});

async function insertPendingMessage(content: unknown): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state)
     VALUES ($1, $2, 'system', $3, 'pending')`,
    [id, chatId, JSON.stringify(content)],
  );
  return id;
}

describe("fireMessage", () => {
  it("claims pending → running, runs the agent, produces an events child, succeeds", async () => {
    const events: WsEvent[] = [];
    const fakeExec = async (
      messageId: string,
      _agentId: string,
      _prompt: string,
      onLog: (evt: LogEvent) => void,
    ) => {
      onLog({ runId: messageId, seq: 0, kind: "stdout", payload: JSON.stringify({ type: "step_start", sessionID: "s1" }) });
      onLog({ runId: messageId, seq: 1, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "hello from agent" } }) });
      onLog({ runId: messageId, seq: 2, kind: "stderr", payload: "diagnostic noise" });
      onLog({ runId: messageId, seq: 3, kind: "stdout", payload: JSON.stringify({ type: "step_finish" }) });
      return { exitCode: 0 };
    };

    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      emit: (evt) => events.push(evt),
      execRunFn: fakeExec,
    });

    const messageId = await insertPendingMessage({ type: "text", text: "hi agent" });

    const result = await mgr.fireMessage(messageId);
    expect(result.fired).toBe(true);
    expect(result.childIds).toHaveLength(1);

    const parent = await queries.messages.findById(pool, messageId);
    expect(parent?.state).toBe("succeeded");
    expect(parent?.startedAt).toBeDefined();
    expect(parent?.endedAt).toBeDefined();

    // Child content is structured events, with stderr interleaved.
    const child = await queries.messages.findById(pool, result.childIds[0]);
    const content = child!.content as {
      type: string;
      log: Array<{ kind: string; event?: { type: string }; line?: string }>;
    };
    expect(content.type).toBe("events");
    expect(content.log.map((e) => e.kind)).toEqual(["event", "event", "stderr", "event"]);
    expect(content.log[0].event?.type).toBe("step_start");
    expect(content.log[2].line).toBe("diagnostic noise");

    const updated = events.filter((e) => e.type === "message.updated");
    expect(updated.length).toBeGreaterThanOrEqual(2);
    const appended = events.filter((e) => e.type === "message.appended");
    expect(appended.length).toBe(1);
  });

  it("ai_note_request content produces a note-content child", async () => {
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async (messageId, _a, _p, onLog) => {
        onLog({ runId: messageId, seq: 0, kind: "stdout", payload: "Note about the vacation chat." });
        return { exitCode: 0 };
      },
    });

    const messageId = await insertPendingMessage({ type: "ai_note_request" });
    const result = await mgr.fireMessage(messageId);
    expect(result.childIds).toHaveLength(1);
    const child = await queries.messages.findById(pool, result.childIds[0]);
    const content = child!.content as { type: string; body?: string };
    expect(content.type).toBe("note");
    expect(content.body).toContain("vacation");
  });

  it("is idempotent — second fire on same message is a no-op", async () => {
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async () => ({ exitCode: 0 }),
    });

    const messageId = await insertPendingMessage({ type: "text", text: "idempotent" });
    const a = await mgr.fireMessage(messageId);
    expect(a.fired).toBe(true);

    const b = await mgr.fireMessage(messageId);
    expect(b.fired).toBe(false);
    expect(b.childIds).toHaveLength(0);
  });

  it("unknown messageId: fired=false, no side effects", async () => {
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async () => ({ exitCode: 0 }),
    });
    const result = await mgr.fireMessage("msg_does_not_exist");
    expect(result.fired).toBe(false);
  });

  it("exec failure: message transitions to failed", async () => {
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async () => ({ exitCode: 1 }),
    });

    const messageId = await insertPendingMessage({ type: "text", text: "will fail" });
    await mgr.fireMessage(messageId);
    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("failed");
  });

  it("agent_turn resolves the referenced user message's text as the prompt (G2)", async () => {
    let capturedPrompt = "";
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async (_id, _agentId, prompt, onLog) => {
        capturedPrompt = prompt;
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "ok" });
        return { exitCode: 0 };
      },
    });

    const userId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [userId, chatId, JSON.stringify({ type: "text", text: "resolve me please" })],
    );

    const triggerId = await insertPendingMessage({ type: "agent_turn", userMessageId: userId });
    await mgr.fireMessage(triggerId);

    expect(capturedPrompt).toBe("resolve me please");
  });
});

describe("scheduleAiNote", () => {
  async function clearNotes(): Promise<void> {
    await pool.query(
      `DELETE FROM messages WHERE chat_id = $1 AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
  }

  it("creates a pending ai_note_request message with an at scheduler_ref", async () => {
    const adapter = createMemoryAdapter();
    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });
    await clearNotes();

    await mgr.scheduleAiNote(chatId);

    const { rows } = await pool.query(
      `SELECT id, state, scheduler_ref FROM messages
       WHERE chat_id = $1 AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("pending");
    expect(rows[0].scheduler_ref).toMatchObject({ kind: "at" });
    expect((await adapter.listAt()).length).toBeGreaterThanOrEqual(1);
  });

  it("cancels the previous ai_note_request before scheduling a new one", async () => {
    const adapter = createMemoryAdapter();
    const mgr = createRunManager({ pool, adapter, execRunFn: async () => ({ exitCode: 0 }) });
    await clearNotes();

    await mgr.scheduleAiNote(chatId);
    const first = (await pool.query(
      `SELECT id FROM messages WHERE chat_id = $1 AND content->>'type' = 'ai_note_request'`,
      [chatId],
    )).rows[0].id as string;

    await mgr.scheduleAiNote(chatId);
    const after = (await pool.query(
      `SELECT id FROM messages WHERE chat_id = $1 AND content->>'type' = 'ai_note_request'`,
      [chatId],
    )).rows;
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(first);
  });
});

describe("cancelMessage", () => {
  it("removes the row and cancels the at ref", async () => {
    const adapter = createMemoryAdapter();
    const mgr = createRunManager({ pool, adapter, execRunFn: async () => ({ exitCode: 0 }) });
    await mgr.scheduleAiNote(chatId);

    const { rows } = await pool.query(
      `SELECT id, scheduler_ref FROM messages WHERE chat_id = $1 AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
    const messageId = rows[0].id as string;
    const beforeCount = (await adapter.listAt()).length;

    await mgr.cancelMessage(messageId);

    expect(await queries.messages.findById(pool, messageId)).toBeNull();
    const afterCount = (await adapter.listAt()).length;
    expect(afterCount).toBeLessThan(beforeCount);
  });
});
