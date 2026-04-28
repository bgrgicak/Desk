/**
 * Integration test for the DB-poll-based recurring-message scheduler path.
 * Uses tickScheduled() directly to simulate the poll loop firing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Cron } from "croner";
import { Pool, type PoolClient } from "@desk/db";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_sched_cron_${workerId}`;

let pool: Pool;
let chatId: string;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl());
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
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

  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  pool = new Pool({ connectionString: url.toString() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "cron-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Cron Test"],
  );

  const tmpHome = await (await import("node:fs/promises")).mkdtemp(
    (await import("node:path")).join((await import("node:os")).tmpdir(), "desk-cron-"),
  );
  process.env.DESK_HOME = tmpHome;
});

afterAll(async () => {
  if (pool) await pool.end();
  const adminUrl = new URL(baseUrl());
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
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

describe("DB poll scheduler — cron tasks", () => {
  it("a cron task with past execute_at fires on tickScheduled and advances to next occurrence", async () => {
    const cronExpr = "*/15 * * * *";
    const taskId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, kind)
       VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', $4, 'task')`,
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
       VALUES ($1, $2, 'user', $3, 'pending', now() - interval '1 second', 'task')`,
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
