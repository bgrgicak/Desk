import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { reconcile, sweepStaleRuns } from "../src/reconcile.js";
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
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
     VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

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

interface ScheduledRow {
  executeAt?: string;     // ISO — future default
  cron?: string;
  schedulerRef: { kind: "at" | "cron"; id: string } | null;
}

async function insertPendingScheduled(row: ScheduledRow): Promise<string> {
  const id = generateId("message");
  const executeAtExpr = row.cron
    ? "NULL"
    : row.executeAt
      ? `'${row.executeAt}'::timestamptz`
      : "now() + interval '1 hour'";
  const cronExpr = row.cron ? `'${row.cron}'` : "NULL";
  const refExpr = row.schedulerRef
    ? `'${JSON.stringify(row.schedulerRef)}'::jsonb`
    : "NULL";
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, scheduler_ref)
     VALUES ($1, $2, 'system', $3, 'pending', ${executeAtExpr}, ${cronExpr}, ${refExpr})`,
    [id, chatId, JSON.stringify({ type: "text", text: "scheduled thing" })],
  );
  return id;
}

async function clearPending(): Promise<void> {
  await pool.query("DELETE FROM messages WHERE chat_id = $1 AND state = 'pending'", [chatId]);
}

describe("reconcile / sweepStaleRuns", () => {
  it("reinstalls at-entry and keeps message pending when system lost it (future executeAt)", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const executeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const messageId = await insertPendingScheduled({
      executeAt,
      schedulerRef: { kind: "at", id: "nonexistent_at" },
    });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.kind).toBe("at");
    expect(msg?.schedulerRef?.id).not.toBe("nonexistent_at");

    const ats = await adapter.listAt();
    expect(ats.find((j) => j.id === msg?.schedulerRef?.id)).toBeDefined();
  });

  it("reinstalls cron-entry and keeps message pending when system lost it", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const messageId = await insertPendingScheduled({
      cron: "0 9 * * *",
      schedulerRef: { kind: "cron", id: "nonexistent_cron" },
    });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.kind).toBe("cron");
    expect(msg?.schedulerRef?.id).toBe(messageId);
    const crons = await adapter.listCron();
    expect(crons.find((c) => c.jobId === messageId)).toBeDefined();
  });

  it("reschedules overdue at-job as 'now' so the daemon fires it on the next tick", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const staleAtId = await adapter.scheduleAt("stale cmd", "now + 1 hour");
    const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const messageId = await insertPendingScheduled({
      executeAt: pastIso,
      schedulerRef: { kind: "at", id: staleAtId },
    });

    await sweepStaleRuns(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.id).not.toBe(staleAtId);

    const ats = await adapter.listAt();
    const newEntry = ats.find((j) => j.id === msg?.schedulerRef?.id);
    expect(newEntry).toBeDefined();
    expect(newEntry?.time).toBe("now");
    // Stale entry removed
    expect(ats.find((j) => j.id === staleAtId)).toBeUndefined();
  });

  it("reschedules overdue at-message that has no scheduler_ref at all", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const messageId = await insertPendingScheduled({
      executeAt: pastIso,
      schedulerRef: null,
    });

    await sweepStaleRuns(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.kind).toBe("at");
    const ats = await adapter.listAt();
    expect(ats.find((j) => j.id === msg?.schedulerRef?.id)?.time).toBe("now");
  });

  it("preserves pending messages whose ref still exists and isn't overdue", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const atId = await adapter.scheduleAt("irrelevant cmd", "now + 1 hour");
    const messageId = await insertPendingScheduled({
      executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      schedulerRef: { kind: "at", id: atId },
    });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.id).toBe(atId);
  });

  it("removes orphan at entries not referenced by any pending message (boot reconcile only)", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    await adapter.scheduleAt("orphan-command", "now + 1 hour");
    expect((await adapter.listAt()).length).toBeGreaterThanOrEqual(1);

    await reconcile(pool, adapter);

    expect((await adapter.listAt()).length).toBe(0);
  });

  it("sweepStaleRuns does NOT garbage-collect orphans (leaves them for the next reconcile)", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const orphanId = await adapter.scheduleAt("orphan-command", "now + 1 hour");

    await sweepStaleRuns(pool, adapter);

    const ats = await adapter.listAt();
    expect(ats.find((j) => j.id === orphanId)).toBeDefined();
  });

  it("is idempotent", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    await reconcile(pool, adapter);
    await reconcile(pool, adapter); // should not throw
    await sweepStaleRuns(pool, adapter);
    await sweepStaleRuns(pool, adapter);
  });
});
