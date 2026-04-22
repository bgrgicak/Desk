/**
 * End-to-end test for POST /internal/runs/fire.
 *
 * Covers:
 *   - Loopback + shared-secret auth succeeds
 *   - Missing token → 401
 *   - Wrong token → 401
 *   - Fire with a real scheduled_jobs row enqueues a run that reaches terminal state
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { resetInternalTokenCache } from "../src/auth/internal.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_internal_fire_${workerId}`;

function adminConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let workspaceId: string;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "internal-fire-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-internal-fire-"));
  await ensureLayout(home);

  // Internal token lives in this test's temp dir
  const tokenPath = path.join(home, "internal-token");
  token = "abcdefghijklmnopqrstuvwxyz012345";
  await fs.writeFile(tokenPath, token, { mode: 0o600 });
  process.env.DESK_INTERNAL_TOKEN_PATH = tokenPath;
  resetInternalTokenCache();

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async (runId, _a, _p, onLog) => {
      onLog({ runId, seq: 0, kind: "stdout", payload: "fake" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  workspaceId = wsRows[0].id as string;

  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  clearSessions();
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  resetInternalTokenCache();
  delete process.env.DESK_INTERNAL_TOKEN_PATH;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

function postInternal(path: string, body: unknown, bearer: string | null): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    const payload = JSON.stringify(body);
    headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function insertJob(): Promise<string> {
  const jobId = generateId("scheduledJob");
  await pool.query(
    `INSERT INTO scheduled_jobs (id, chat_id, kind, spec, at_job_id, active)
     VALUES ($1, NULL, 'once', $2, 'memadp_1', true)`,
    [jobId, JSON.stringify({ type: "once", onceAt: "2099-01-01 00:00:00" })],
  );
  return jobId;
}

describe("POST /internal/runs/fire", () => {
  it("rejects requests with no Authorization header (401)", async () => {
    const res = await postInternal("/internal/runs/fire", { jobId: "x" }, null);
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token (401)", async () => {
    const res = await postInternal("/internal/runs/fire", { jobId: "x" }, "not-the-right-token-oooooooooooo");
    expect(res.status).toBe(401);
  });

  it("accepts a valid token + known jobId, enqueuing a run that reaches terminal state", async () => {
    const jobId = await insertJob();

    const res = await postInternal("/internal/runs/fire", { jobId }, token);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; runId?: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toBeDefined();

    // Poll until the run reaches a terminal state.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const { rows } = await pool.query(
        "SELECT state FROM runs WHERE id = $1",
        [body.runId],
      );
      if (rows.length && ["succeeded", "failed", "cancelled"].includes(rows[0].state)) {
        expect(rows[0].state).toBe("succeeded");
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Run did not reach terminal state within 5s");
  });

  it("is a no-op when the job is inactive (no new run, 200)", async () => {
    const jobId = await insertJob();
    await pool.query("UPDATE scheduled_jobs SET active = false WHERE id = $1", [jobId]);

    const { rows: before } = await pool.query("SELECT count(*)::int AS c FROM runs WHERE scheduled_job_id = $1", [jobId]);
    const res = await postInternal("/internal/runs/fire", { jobId }, token);
    expect(res.status).toBe(200);
    expect((res.body as { runId?: string }).runId).toBe("");

    const { rows: after } = await pool.query("SELECT count(*)::int AS c FROM runs WHERE scheduled_job_id = $1", [jobId]);
    expect(after[0].c).toBe(before[0].c);
  });

  it("returns 400 when jobId is missing", async () => {
    const res = await postInternal("/internal/runs/fire", {}, token);
    expect(res.status).toBe(400);
  });
});
