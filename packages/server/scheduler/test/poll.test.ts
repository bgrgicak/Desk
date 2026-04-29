// packages/server/scheduler/test/poll.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { Cron } from "croner";
import { createRunManager } from "../src/runs.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_poll_test_${workerId}`;

let pool: pg.Pool;
let chatId: string;
let agentId: string;

function baseUrl() {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}
function adminUrl() { const u = new URL(baseUrl()); u.pathname = "/postgres"; return u.toString(); }
function testUrl() { const u = new URL(baseUrl()); u.pathname = `/${testDbName}`; return u.toString(); }

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminUrl() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new pg.Pool({ connectionString: testUrl() });
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
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Poll Test Chat"],
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  const admin = new pg.Pool({ connectionString: adminUrl() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

function makeRunManager(onFire?: () => void) {
  return createRunManager({
    pool,
    execRunFn: async (_runId) => {
      onFire?.();
      return { exitCode: 0 };
    },
  });
}

// ── tickScheduled ────────────────────────────────────────────────────────────

describe("tickScheduled", () => {
  it("fires a pending task whose execute_at is in the past", async () => {
    const rm = makeRunManager();
    const msgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', 'task')`,
      [msgId, chatId, JSON.stringify({ type: "text", text: "run me" })],
    );

    await rm.tickScheduled();

    // task kind goes through startTaskRun; the task definition stays pending for cron
    // (no cron here) so it becomes succeeded after the run
    const msg = await queries.messages.findById(pool, msgId);
    expect(msg?.state).toBe("succeeded");
  });

  it("does not fire a pending task whose execute_at is in the future", async () => {
    const rm = makeRunManager();
    const msgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() + interval '1 hour', 'task')`,
      [msgId, chatId, JSON.stringify({ type: "text", text: "not yet" })],
    );

    await rm.tickScheduled();

    const msg = await queries.messages.findById(pool, msgId);
    expect(msg?.state).toBe("pending");
  });

  it("does not fire a pending task with null execute_at", async () => {
    const rm = makeRunManager();
    const msgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind)
       VALUES ($1, $2, 'user', $3, 'pending', 'task')`,
      [msgId, chatId, JSON.stringify({ type: "text", text: "no schedule" })],
    );

    await rm.tickScheduled();

    const msg = await queries.messages.findById(pool, msgId);
    expect(msg?.state).toBe("pending");
  });
});

// ── cron tasks ───────────────────────────────────────────────────────────────

