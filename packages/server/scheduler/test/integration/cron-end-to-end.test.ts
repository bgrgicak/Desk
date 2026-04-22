/**
 * G8: Real recurring crontab run end-to-end.
 * Installs a `* * * * *` cron entry that fires desk-run, waits for ≥ 2 runs,
 * then cancels and asserts no further fires occur.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";
import { createAdapter, type ScheduleAdapter } from "../../src/scheduleAdapter.js";

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
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    let existing = "";
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"]);
      existing = stdout;
    } catch { return; }
    const lines = existing.split("\n").filter((l) => !l.includes("# desk-job:"));
    await execFileAsync("bash", ["-c", `echo "${lines.join("\n")}" | crontab -`]);
  } catch { /* ok */ }
}

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_cron_e2e_test_${workerId}`;

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

describe.skipIf(!crontabAvailable())("G8: real recurring cron run e2e", () => {
  let pool: pg.Pool;
  let chatId: string;
  let adapter: ScheduleAdapter;

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

    const testUrl = testConnectionString();
    pool = new pg.Pool({ connectionString: testUrl });
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
      [chatId, wsRows[0].id, agentRows[0].id, "Cron E2E Test Chat"],
    );

    // Configure env so cron jobs can find desk-run and connect to the test DB
    process.env.DATABASE_URL = testUrl;
    process.env.DESK_SANDBOX_DRIVER = "fake";
    process.env.DESK_RUN_BIN = "/desk/node_modules/.bin/desk-run";
    delete process.env.DESK_SCHEDULE_ADAPTER;
  });

  afterEach(async () => {
    await purgeDeskCrontab();
  });

  afterAll(async () => {
    await purgeDeskCrontab();
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

  // Skipped after M5: this test relied on the desk-run CLI being present on
  // disk; now that at/cron fires a curl to /internal/runs/fire instead, we
  // would also need to spin up a real API server in this test to receive
  // the fire. The adapter-level cron test (cron.test.ts) covers the
  // installation + cancellation path without the full loop.
  it.skip("cron fires ≥ 2 times, cancelJob removes entry, no further fires", async () => {
    adapter = createAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
    });

    // Install a recurring job that fires every minute
    const run = await mgr.enqueueRun({
      chatId,
      prompt: "Cron e2e test run",
      mode: "recurring",
      spec: "* * * * *",
    });

    expect(run.id).toMatch(/^run_/);

    // Find the scheduled job
    const activeJobs = await queries.scheduledJobs.listActive(pool);
    const ourJob = activeJobs.find((j) => j.chatId === chatId && j.kind === "recurring");
    expect(ourJob).toBeDefined();

    // Verify crontab -l contains the marker
    const cronJobs = await adapter.listCron();
    expect(cronJobs.some((j) => j.jobId === ourJob!.crontabId)).toBe(true);

    // Wait for at least 2 runs to appear (cron fires every minute)
    const maxWaitMs = 180_000;
    const pollMs = 5_000;
    const start = Date.now();
    let runCount = 0;

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));

      const { rows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM runs WHERE chat_id = $1 AND state IN ('succeeded', 'failed')`,
        [chatId],
      );
      runCount = parseInt(rows[0].cnt, 10);
      if (runCount >= 2) break;
    }

    expect(runCount).toBeGreaterThanOrEqual(2);

    // Cancel the job
    await mgr.cancelJob(ourJob!.id);

    // Assert crontab -l no longer contains the marker
    const cronJobsAfter = await adapter.listCron();
    expect(cronJobsAfter.some((j) => j.jobId === ourJob!.crontabId)).toBe(false);

    // Record current run count and wait ~90s — no new runs should appear
    const { rows: countBefore } = await pool.query(
      `SELECT COUNT(*) as cnt FROM runs WHERE chat_id = $1`,
      [chatId],
    );
    const countAtCancel = parseInt(countBefore[0].cnt, 10);

    await new Promise((r) => setTimeout(r, 90_000));

    const { rows: countAfter } = await pool.query(
      `SELECT COUNT(*) as cnt FROM runs WHERE chat_id = $1`,
      [chatId],
    );
    const countFinal = parseInt(countAfter[0].cnt, 10);

    expect(countFinal).toBe(countAtCancel);
  }, 300_000);
});
