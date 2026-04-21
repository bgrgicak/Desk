import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { reconcile } from "../src/reconcile.js";
import { createMemoryAdapter } from "../src/scheduleAdapter.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_reconcile_test_${workerId}`;

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

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch { /* ok */ }

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
    [chatId, workspaceId, agentId, "Reconcile Test Chat"],
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

describe("reconcile", () => {
  it("deactivates DB jobs missing from system", async () => {
    const adapter = createMemoryAdapter();

    // Insert a job in DB with an at_job_id, but no matching system job
    const jobId = generateId("scheduledJob");
    await queries.scheduledJobs.insert(pool, {
      id: jobId,
      chatId,
      kind: "once",
      spec: { type: "once", onceAt: "now + 1 hour" },
      atJobId: "999",
    });

    await reconcile(pool, adapter);

    const job = await queries.scheduledJobs.findById(pool, jobId);
    expect(job!.active).toBe(false);
  });

  it("removes orphaned system jobs not in DB", async () => {
    const adapter = createMemoryAdapter();

    // Add an at job to the system that has no corresponding DB row
    await adapter.scheduleAt("orphan-command", "now + 1 hour");

    const beforeList = await adapter.listAt();
    expect(beforeList.length).toBe(1);

    await reconcile(pool, adapter);

    const afterList = await adapter.listAt();
    expect(afterList.length).toBe(0);
  });

  it("is idempotent", async () => {
    const adapter = createMemoryAdapter();

    await reconcile(pool, adapter);
    await reconcile(pool, adapter);
    // No errors — good
  });

  it("Gap 12: reconcile after restart preserves matching jobs", async () => {
    const adapter = createMemoryAdapter();

    // Create a cron job in both DB and system (simulating pre-restart state)
    const jobId = generateId("scheduledJob");
    const crontabId = jobId; // The crontab marker uses jobId

    await adapter.installCron(crontabId, "*/10 * * * *", `desk-run ${jobId}`);
    await queries.scheduledJobs.insert(pool, {
      id: jobId,
      chatId,
      kind: "recurring",
      spec: { type: "recurring", cronExpr: "*/10 * * * *" },
      crontabId,
    });

    // Simulate restart: reconcile with the same adapter
    await reconcile(pool, adapter);

    // The job should still be active (it matches)
    const job = await queries.scheduledJobs.findById(pool, jobId);
    expect(job!.active).toBe(true);

    // The cron entry should still exist
    const cronJobs = await adapter.listCron();
    expect(cronJobs.some((j) => j.jobId === crontabId)).toBe(true);
  });

  it("Gap 12: reconcile after restart deactivates DB jobs missing from system", async () => {
    const adapter = createMemoryAdapter();

    // Insert a DB job with no matching system entry (simulating lost state)
    const jobId = generateId("scheduledJob");
    await queries.scheduledJobs.insert(pool, {
      id: jobId,
      chatId,
      kind: "recurring",
      spec: { type: "recurring", cronExpr: "*/5 * * * *" },
      crontabId: "nonexistent_cron_id",
    });

    await reconcile(pool, adapter);

    const job = await queries.scheduledJobs.findById(pool, jobId);
    expect(job!.active).toBe(false);
  });
});
