/**
 * Integration test for the cron-backed recurring-message scheduler path.
 * Uses the in-memory ScheduleAdapter (no real cron daemon needed) and
 * exercises fireMessage directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createRunManager } from "../../src/runs.js";
import { createMemoryAdapter } from "../../src/scheduleAdapter.js";
import type { LogEvent } from "@desk/runtime";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_sched_cron_${workerId}`;

let pool: pg.Pool;
let chatId: string;
let home: string;

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

  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  pool = new pg.Pool({ connectionString: url.toString() });
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
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Cron Test"],
  );

  home = (await import("node:fs/promises")).mkdtemp
    ? await (await import("node:fs/promises")).mkdtemp(
        (await import("node:path")).join((await import("node:os")).tmpdir(), "desk-cron-"),
      )
    : "/tmp/desk-cron";
  process.env.DESK_HOME = home;
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

describe("recurring cron scheduling via fireMessage", () => {
  it("repeated fireMessage calls simulate cron firing multiple times", async () => {
    let fireCount = 0;
    const mgr = createRunManager({
      pool,
      adapter: createMemoryAdapter(),
      execRunFn: async (messageId: string, _a, _p, onLog: (e: LogEvent) => void) => {
        fireCount++;
        onLog({ runId: messageId, seq: 0, kind: "stdout", payload: `fire ${fireCount}` });
        return { exitCode: 0 };
      },
    });

    // Two independent pending messages (simulating two cron firings).
    for (let i = 0; i < 2; i++) {
      const id = generateId("message");
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, state)
         VALUES ($1, $2, 'system', $3, 'pending')`,
        [id, chatId, JSON.stringify({ type: "text", text: `tick ${i}` })],
      );
      await mgr.fireMessage(id);
    }
    expect(fireCount).toBe(2);
  });

  it("cancelMessage removes a pending message's at entry", async () => {
    const adapter = createMemoryAdapter();
    const mgr = createRunManager({
      pool,
      adapter,
      execRunFn: async () => ({ exitCode: 0 }),
    });

    await mgr.scheduleAiNote(chatId);
    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE chat_id = $1 AND content->>'type' = 'ai_note_request' AND state = 'pending'`,
      [chatId],
    );
    const messageId = rows[0].id as string;

    const beforeAt = (await adapter.listAt()).length;
    await mgr.cancelMessage(messageId);
    const afterAt = (await adapter.listAt()).length;
    expect(afterAt).toBeLessThan(beforeAt);
    expect(await queries.messages.findById(pool, messageId)).toBeNull();
  });
});
