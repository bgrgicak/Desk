/**
 * Integration test for the DB-poll-based recurring-message scheduler path.
 * Uses tickScheduled() directly to simulate the poll loop firing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Cron } from "croner";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, queries } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { createRunManager } from "../../src/runs.js";

let pool: Pool;
let chatId: string;
let home: string;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sched-cron-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "cron-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Cron Test"],
  );

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-cron-"));
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

describe("DB poll scheduler — cron tasks", () => {
  it("a cron task with past execute_at fires on tickScheduled and advances to next occurrence", async () => {
    const cronExpr = "*/15 * * * *";
    const taskId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, kind)
       VALUES (?, ?, 'user', ?, 'pending',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second'),
               ?, 'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "recurring" }), cronExpr],
    );

    const mgr = createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    const expectedNext = new Cron(cronExpr).nextRun()!;
    await mgr.tickScheduled();

    const task = await queries.messages.findById(pool, taskId);
    expect(task?.state).toBe("pending");
    expect(task?.executeAt).toBeDefined();
    const diff = Math.abs(new Date(task!.executeAt!).getTime() - expectedNext.getTime());
    expect(diff).toBeLessThan(5000);
  });

  it("a one-shot task fires and transitions to succeeded", async () => {
    const taskId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, kind)
       VALUES (?, ?, 'user', ?, 'pending',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second'),
               'task')`,
      [taskId, chatId, JSON.stringify({ type: "text", text: "one-shot" })],
    );

    const mgr = createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    await mgr.tickScheduled();

    const task = await queries.messages.findById(pool, taskId);
    expect(task?.state).toBe("succeeded");
    expect(task?.executeAt).toBeUndefined();
  });
});
