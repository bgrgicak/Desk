import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../src/runs.js";
import { createMemoryAdapter } from "../src/scheduleAdapter.js";
import type { LogEvent } from "@desk/runtime";
import type { WsEvent } from "@desk/shared";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_scheduler_test_${workerId}`;

let pool: pg.Pool;
let agentId: string;
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
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id as string;

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Test Chat"],
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

describe("createRunManager", () => {
  it("enqueueRun immediate: creates a run, executes it, transitions state", async () => {
    const events: WsEvent[] = [];
    const adapter = createMemoryAdapter();

    const fakeExec = async (
      _runId: string,
      _agentId: string,
      _prompt: string,
      onLog: (evt: LogEvent) => void,
    ) => {
      onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "hello" });
      return { exitCode: 0 };
    };

    const mgr = createRunManager({
      pool,
      adapter,
      emit: (evt) => events.push(evt),
      execRunFn: fakeExec,
    });

    const run = await mgr.enqueueRun({
      chatId,
      prompt: "Test immediate run",
      mode: "immediate",
    });

    expect(run.id).toMatch(/^run_/);
    expect(run.state).toBe("pending");

    // Wait for async execution to complete
    await new Promise((r) => setTimeout(r, 200));

    const updated = await queries.runs.findById(pool, run.id);
    expect(updated!.state).toBe("succeeded");

    // Should have emitted run.state_changed events
    const stateEvents = events.filter((e) => e.type === "run.state_changed");
    expect(stateEvents.length).toBeGreaterThanOrEqual(2); // running + succeeded
  });

  it("enqueueRun scheduled: creates a job with at", async () => {
    const adapter = createMemoryAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    await mgr.enqueueRun({
      chatId,
      prompt: "Test scheduled",
      mode: "scheduled",
      spec: "now + 5 minutes",
    });

    const atJobs = await adapter.listAt();
    expect(atJobs.length).toBe(1);
  });

  it("enqueueRun recurring: installs a cron line", async () => {
    const adapter = createMemoryAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    await mgr.enqueueRun({
      chatId,
      prompt: "Test recurring",
      mode: "recurring",
      spec: "*/10 * * * *",
    });

    const cronJobs = await adapter.listCron();
    expect(cronJobs.length).toBe(1);
    expect(cronJobs[0].cronExpr).toBe("*/10 * * * *");
  });

  it("enqueueRun ai_note: cancels previous and schedules new", async () => {
    const adapter = createMemoryAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    // First ai_note
    await mgr.enqueueRun({
      chatId,
      prompt: "AI note 1",
      mode: "ai_note",
    });

    const firstAtJobs = await adapter.listAt();
    expect(firstAtJobs.length).toBe(1);
    const firstJobId = firstAtJobs[0].id;

    // Second ai_note for same chat — should cancel the first
    await mgr.enqueueRun({
      chatId,
      prompt: "AI note 2",
      mode: "ai_note",
    });

    const secondAtJobs = await adapter.listAt();
    // The first should be removed, a new one created
    expect(secondAtJobs.length).toBe(1);
    expect(secondAtJobs[0].id).not.toBe(firstJobId);
  });

  it("cancelRun marks state as cancelled", async () => {
    const adapter = createMemoryAdapter();

    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async (_runId, _agentId, _prompt, onLog) => {
        // Simulate a long-running task
        await new Promise((r) => setTimeout(r, 5000));
        return { exitCode: 0 };
      },
    });

    const run = await mgr.enqueueRun({
      chatId,
      prompt: "Cancel me",
      mode: "immediate",
    });

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 50));

    await mgr.cancelRun(run.id);

    const updated = await queries.runs.findById(pool, run.id);
    expect(updated!.state).toBe("cancelled");
  });
});
