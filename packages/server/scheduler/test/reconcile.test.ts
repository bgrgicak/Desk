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

async function insertPendingScheduledMessage(schedulerRef: { kind: "at" | "cron"; id: string }): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state, execute_at, scheduler_ref)
     VALUES ($1, $2, 'system', $3, 'pending', now() + interval '1 hour', $4)`,
    [id, chatId, JSON.stringify({ type: "text", text: "scheduled thing" }), JSON.stringify(schedulerRef)],
  );
  return id;
}

describe("reconcile", () => {
  async function clearPending(): Promise<void> {
    await pool.query("DELETE FROM messages WHERE chat_id = $1 AND state = 'pending'", [chatId]);
  }

  it("cancels pending messages whose at ref is missing from the system", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const messageId = await insertPendingScheduledMessage({ kind: "at", id: "nonexistent_at" });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("cancelled");
  });

  it("cancels pending messages whose cron ref is missing from the system", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const messageId = await insertPendingScheduledMessage({ kind: "cron", id: "nonexistent_cron" });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("cancelled");
  });

  it("preserves pending messages whose ref still exists in the system", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    const atId = await adapter.scheduleAt("irrelevant cmd", "now + 1 hour");
    const messageId = await insertPendingScheduledMessage({ kind: "at", id: atId });

    await reconcile(pool, adapter);

    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("pending");
  });

  it("removes orphan at entries not referenced by any pending message", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    await adapter.scheduleAt("orphan-command", "now + 1 hour");
    expect((await adapter.listAt()).length).toBeGreaterThanOrEqual(1);

    await reconcile(pool, adapter);

    expect((await adapter.listAt()).length).toBe(0);
  });

  it("is idempotent", async () => {
    const adapter = createMemoryAdapter();
    await clearPending();

    await reconcile(pool, adapter);
    await reconcile(pool, adapter); // should not throw
  });
});
