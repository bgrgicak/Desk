/**
 * Integration test: reconcile after a simulated process restart, against
 * the real at/crontab scheduler adapter. Gated on at + crontab being
 * installed.
 *
 * Under M6, scheduled work lives on the messages table (via
 * scheduler_ref), not on scheduled_jobs. This test exercises reconcile's
 * ability to:
 *   - deactivate pending messages whose scheduler_ref no longer exists
 *     in the system (e.g. crontab cleared externally)
 *   - garbage-collect at/cron entries not referenced by any pending
 *     message (orphans)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { createAdapter, type ScheduleAdapter } from "../../src/scheduleAdapter.js";
import { reconcile } from "../../src/reconcile.js";

const execFileAsync = promisify(execFile);

function atAvailable(): boolean {
  try { execFileSync("which", ["at"], { stdio: "ignore" }); return true; } catch { return false; }
}
function crontabAvailable(): boolean {
  try { execFileSync("which", ["crontab"], { stdio: "ignore" }); return true; } catch { return false; }
}

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
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}

function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

const bothAvailable = atAvailable() && crontabAvailable();

describe.skipIf(!bothAvailable)("reconcile after real process restart (messages-based)", () => {
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
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
       VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [wsRows[0].id, agentRows[0].id],
    );

    chatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
      [chatId, wsRows[0].id, agentRows[0].id, "Reconcile Restart Test Chat"],
    );

    await pool.end();
    process.env.DATABASE_URL = testUrl;
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

  it("reinstalls at-entry when scheduler_ref was lost; cleans orphan at entries", async () => {
    // --- Process A: create a pending message + matching at entry ---
    const poolA = new pg.Pool({ connectionString: testUrl });
    const adapterA = createAdapter();

    const atId = await adapterA.scheduleAt("echo desk-reconcile-test", "now + 59 minutes");
    const messageId = generateId("message");
    await poolA.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at, scheduler_ref)
       VALUES ($1, $2, 'system', $3, 'pending', now() + interval '59 minutes', $4)`,
      [
        messageId,
        chatId,
        JSON.stringify({ type: "text", text: "reconcile test" }),
        JSON.stringify({ kind: "at", id: atId }),
      ],
    );

    // Simulate restart — drop the pool.
    await poolA.end();

    // --- Process B: delete the at entry externally, then reconcile ---
    const poolB = new pg.Pool({ connectionString: testUrl });
    const adapterB = createAdapter();

    try { await adapterB.removeAt(atId); } catch { /* ok */ }

    await reconcile(poolB, adapterB);

    // Missing entry is repaired: message stays pending with a fresh ref,
    // and the new at-entry exists on the system.
    const msg = await queries.messages.findById(poolB, messageId);
    expect(msg?.state).toBe("pending");
    expect(msg?.schedulerRef?.kind).toBe("at");
    expect(msg?.schedulerRef?.id).not.toBe(atId);
    const ats = await adapterB.listAt();
    const reinstalled = ats.find((j) => j.id === msg?.schedulerRef?.id);
    expect(reinstalled).toBeDefined();
    // Clean up the reinstalled entry so it doesn't outlive the test.
    try { await adapterB.removeAt(msg!.schedulerRef!.id); } catch { /* ok */ }

    // --- Orphan cleanup: schedule an at entry that no message references ---
    const orphanAtId = await adapterB.scheduleAt("echo desk-orphan", "now + 60 minutes");
    await reconcile(poolB, adapterB);
    const atsAfter = await adapterB.listAt();
    expect(atsAfter.some((j) => j.id === orphanAtId)).toBe(false);

    await poolB.end();
  }, 60_000);
});
