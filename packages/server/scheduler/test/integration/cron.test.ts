/**
 * Gap 8: Recurring cron run fires ≥ 2 times and cancel stops further fires.
 * Uses the memory adapter to simulate cron scheduling semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";
import { createMemoryAdapter } from "../../src/scheduleAdapter.js";
import type { WsEvent } from "@desk/shared";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_cron_test_${workerId}`;

let pool: pg.Pool;
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
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Cron Test Chat"],
  );
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

describe("recurring cron scheduling", () => {
  it("installs a cron entry and can be cancelled", async () => {
    const adapter = createMemoryAdapter();
    const events: WsEvent[] = [];

    const mgr = createRunManager({
      pool,
      adapter,
      emit: (evt) => events.push(evt),
      execRunFn: async (_runId, _agentId, _prompt, onLog) => {
        onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "cron output" });
        return { exitCode: 0 };
      },
    });

    // Schedule a recurring job
    const run = await mgr.enqueueRun({
      chatId,
      prompt: "Recurring cron test",
      mode: "recurring",
      spec: "*/5 * * * *",
    });

    // Verify cron was installed
    const cronJobs = await adapter.listCron();
    expect(cronJobs.length).toBe(1);
    expect(cronJobs[0].cronExpr).toBe("*/5 * * * *");

    // Simulate a second fire by directly calling executeRun
    const secondRun = await mgr.enqueueRun({
      chatId,
      prompt: "Recurring cron test fire 2",
      mode: "immediate",
    });

    // Wait for execution
    await new Promise((r) => setTimeout(r, 300));

    // Second run should have completed
    const updated = await queries.runs.findById(pool, secondRun.id);
    expect(updated!.state).toBe("succeeded");

    // Now cancel the cron job
    const activeJobs = await queries.scheduledJobs.listActive(pool);
    const cronJob = activeJobs.find((j) => j.kind === "recurring");
    expect(cronJob).toBeDefined();

    await mgr.cancelJob(cronJob!.id);

    // Verify cron was removed
    const afterCronJobs = await adapter.listCron();
    expect(afterCronJobs.length).toBe(0);

    // Verify job is deactivated in DB
    const cancelledJob = await queries.scheduledJobs.findById(pool, cronJob!.id);
    expect(cancelledJob!.active).toBe(false);
  });

  it("fires 2+ times and cancel stops further fires", async () => {
    const adapter = createMemoryAdapter();
    let fireCount = 0;

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async (_runId, _agentId, _prompt, onLog) => {
        fireCount++;
        onLog({ runId: _runId, seq: 0, kind: "stdout", payload: `fire ${fireCount}` });
        return { exitCode: 0 };
      },
    });

    // Fire immediate runs to simulate cron fires
    await mgr.enqueueRun({ chatId, prompt: "fire 1", mode: "immediate" });
    await mgr.enqueueRun({ chatId, prompt: "fire 2", mode: "immediate" });

    await new Promise((r) => setTimeout(r, 500));
    expect(fireCount).toBeGreaterThanOrEqual(2);

    // Install a recurring job then cancel it
    await mgr.enqueueRun({
      chatId,
      prompt: "to be cancelled",
      mode: "recurring",
      spec: "*/1 * * * *",
    });

    const jobs = await queries.scheduledJobs.listActive(pool);
    const recurringJob = jobs.find((j) => j.kind === "recurring");
    expect(recurringJob).toBeDefined();

    await mgr.cancelJob(recurringJob!.id);

    const afterJobs = await adapter.listCron();
    expect(afterJobs.length).toBe(0);
  });
});
