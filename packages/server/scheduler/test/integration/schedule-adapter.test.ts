/**
 * Integration test for the real at/crontab schedule adapter.
 * Auto-detected — skipped when `at` and `crontab` are unavailable.
 * Gap 7: Real `at` scheduled run end-to-end.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createRunManager } from "../../src/runs.js";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createAdapter, type ScheduleAdapter } from "../../src/scheduleAdapter.js";

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_AT = commandExists("at");
const HAS_CRONTAB = commandExists("crontab");
const describeAt = HAS_AT ? describe : describe.skip;
const describeCrontab = HAS_CRONTAB ? describe : describe.skip;

describeAt("real schedule adapter — at", () => {
  let adapter: ScheduleAdapter;
  const cleanupAtIds: string[] = [];

  afterEach(async () => {
    for (const id of cleanupAtIds) {
      try { await adapter.removeAt(id); } catch { /* ok */ }
    }
    cleanupAtIds.length = 0;
  });

  it("scheduleAt creates a job that appears in listAt, removeAt removes it", async () => {
    delete process.env.DESK_SCHEDULE_ADAPTER;
    adapter = createAdapter();

    const atJobId = await adapter.scheduleAt("echo desk-test-job", "now + 1 hour");
    cleanupAtIds.push(atJobId);

    expect(atJobId).toBeTruthy();

    const jobs = await adapter.listAt();
    const found = jobs.find((j) => j.id === atJobId);
    expect(found).toBeTruthy();

    await adapter.removeAt(atJobId);
    cleanupAtIds.length = 0; // already cleaned

    const jobsAfter = await adapter.listAt();
    const foundAfter = jobsAfter.find((j) => j.id === atJobId);
    expect(foundAfter).toBeUndefined();
  });
});

describeCrontab("real schedule adapter — crontab", () => {
  let adapter: ScheduleAdapter;
  const cleanupCronIds: string[] = [];

  afterEach(async () => {
    for (const id of cleanupCronIds) {
      try { await adapter.removeCron(id); } catch { /* ok */ }
    }
    cleanupCronIds.length = 0;
  });

  it("installCron adds a line that appears in listCron, removeCron removes it", async () => {
    delete process.env.DESK_SCHEDULE_ADAPTER;
    adapter = createAdapter();

    const jobId = "test_cron_job_123";
    cleanupCronIds.push(jobId);

    await adapter.installCron(jobId, "0 3 * * *", "echo desk-cron-test");

    const jobs = await adapter.listCron();
    const found = jobs.find((j) => j.jobId === jobId);
    expect(found).toBeTruthy();
    expect(found!.cronExpr).toBe("0 3 * * *");

    await adapter.removeCron(jobId);
    cleanupCronIds.length = 0;

    const jobsAfter = await adapter.listCron();
    const foundAfter = jobsAfter.find((j) => j.jobId === jobId);
    expect(foundAfter).toBeUndefined();
  });

  it("installCron is idempotent — reinstalling same jobId replaces the line", async () => {
    delete process.env.DESK_SCHEDULE_ADAPTER;
    adapter = createAdapter();

    const jobId = "test_cron_idempotent";
    cleanupCronIds.push(jobId);

    await adapter.installCron(jobId, "0 1 * * *", "echo first");
    await adapter.installCron(jobId, "0 2 * * *", "echo second");

    const jobs = await adapter.listCron();
    const matches = jobs.filter((j) => j.jobId === jobId);
    expect(matches.length).toBe(1);
    expect(matches[0].cronExpr).toBe("0 2 * * *");

    await adapter.removeCron(jobId);
    cleanupCronIds.length = 0;
  });
});

/**
 * Real `at` scheduled message end-to-end (messages-as-truth).
 * Schedules a pending message + at entry via the real adapter, asserts both
 * exist, then cancels through cancelMessage and verifies both are gone.
 * Skipped if `at` is not installed.
 */
describeAt("real at scheduled message via RunManager", () => {

  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  const testDbName = `desk_real_at_test_${workerId}`;

  let pool: pg.Pool;
  let chatId: string;

  function baseUrl(): string {
    return process.env.DESK_TEST_DATABASE_URL
      ?? process.env.DATABASE_URL
      ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
  }

  beforeAll(async () => {
    const adminUrl = new URL(baseUrl());
    adminUrl.pathname = "/postgres";
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
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

    const testUrl = new URL(baseUrl());
    testUrl.pathname = `/${testDbName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString() });
    try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }

    await runMigrations(pool);
    process.env.DESK_SEED_USERNAME = "testuser";
    process.env.DESK_SEED_PASSWORD = "testpass";
    await seedIfEmpty(pool);

    const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
    const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
       VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [wsRows[0].id, agentRows[0].id],
    );

    chatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
      [chatId, wsRows[0].id, agentRows[0].id, "Real At Test Chat"],
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    const adminUrl = new URL(baseUrl());
    adminUrl.pathname = "/postgres";
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
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

  it("schedules a pending message + at entry, then cancels both via cancelMessage", async () => {
    delete process.env.DESK_SCHEDULE_ADAPTER;
    const adapter = createAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    // Use scheduleAiNote as the public entry point that creates a pending
    // message with a real at ref — same code path ordinary scheduled
    // messages take.
    await mgr.scheduleAiNote(chatId);

    const { rows } = await pool.query(
      `SELECT id, scheduler_ref FROM messages
       WHERE chat_id = $1 AND state = 'pending' AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
    expect(rows.length).toBe(1);
    const messageId = rows[0].id as string;
    const ref = rows[0].scheduler_ref as { kind: "at"; id: string };
    expect(ref.kind).toBe("at");
    expect(ref.id).toBeTruthy();

    const atJobs = await adapter.listAt();
    expect(atJobs.some((j) => j.id === ref.id)).toBe(true);

    await mgr.cancelMessage(messageId);

    expect(await queries.messages.findById(pool, messageId)).toBeNull();
    const afterJobs = await adapter.listAt();
    expect(afterJobs.some((j) => j.id === ref.id)).toBe(false);
  });
});
