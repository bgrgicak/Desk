/**
 * G12: Reconcile after real process restart.
 * Uses real `at` and `crontab` to verify that reconcile correctly handles
 * orphaned DB jobs and orphaned system jobs after a simulated process restart.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";
import { createAdapter, type ScheduleAdapter } from "../../src/scheduleAdapter.js";
import { reconcile } from "../../src/reconcile.js";

const execFileAsync = promisify(execFile);

function atAvailable(): boolean {
  try {
    execFileSync("which", ["at"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function crontabAvailable(): boolean {
  try {
    execFileSync("which", ["crontab"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Purge all desk-job markers from the user's crontab. */
async function purgeDeskCrontab(): Promise<void> {
  try {
    let existing = "";
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"]);
      existing = stdout;
    } catch { return; }
    const lines = existing.split("\n").filter((l) => !l.includes("# desk-job:"));
    await execFileAsync("bash", ["-c", `echo "${lines.join("\n")}" | crontab -`]);
  } catch { /* ok */ }
}

/** Remove all at jobs. */
async function purgeAtJobs(adapter: ScheduleAdapter): Promise<void> {
  try {
    const jobs = await adapter.listAt();
    for (const j of jobs) {
      try { await adapter.removeAt(j.id); } catch { /* ok */ }
    }
  } catch { /* ok */ }
}

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_reconcile_restart_test_${workerId}`;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:5432/desk";
}

function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

const bothAvailable = atAvailable() && crontabAvailable();

describe.skipIf(!bothAvailable)("G12: reconcile after real process restart", () => {
  let chatId: string;
  let testUrl: string;

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

    testUrl = testConnectionString();
    const pool = new pg.Pool({ connectionString: testUrl });
    try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }

    await runMigrations(pool);
    process.env.DESK_SEED_USERNAME = "testuser";
    process.env.DESK_SEED_PASSWORD = "testpass";
    await seedIfEmpty(pool);

    const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
    const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");

    chatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
      [chatId, wsRows[0].id, agentRows[0].id, "Reconcile Restart Test Chat"],
    );

    await pool.end();

    // Configure env
    process.env.DATABASE_URL = testUrl;
    process.env.DESK_SANDBOX_DRIVER = "fake";
    process.env.DESK_RUN_BIN = "/desk/node_modules/.bin/desk-run";
    delete process.env.DESK_SCHEDULE_ADAPTER;
  });

  afterEach(async () => {
    const adapter = createAdapter();
    await purgeAtJobs(adapter);
    await purgeDeskCrontab();
  });

  afterAll(async () => {
    const adapter = createAdapter();
    await purgeAtJobs(adapter);
    await purgeDeskCrontab();

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

  it("reconcile handles orphaned DB rows and dangling system jobs after restart", async () => {
    // --- Process A: create jobs with real at/cron ---
    const poolA = new pg.Pool({ connectionString: testUrl });
    const adapterA = createAdapter();

    const mgrA = createRunManager({
      pool: poolA,
      adapter: adapterA,
      execRunFn: async (_runId, _agentId, _prompt, onLog) => {
        onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "noop" });
        return { exitCode: 0 };
      },
    });

    // Enqueue one scheduled (at) and one recurring (cron) job
    const scheduledRun = await mgrA.enqueueRun({
      chatId,
      prompt: "Reconcile at test",
      mode: "scheduled",
      spec: "now + 59 minutes",
    });

    const recurringRun = await mgrA.enqueueRun({
      chatId,
      prompt: "Reconcile cron test",
      mode: "recurring",
      spec: "0 3 * * *",
    });

    // Assert: atq lists the at job
    const atJobsBefore = await adapterA.listAt();
    expect(atJobsBefore.length).toBeGreaterThanOrEqual(1);

    // Assert: crontab -l contains the cron marker
    const cronJobsBefore = await adapterA.listCron();
    expect(cronJobsBefore.length).toBeGreaterThanOrEqual(1);

    // Assert: scheduled_jobs rows are active
    const activeJobsA = await queries.scheduledJobs.listActive(poolA);
    const atJob = activeJobsA.find((j) => j.kind === "once" && j.chatId === chatId);
    const cronJob = activeJobsA.find((j) => j.kind === "recurring" && j.chatId === chatId);
    expect(atJob).toBeDefined();
    expect(atJob!.active).toBe(true);
    expect(cronJob).toBeDefined();
    expect(cronJob!.active).toBe(true);

    // --- Simulate process exit ---
    await poolA.end();

    // --- Process B: fresh pool, reconcile ---
    const poolB = new pg.Pool({ connectionString: testUrl });
    const adapterB = createAdapter();

    // Scenario 1: Orphan the recurring DB row by clearing crontab
    // (Simulates: cron state lost but DB still has active row)
    await execFileAsync("bash", ["-c", `echo "" | crontab -`]);

    // Verify crontab is empty
    const cronAfterClear = await adapterB.listCron();
    expect(cronAfterClear.length).toBe(0);

    await reconcile(poolB, adapterB);

    // After reconcile, the cron DB row should be deactivated
    const cronJobAfter = await queries.scheduledJobs.findById(poolB, cronJob!.id);
    expect(cronJobAfter!.active).toBe(false);

    // The at-based job should still be active (it's still in the system)
    const atJobAfter = await queries.scheduledJobs.findById(poolB, atJob!.id);
    expect(atJobAfter!.active).toBe(true);

    // Scenario 2: Remove the DB row for the at-based job → dangling at job
    // First, record the at job ID
    const danglingAtId = atJob!.atJobId!;

    // Deactivate in DB (simulates: DB lost the row after restart)
    await queries.scheduledJobs.cancel(poolB, atJob!.id);

    // Verify the system at job still exists
    const atJobsBeforeReconcile = await adapterB.listAt();
    expect(atJobsBeforeReconcile.some((j) => j.id === danglingAtId)).toBe(true);

    // Reconcile again — should clean up the dangling at job
    await reconcile(poolB, adapterB);

    // The system at job should have been atrm'd
    const atJobsAfterReconcile = await adapterB.listAt();
    expect(atJobsAfterReconcile.some((j) => j.id === danglingAtId)).toBe(false);

    await poolB.end();
  }, 60_000);
});
