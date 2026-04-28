import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@desk/db";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import { reconcile, sweepStaleRuns } from "../src/reconcile.js";
import { createMemoryAdapter } from "../src/scheduleAdapter.js";

let pool: Pool;
let chatId: string;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-reconcile-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Reconcile Test Chat"],
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

interface ScheduledRow {
  executeAt?: string;     // ISO — future default
  cron?: string;
  schedulerRef: { kind: "at" | "cron"; id: string } | null;
}

async function insertPendingScheduled(row: ScheduledRow): Promise<string> {
  const id = generateId("message");
  // SQLite is dynamically typed — execute_at and scheduler_ref are
  // declared TEXT, so we just pass the ISO string and JSON text through
  // the standard `?` binding instead of inlining type-cast expressions.
  const executeAt = row.cron
    ? null
    : row.executeAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const ref = row.schedulerRef ? JSON.stringify(row.schedulerRef) : null;
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state, execute_at, cron, scheduler_ref)
     VALUES (?, ?, 'system', ?, 'pending', ?, ?, ?)`,
    [
      id,
      chatId,
      JSON.stringify({ type: "text", text: "scheduled thing" }),
      executeAt,
      row.cron ?? null,
      ref,
    ],
  );
  return id;
}

async function clearPending(): Promise<void> {
  await pool.query("DELETE FROM messages WHERE chat_id = ? AND state = 'pending'", [chatId]);
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
