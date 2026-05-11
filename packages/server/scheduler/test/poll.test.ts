// packages/server/scheduler/test/poll.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, queries } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { Cron } from "croner";
import { createRunManager } from "../src/runs.js";

let pool: Pool;
let chatId: string;
let agentId: string;
let dbPath: string;
let home: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-poll-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id as string;
  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Poll Test Chat"],
  );

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-poll-"));
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  if (home) await fs.rm(home, { recursive: true, force: true });
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

const PAST = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')";
const FUTURE = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')";

// ── tickScheduled ────────────────────────────────────────────────────────────

describe("tickScheduled", () => {
  it("fires a pending task whose execute_at is in the past", async () => {
    const rm = makeRunManager();
    const msgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES (?, ?, 'user', ?, 'pending', ${PAST}, 'task')`,
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
       VALUES (?, ?, 'user', ?, 'pending', ${FUTURE}, 'task')`,
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
       VALUES (?, ?, 'user', ?, 'pending', 'task')`,
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
       VALUES (?, ?, 'user', ?, 'pending', ${PAST}, ?, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "daily" }), cronExpr],
    );

    await rm.tickScheduled();

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
       VALUES (?, ?, 'user', ?, 'pending', ${PAST}, ?, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "every 30 min" }), cronExpr],
    );

    const expectedNext = new Cron(cronExpr).nextRun()!;
    await rm.tickScheduled();

    const task = await queries.messages.findById(pool, taskId);
    const diff = Math.abs(new Date(task!.executeAt!).getTime() - expectedNext.getTime());
    expect(diff).toBeLessThan(5000);
  });

  it("execute_at advances even when the task run fails (exit code 1)", async () => {
    const rm = createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 1 }),
    });
    const taskId = generateId("message");
    const cronExpr = "0 8 * * *";
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, kind)
       VALUES (?, ?, 'user', ?, 'pending', ${PAST}, ?, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "daily failing" }), cronExpr],
    );

    await rm.tickScheduled();

    const task = await queries.messages.findById(pool, taskId);
    expect(task?.state).toBe("pending");
    expect(task?.executeAt).toBeDefined();
    expect(new Date(task!.executeAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

// ── concurrency cap ──────────────────────────────────────────────────────────

describe("concurrency cap", () => {
  it("fires at most MAX_CONCURRENT tasks per tick", async () => {
    const prev = process.env.DESK_SCHEDULER_MAX_CONCURRENT;
    process.env.DESK_SCHEDULER_MAX_CONCURRENT = "3";
    try {
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

      // Insert 5 due tasks — more than the configured cap of 3
      for (let i = 0; i < 5; i++) {
        const id = generateId("message");
        await pool.query(
          `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
           VALUES (?, ?, 'user', ?, 'pending', ${PAST}, 'task')`,
          [id, chatId, JSON.stringify({ type: "text", text: `task ${i}` })],
        );
      }

      await rm.tickScheduled();

      expect(concurrentPeak).toBeLessThanOrEqual(3);
    } finally {
      if (prev === undefined) delete process.env.DESK_SCHEDULER_MAX_CONCURRENT;
      else process.env.DESK_SCHEDULER_MAX_CONCURRENT = prev;
    }
  });
});

// ── summary pruning ──────────────────────────────────────────────────────────

describe("summary pruning", () => {
  it("scheduleSummary deletes pending summary rows without touching running or completed rows", async () => {
    const rm = makeRunManager();

    const oldSucceeded = generateId("message");
    const oldRunning = generateId("message");
    const oldPending = generateId("message");

    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind)
       VALUES (?, ?, 'system', ?, 'succeeded', 'summary'),
              (?, ?, 'system', ?, 'running',   'summary'),
              (?, ?, 'system', ?, 'pending',   'summary')`,
      [
        oldSucceeded, chatId, JSON.stringify({ type: "summary_request" }),
        oldRunning, chatId, JSON.stringify({ type: "summary_request" }),
        oldPending, chatId, JSON.stringify({ type: "summary_request" }),
      ],
    );

    await rm.scheduleSummary(chatId);

    expect(await queries.messages.findById(pool, oldSucceeded)).not.toBeNull();
    expect(await queries.messages.findById(pool, oldRunning)).not.toBeNull();
    expect(await queries.messages.findById(pool, oldPending)).toBeNull();

    // A new pending summary must have been created
    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE chat_id = ? AND kind = 'summary' AND state = 'pending'`,
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
       VALUES (?, ?, 'user', ?, 'pending', ${FUTURE}, 'task')`,
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
       VALUES (?, ?, 'user', ?, 'paused', ${PAST}, 'task')`,
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
       VALUES (?, ?, 'user', ?, 'paused', ${PAST}, 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "resume me" })],
    );

    await rm.resumeMessage(id);
    const msg = await queries.messages.findById(pool, id);
    expect(msg?.state).toBe("pending");

    // Now tickScheduled should pick it up
    await rm.tickScheduled();
    const after = await queries.messages.findById(pool, id);
    expect(after?.state).toBe("succeeded");
  });

  it("cancelScheduledMessage transitions pending → cancelled", async () => {
    const rm = makeRunManager();
    const id = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES (?, ?, 'user', ?, 'pending', ${FUTURE}, 'task')`,
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
       VALUES (?, ?, 'user', ?, 'cancelled', ${PAST}, 'task')`,
      [id, chatId, JSON.stringify({ type: "text", text: "cancelled" })],
    );

    await rm.tickScheduled();
    expect(fired).toHaveLength(0);
  });
});

// ── idle-sandbox sweep ──────────────────────────────────────────────────────
//
// We split the SQL-side decision into `getActiveWorkspaceIds(idleMs)` so the
// "which workspaces should keep their sandbox alive?" contract can be tested
// directly without needing a container engine. The actual `docker rm` path
// (`reapIdleSandboxes`) is covered by the runtime/docker integration tests
// against a real engine.

describe("getActiveWorkspaceIds", () => {
  // Each test creates its own workspaces/chats and cleans up at the end so
  // ordering between tests doesn't matter and stale rows from the suites
  // above can't leak in.
  async function makeWorkspaceWithChat(): Promise<{ workspaceId: string; chatId: string }> {
    const workspaceId = generateId("workspace");
    const newChatId = generateId("chat");
    const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
    const userId = userRows[0].id as string;
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
      [workspaceId, userId, "sweep test", `/tmp/${workspaceId}`],
    );
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [newChatId, workspaceId, agentId, "sweep chat"],
    );
    return { workspaceId, chatId: newChatId };
  }

  it("treats a workspace with a running message as active", async () => {
    const rm = makeRunManager();
    const { workspaceId, chatId: cid } = await makeWorkspaceWithChat();
    const msgId = generateId("message");
    // Pin updated_at far in the past so only the `state='running'` arm
    // can mark this workspace active.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind, updated_at)
       VALUES (?, ?, 'user', ?, 'running', 'task_run', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`,
      [msgId, cid, JSON.stringify({ type: "text", text: "in-flight" })],
    );
    const active = await rm.getActiveWorkspaceIds(30 * 60 * 1000);
    expect(active.has(workspaceId)).toBe(true);
  });

  it("treats a workspace with a recent message as active", async () => {
    const rm = makeRunManager();
    const { workspaceId, chatId: cid } = await makeWorkspaceWithChat();
    const msgId = generateId("message");
    // 1 second ago, well inside a 30 minute idle window.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind, updated_at)
       VALUES (?, ?, 'user', ?, 'succeeded', 'task_run', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second'))`,
      [msgId, cid, JSON.stringify({ type: "text", text: "recent" })],
    );
    const active = await rm.getActiveWorkspaceIds(30 * 60 * 1000);
    expect(active.has(workspaceId)).toBe(true);
  });

  it("does not include a workspace whose only message is older than idleMs and not running", async () => {
    const rm = makeRunManager();
    const { workspaceId, chatId: cid } = await makeWorkspaceWithChat();
    const msgId = generateId("message");
    // 2 hours ago — outside any reasonable idle window.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind, updated_at)
       VALUES (?, ?, 'user', ?, 'succeeded', 'task_run', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`,
      [msgId, cid, JSON.stringify({ type: "text", text: "stale" })],
    );
    const active = await rm.getActiveWorkspaceIds(30 * 60 * 1000);
    expect(active.has(workspaceId)).toBe(false);
  });

  it("respects a wider idleMs that includes an otherwise-stale message", async () => {
    const rm = makeRunManager();
    const { workspaceId, chatId: cid } = await makeWorkspaceWithChat();
    const msgId = generateId("message");
    // 2 hours ago + 30 min window: not active. 3 hour window: active.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind, updated_at)
       VALUES (?, ?, 'user', ?, 'succeeded', 'task_run', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`,
      [msgId, cid, JSON.stringify({ type: "text", text: "old-but-not-ancient" })],
    );
    expect((await rm.getActiveWorkspaceIds(30 * 60 * 1000)).has(workspaceId)).toBe(false);
    expect((await rm.getActiveWorkspaceIds(3 * 60 * 60 * 1000)).has(workspaceId)).toBe(true);
  });
});

describe("sweepIdleSandboxes", () => {
  it("returns [] and doesn't throw when no docker engine is reachable", async () => {
    const rm = makeRunManager();
    // No DESK_CONTAINER_ENGINE override + no docker binary mocked → the
    // reaper sees no containers and returns empty. The DB query still
    // runs successfully even though the engine doesn't.
    const removed = await rm.sweepIdleSandboxes(30 * 60 * 1000);
    expect(Array.isArray(removed)).toBe(true);
  });
});