describe("cron tasks", () => {
  it("advances execute_at to next occurrence after firing, stays pending", async () => {
    const rm = makeRunManager();
    const taskId = generateId("message");
    const cronExpr = "0 9 * * *";
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', $4, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "daily" }), cronExpr],
    );

    await rm.tickScheduled();

    // Wait for the async fire to complete
    await new Promise((r) => setTimeout(r, 200));

    const task = await queries.messages.findById(pool, taskId);
    expect(task?.state).toBe("pending");
    expect(task?.executeAt).toBeDefined();
    expect(new Date(task!.executeAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("execute_at matches the next croner occurrence", async () => {
    const rm = makeRunManager();
    const taskId = generateId("message");
    const cronExpr = "*/30 * * * *";
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', $4, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "every 30 min" }), cronExpr],
    );

    const expectedNext = new Cron(cronExpr).next()!;
    await rm.tickScheduled();
    await new Promise((r) => setTimeout(r, 200));

    const task = await queries.messages.findById(pool, taskId);
    // Allow 5s tolerance for test execution time
    const diff = Math.abs(new Date(task!.executeAt!).getTime() - expectedNext.getTime());
    expect(diff).toBeLessThan(5000);
  });
});

// ── concurrency cap ──────────────────────────────────────────────────────────

describe("concurrency cap", () => {
  it("fires at most MAX_CONCURRENT tasks per tick", async () => {
    let concurrentPeak = 0;
    let current = 0;
    const rm = createRunManager({
      pool,
      execRunFn: async (_runId) => {
        current++;
        concurrentPeak = Math.max(concurrentPeak, current);
        await new Promise((r) => setTimeout(r, 80));
        current--;
        return { exitCode: 0 };
      },
    });

    // Insert 5 due tasks — more than the default cap of 3
    for (let i = 0; i < 5; i++) {
      const id = generateId("message");
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
         VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', 'task')`,
        [id, chatId, JSON.stringify({ type: "text", text: `task ${i}` })],
      );
    }

    await rm.tickScheduled();
    await new Promise((r) => setTimeout(r, 300)); // let all in-flight finish

    expect(concurrentPeak).toBeLessThanOrEqual(3);
  });
});

// ── ai_note pruning ──────────────────────────────────────────────────────────

describe("ai_note pruning", () => {
  it("scheduleAiNote deletes all existing ai_note rows for the chat, including completed ones", async () => {
    const rm = makeRunManager();

    const oldSucceeded = generateId("message");
    const oldPending = generateId("message");

    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind)
       VALUES ($1, $2, 'system', $3, 'succeeded', 'ai_note'),
              ($4, $2, 'system', $3, 'pending',   'ai_note')`,
      [oldSucceeded, chatId, JSON.stringify({ type: "ai_note_request" }), oldPending],
    );

    await rm.scheduleAiNote(chatId);

    expect(await queries.messages.findById(pool, oldSucceeded)).toBeNull();
    expect(await queries.messages.findById(pool, oldPending)).toBeNull();

    // A new pending ai_note must have been created
    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE chat_id = $1 AND kind = 'ai_note' AND state = 'pending'`,
      [chatId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].id).not.toBe(oldPending);
  });
});

// ── pause / resume / cancel ──────────────────────────────────────────────────

describe("pause / resume / cancel", () => {
  it("pauseMessage transitions pending → paused", async () => {
    const rm = makeRunManager();
    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() + interval '1 hour', 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "pause me" })],
    );

    await rm.pauseMessage(id);

    const msg = await queries.messages.findById(pool, id);
    expect(msg?.state).toBe("paused");
  });

  it("paused task is not picked up by tickScheduled", async () => {
    const fired: string[] = [];
    const rm = createRunManager({
      pool,
      execRunFn: async (runId) => { fired.push(runId); return { exitCode: 0 }; },
    });

    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'paused', now() - interval '1 second', 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "paused" })],
    );

    await rm.tickScheduled();

    expect(fired).not.toContain(id);
    const msg = await queries.messages.findById(pool, id);
    expect(msg?.state).toBe("paused");
  });

  it("resumeMessage transitions paused → pending and task becomes due", async () => {
    const rm = makeRunManager();
    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'paused', now() - interval '1 second', 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "resume me" })],
    );

    await rm.resumeMessage(id);
    const msg = await queries.messages.findById(pool, id);
    expect(msg?.state).toBe("pending");

    // Now tickScheduled should pick it up
    await rm.tickScheduled();
    await new Promise((r) => setTimeout(r, 200));
    const after = await queries.messages.findById(pool, id);
    expect(after?.state).toBe("succeeded");
  });

  it("cancelScheduledMessage transitions pending → cancelled", async () => {
    const rm = makeRunManager();
    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() + interval '1 hour', 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "cancel me" })],
    );

    await rm.cancelScheduledMessage(id);

    const msg = await queries.messages.findById(pool, id);
    expect(msg?.state).toBe("cancelled");
  });

  it("cancelled task is not picked up by tickScheduled", async () => {
    const fired: string[] = [];
    const rm = createRunManager({
      pool,
      execRunFn: async (runId) => { fired.push(runId); return { exitCode: 0 }; },
    });

    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES ($1, $2, 'user', $3, 'cancelled', now() - interval '1 second', 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "cancelled" })],
    );

    await rm.tickScheduled();
    expect(fired).toHaveLength(0);
  });
});
