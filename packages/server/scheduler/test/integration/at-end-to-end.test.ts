/**
 * G7: Real `at` scheduled run end-to-end.
 * Schedules a job via RunManager with the real adapter, waits for the at daemon
 * to fire `desk-run`, and asserts that the run reaches a terminal state with
 * at least one run_events row appended.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";
import { createAdapter, type ScheduleAdapter } from "../../src/scheduleAdapter.js";

function atAvailable(): boolean {
  try {
    execFileSync("which", ["at"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_at_e2e_test_${workerId}`;

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

describe.skipIf(!atAvailable())("G7: real at scheduled run e2e", () => {
  let pool: pg.Pool;
  let chatId: string;
  let adapter: ScheduleAdapter;

  // Track at jobs for cleanup
  const cleanupAtIds: string[] = [];

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
      [chatId, wsRows[0].id, agentRows[0].id, "At E2E Test Chat"],
    );

    // Configure env so at jobs can find desk-run and connect to the test DB
    process.env.DATABASE_URL = testUrl;
    process.env.DESK_SANDBOX_DRIVER = "fake";
    process.env.DESK_RUN_BIN = "/desk/node_modules/.bin/desk-run";
    delete process.env.DESK_SCHEDULE_ADAPTER;
  });

  afterEach(async () => {
    // Clean up any residual at jobs
    if (adapter) {
      for (const id of cleanupAtIds) {
        try { await adapter.removeAt(id); } catch { /* ok */ }
      }
    }
    cleanupAtIds.length = 0;
  });

  afterAll(async () => {
    // Purge any remaining at jobs created by this test
    try {
      const jobs = await adapter?.listAt();
      if (jobs) {
        for (const j of jobs) {
          try { await adapter.removeAt(j.id); } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }

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

  it("at daemon fires desk-run, run reaches terminal state, run_events appended", async () => {
    adapter = createAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
    });

    // Schedule a run to fire ASAP via at
    const run = await mgr.enqueueRun({
      chatId,
      prompt: "At e2e test run",
      mode: "scheduled",
      spec: "now + 1 minute",
    });

    expect(run.id).toMatch(/^run_/);

    // Find the scheduled job that was created
    const activeJobs = await queries.scheduledJobs.listActive(pool);
    const ourJob = activeJobs.find((j) => j.chatId === chatId && j.kind === "once");
    expect(ourJob).toBeDefined();
    expect(ourJob!.atJobId).toBeTruthy();
    cleanupAtIds.push(ourJob!.atJobId!);

    // Verify the at job is in the system queue
    const atJobs = await adapter.listAt();
    expect(atJobs.some((j) => j.id === ourJob!.atJobId)).toBe(true);

    // Poll the runs table until the at-fired desk-run creates a NEW run that reaches
    // a terminal state. desk-run enqueues an "immediate" run for the job.
    const maxWaitMs = 120_000;
    const pollMs = 2_000;
    const start = Date.now();
    let terminalRun: { id: string; state: string } | undefined;

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));

      // desk-run creates a new run linked to a different chat (it uses job.chatId)
      const { rows } = await pool.query(
        `SELECT id, state FROM runs WHERE chat_id = $1 AND state IN ('succeeded', 'failed') ORDER BY started_at DESC LIMIT 1`,
        [chatId],
      );
      if (rows.length > 0) {
        terminalRun = rows[0] as { id: string; state: string };
        break;
      }
    }

    expect(terminalRun).toBeDefined();
    expect(["succeeded", "failed"]).toContain(terminalRun!.state);

    // Assert at least one run_events row was appended
    const events = await queries.runEvents.listByRun(pool, terminalRun!.id, { limit: 100 });
    expect(events.items.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
