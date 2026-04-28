/**
 * Integration test for the real at/crontab schedule adapter.
 * Auto-detected — skipped when `at` and `crontab` are unavailable.
 * Gap 7: Real `at` scheduled run end-to-end.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "@desk/db";
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

  let pool: Pool;
  let chatId: string;
  let dbPath: string;

  beforeAll(async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-real-at-db-"));
    dbPath = path.join(dbDir, "test.sqlite3");
    pool = new Pool({ path: dbPath });

    await runMigrations(pool);
    process.env.DESK_SEED_USERNAME = "testuser";
    process.env.DESK_SEED_PASSWORD = "testpass";
    await seedIfEmpty(pool);

    const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
    const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [wsRows[0].id, agentRows[0].id],
    );

    chatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [chatId, wsRows[0].id, agentRows[0].id, "Real At Test Chat"],
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
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
       WHERE chat_id = ? AND state = 'pending' AND json_extract(content, '$.type') = 'ai_note_request'`,
      [chatId],
    );
    expect(rows.length).toBe(1);
    const messageId = rows[0].id as string;
    // SQLite returns JSON columns as TEXT; parse before reading.
    const raw = rows[0].scheduler_ref;
    const ref = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      kind: "at";
      id: string;
    };
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
