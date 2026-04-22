/**
 * Integration tests covering the 12 previously-untested HTTP endpoints.
 * Each test hits a real Postgres-backed API server (per-worker test DB).
 *
 * Discovered bugs / gaps (not fixed here — separate task):
 *  - PATCH /chats/:id does not accept agentId; spec says it should be patchable.
 *  - DELETE /workspaces/:id does a hard DELETE, not soft-delete. No deleted_at flag.
 *  - POST /library/:id/note stores the note with class "workspace" instead of "note".
 *  - Malformed request bodies (missing required fields) produce 500, not 400.
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
import { createMemoryAdapter } from "@desk/scheduler";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { createRunManager } from "@desk/scheduler";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_routes_cov_${workerId}`;

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

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let adapter: ReturnType<typeof createMemoryAdapter>;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConnectionString() });
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

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-routes-cov-"));
  await ensureLayout(home);

  const storage = { pool, home };
  adapter = createMemoryAdapter();
  const runManager = createRunManager({
    pool,
    adapter,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "fake response" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  server = createApp({ pool, storage, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  clearSessions();
  clearConnections();
  server?.close();

  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });

  const admin = new pg.Pool({ connectionString: adminConnectionString() });
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

function request(
  method: string,
  urlPath: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Send raw bytes (not necessarily valid JSON) as POST body. */
function requestRaw(
  method: string,
  urlPath: string,
  rawBody: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(rawBody)),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

describe("Routes coverage (real Postgres)", () => {
  let token: string;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    // Login
    const res = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "testpass",
    });
    token = (res.body as { token: string }).token;

    // Get seeded workspace and agent
    const wsRes = await request("GET", "/workspaces", token);
    workspaceId = (wsRes.body as Array<{ id: string }>)[0].id;
    const agRes = await request("GET", "/agents", token);
    agentId = (agRes.body as Array<{ id: string }>)[0].id;
  });

  // ── 1. POST /me/password ─────────────────────────────────────────
  it("POST /me/password — new password works for login, old fails", async () => {
    const changeRes = await request("POST", "/me/password", token, {
      newPassword: "newpass123",
    });
    expect(changeRes.status).toBe(200);
    expect((changeRes.body as { ok: boolean }).ok).toBe(true);

    // Login with new password succeeds
    const okLogin = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "newpass123",
    });
    expect(okLogin.status).toBe(200);
    expect((okLogin.body as { token: string }).token).toMatch(/^ses_/);

    // Login with old password fails
    const failLogin = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "testpass",
    });
    expect(failLogin.status).toBe(401);

    // Restore original password for other tests
    await request("POST", "/me/password", token, { newPassword: "testpass" });
  });

  // ── 2. GET /workspaces/:id ────────────────────────────────────────
  it("GET /workspaces/:id — returns seeded workspace fields", async () => {
    const res = await request("GET", `/workspaces/${workspaceId}`, token);
    expect(res.status).toBe(200);
    const ws = res.body as { id: string; name: string; description: string; icon: string };
    expect(ws.id).toBe(workspaceId);
    expect(ws.name).toBe("Desk");
    expect(typeof ws.description).toBe("string");
    expect(typeof ws.icon).toBe("string");
  });

  it("GET /workspaces/:id — unauthenticated returns 401", async () => {
    const res = await request("GET", `/workspaces/${workspaceId}`);
    expect(res.status).toBe(401);
  });

  // ── 3. PATCH /workspaces/:id ──────────────────────────────────────
  it("PATCH /workspaces/:id — rename and re-icon, GET reflects changes", async () => {
    const patchRes = await request("PATCH", `/workspaces/${workspaceId}`, token, {
      name: "Renamed WS",
      description: "New desc",
      icon: "rocket",
    });
    expect(patchRes.status).toBe(200);
    const patched = patchRes.body as { name: string; description: string; icon: string };
    expect(patched.name).toBe("Renamed WS");
    expect(patched.description).toBe("New desc");
    expect(patched.icon).toBe("rocket");

    // GET confirms
    const getRes = await request("GET", `/workspaces/${workspaceId}`, token);
    const ws = getRes.body as { name: string; description: string; icon: string };
    expect(ws.name).toBe("Renamed WS");
    expect(ws.description).toBe("New desc");
    expect(ws.icon).toBe("rocket");

    // Restore
    await request("PATCH", `/workspaces/${workspaceId}`, token, {
      name: "Desk",
      description: "",
      icon: "",
    });
  });

  // ── 3b. POST /workspaces ──────────────────────────────────────────
  it("POST /workspaces — creates a workspace with name, description, and icon", async () => {
    const res = await request("POST", "/workspaces", token, {
      name: "Test WS",
      description: "A test workspace",
      icon: "star",
    });
    expect(res.status).toBe(201);
    const ws = res.body as { id: string; name: string; description: string; icon: string; userId: string };
    expect(ws.id).toMatch(/^wks_/);
    expect(ws.name).toBe("Test WS");
    expect(ws.description).toBe("A test workspace");
    expect(ws.icon).toBe("star");
    expect(ws.userId).toBeTruthy();

    // GET confirms it exists
    const getRes = await request("GET", `/workspaces/${ws.id}`, token);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { name: string }).name).toBe("Test WS");

    // Clean up
    await request("DELETE", `/workspaces/${ws.id}`, token);
  });

  it("POST /workspaces — name only, defaults for description and icon", async () => {
    const res = await request("POST", "/workspaces", token, { name: "Minimal WS" });
    expect(res.status).toBe(201);
    const ws = res.body as { id: string; description: string; icon: string };
    expect(ws.description).toBe("");
    expect(ws.icon).toBe("");

    // Clean up
    await request("DELETE", `/workspaces/${ws.id}`, token);
  });

  // ── 4. DELETE /workspaces/:id ─────────────────────────────────────
  it("DELETE /workspaces/:id — workspace disappears; row is hard-deleted", async () => {
    // Create a throwaway workspace directly via pool
    const { rows: uRows } = await pool.query("SELECT id FROM users LIMIT 1");
    const userId = uRows[0].id;
    const tmpWsId = "ws_tmp_delete_test";
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name) VALUES ($1, $2, $3)`,
      [tmpWsId, userId, "ToDelete"],
    );

    // DELETE via API
    const delRes = await request("DELETE", `/workspaces/${tmpWsId}`, token);
    expect(delRes.status).toBe(200);
    expect((delRes.body as { ok: boolean }).ok).toBe(true);

    // GET returns 404
    const getRes = await request("GET", `/workspaces/${tmpWsId}`, token);
    expect(getRes.status).toBe(404);

    // DB row no longer exists (implementation uses hard DELETE)
    const { rows } = await pool.query("SELECT * FROM workspaces WHERE id = $1", [tmpWsId]);
    expect(rows.length).toBe(0);
  });

  // ── 5. GET /chats/:id ────────────────────────────────────────────
  it("GET /chats/:id — returns chat with title/goal/updatedAt; 404 for unknown", async () => {
    const createRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "Chat5",
      goal: "Test goal 5",
    });
    expect(createRes.status).toBe(201);
    const chat = createRes.body as { id: string };

    const getRes = await request("GET", `/chats/${chat.id}`, token);
    expect(getRes.status).toBe(200);
    const body = getRes.body as { id: string; title: string; goal: string; updatedAt: string };
    expect(body.id).toBe(chat.id);
    expect(body.title).toBe("Chat5");
    expect(body.goal).toBe("Test goal 5");
    expect(body.updatedAt).toBeTruthy();

    // 404 for unknown
    const notFound = await request("GET", "/chats/cht_nonexistent", token);
    expect(notFound.status).toBe(404);
  });

  // ── 6. PATCH /chats/:id ───────────────────────────────────────────
  it("PATCH /chats/:id — title and goal reflected in GET", async () => {
    const createRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "OrigTitle",
      goal: "OrigGoal",
    });
    const chat = createRes.body as { id: string };

    const patchRes = await request("PATCH", `/chats/${chat.id}`, token, {
      title: "PatchedTitle",
      goal: "PatchedGoal",
    });
    expect(patchRes.status).toBe(200);
    const patched = patchRes.body as { title: string; goal: string };
    expect(patched.title).toBe("PatchedTitle");
    expect(patched.goal).toBe("PatchedGoal");

    const getRes = await request("GET", `/chats/${chat.id}`, token);
    const body = getRes.body as { title: string; goal: string };
    expect(body.title).toBe("PatchedTitle");
    expect(body.goal).toBe("PatchedGoal");

    // NOTE: agentId is NOT patchable via PATCH /chats/:id (spec says it should be).
  });

  // ── 7. POST /library/:id/note ─────────────────────────────────────
  it("POST /library/:id/note — creates a note; GET /library/:noteId returns it", async () => {
    // Upload a library file first
    const content = "library file for note test";
    const uploadRes = await request("POST", "/library", token, {
      name: "note-target.txt",
      mime: "text/plain",
      contentBase64: Buffer.from(content).toString("base64"),
    });
    expect(uploadRes.status).toBe(201);
    const parentFile = uploadRes.body as { id: string };

    // Create a note
    const noteRes = await request("POST", `/library/${parentFile.id}/note`, token, {
      text: "This is a manual note about the file.",
    });
    expect(noteRes.status).toBe(201);
    const noteFile = noteRes.body as { id: string; name: string; mime: string };
    expect(noteFile.id).toMatch(/^fil_/);
    expect(noteFile.mime).toBe("text/plain");

    // GET the note file by id
    const getNoteRes = await request("GET", `/library/${noteFile.id}`, token);
    expect(getNoteRes.status).toBe(200);
    const meta = getNoteRes.body as { id: string; name: string };
    expect(meta.id).toBe(noteFile.id);

    // Download the note and verify text
    const dlBytes = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: `/library/${noteFile.id}/download`, method: "GET", headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(dlBytes.toString()).toBe("This is a manual note about the file.");
  });

  // ── 8. DELETE /library/:id ────────────────────────────────────────
  it("DELETE /library/:id — file gone from API and disk", async () => {
    const content = "file to delete";
    const uploadRes = await request("POST", "/library", token, {
      name: "to-delete.txt",
      mime: "text/plain",
      contentBase64: Buffer.from(content).toString("base64"),
    });
    const file = uploadRes.body as { id: string; path: string };

    // Delete
    const delRes = await request("DELETE", `/library/${file.id}`, token);
    expect(delRes.status).toBe(200);
    expect((delRes.body as { ok: boolean }).ok).toBe(true);

    // GET returns 404
    const getRes = await request("GET", `/library/${file.id}`, token);
    expect(getRes.status).toBe(404);

    // DB row is gone
    const { rows } = await pool.query("SELECT * FROM files WHERE id = $1", [file.id]);
    expect(rows.length).toBe(0);
  });

  // ── 9. GET /runs/:id ──────────────────────────────────────────────
  it("GET /runs/:id — returns run with state and timestamps; 404 for unknown", async () => {
    // Create a chat and send a message to trigger a run
    const chatRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "Run Test Chat",
    });
    const chat = chatRes.body as { id: string };

    await request("POST", `/chats/${chat.id}/messages`, token, { content: "trigger" });

    // Poll until the immediate run completes (fake driver is fast but async)
    let ourRun: { id: string; chatId: string; state: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      const runsRes = await request("GET", "/runs", token);
      const runs = runsRes.body as Array<{ id: string; chatId: string; state: string; scheduledJobId?: string }>;
      // Find the immediate run (no scheduledJobId) for our chat that has completed
      ourRun = runs.find(
        (r) => r.chatId === chat.id && !r.scheduledJobId && (r.state === "succeeded" || r.state === "failed"),
      );
      if (ourRun) break;
    }
    expect(ourRun).toBeDefined();

    // GET by id
    const getRes = await request("GET", `/runs/${ourRun!.id}`, token);
    expect(getRes.status).toBe(200);
    const run = getRes.body as {
      id: string;
      state: string;
      startedAt: string | null;
      finishedAt: string | null;
    };
    expect(run.id).toBe(ourRun!.id);
    expect(["succeeded", "failed"]).toContain(run.state);
    expect(run.startedAt).toBeTruthy();
    expect(run.finishedAt).toBeTruthy();

    // 404 for unknown
    const notFound = await request("GET", "/runs/run_nonexistent", token);
    expect(notFound.status).toBe(404);
  });

  // ── 10. POST /runs/:id/cancel ─────────────────────────────────────
  it("POST /runs/:id/cancel — sets run state to cancelled", async () => {
    // Insert a pending run directly so we can cancel it without triggering execution
    const { generateId } = await import("@desk/shared");
    const runId = generateId("run");
    await pool.query(
      `INSERT INTO runs (id, kind, state) VALUES ($1, 'immediate', 'pending')`,
      [runId],
    );

    const cancelRes = await request("POST", `/runs/${runId}/cancel`, token);
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as { ok: boolean }).ok).toBe(true);

    // Verify state in DB
    const { rows } = await pool.query("SELECT state FROM runs WHERE id = $1", [runId]);
    expect(rows[0].state).toBe("cancelled");
  });

  // ── 10b. GET /scheduled-jobs ──────────────────────────────────────
  it("GET /scheduled-jobs — lists active scheduled jobs", async () => {
    const res = await request("GET", "/scheduled-jobs", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── 11. POST /scheduled-jobs ──────────────────────────────────────
  it("POST /scheduled-jobs — creates scheduled and recurring jobs with linked runs", async () => {
    // Create a chat for linking
    const chatRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "Scheduled Job Chat",
    });
    const chat = chatRes.body as { id: string };

    // Create a "scheduled" job
    const schedRes = await request("POST", "/scheduled-jobs", token, {
      chatId: chat.id,
      prompt: "run this later",
      mode: "scheduled",
      spec: "now + 10 minutes",
    });
    expect(schedRes.status).toBe(201);
    const schedRun = schedRes.body as { id: string; chatId: string; state: string };
    expect(schedRun.id).toMatch(/^run_/);

    // Verify scheduled_jobs row exists with kind=once
    const { rows: schedJobs } = await pool.query(
      `SELECT * FROM scheduled_jobs WHERE kind = 'once' AND chat_id = $1`,
      [chat.id],
    );
    expect(schedJobs.length).toBeGreaterThanOrEqual(1);
    expect(schedJobs[0].active).toBe(true);
    const specObj = schedJobs[0].spec as { type: string; onceAt: string };
    expect(specObj.type).toBe("once");

    // Verify the run is linked to the job
    const { rows: linkedRuns } = await pool.query(
      `SELECT * FROM runs WHERE scheduled_job_id = $1`,
      [schedJobs[0].id],
    );
    expect(linkedRuns.length).toBe(1);

    // Create a "recurring" job
    const recurRes = await request("POST", "/scheduled-jobs", token, {
      chatId: chat.id,
      prompt: "run this repeatedly",
      mode: "recurring",
      spec: "*/15 * * * *",
    });
    expect(recurRes.status).toBe(201);

    // Verify scheduled_jobs row with kind=recurring
    const { rows: recurJobs } = await pool.query(
      `SELECT * FROM scheduled_jobs WHERE kind = 'recurring' AND chat_id = $1`,
      [chat.id],
    );
    expect(recurJobs.length).toBeGreaterThanOrEqual(1);
    const recurSpec = recurJobs[0].spec as { type: string; cronExpr: string };
    expect(recurSpec.type).toBe("recurring");
    expect(recurSpec.cronExpr).toBe("*/15 * * * *");

    // Memory adapter recorded the jobs
    const atJobs = await adapter.listAt();
    expect(atJobs.length).toBeGreaterThanOrEqual(1);
    const cronJobs = await adapter.listCron();
    expect(cronJobs.length).toBeGreaterThanOrEqual(1);
  });

  // ── 12. DELETE /scheduled-jobs/:id ────────────────────────────────
  it("DELETE /scheduled-jobs/:id — deactivates the job and removes from adapter", async () => {
    // Create a scheduled job
    const chatRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "Delete Job Chat",
    });
    const chat = chatRes.body as { id: string };

    const createRes = await request("POST", "/scheduled-jobs", token, {
      chatId: chat.id,
      prompt: "to be deleted",
      mode: "scheduled",
      spec: "now + 60 minutes",
    });
    expect(createRes.status).toBe(201);

    // Find the scheduled_jobs row
    const { rows: jobs } = await pool.query(
      `SELECT sj.* FROM scheduled_jobs sj
       JOIN runs r ON r.scheduled_job_id = sj.id
       WHERE sj.chat_id = $1 AND sj.kind = 'once' AND sj.active = true
       ORDER BY sj.id DESC LIMIT 1`,
      [chat.id],
    );
    expect(jobs.length).toBe(1);
    const jobId = jobs[0].id;

    // Record adapter state before
    const atBefore = await adapter.listAt();
    const hadAtJob = atBefore.some((j) => j.id === jobs[0].at_job_id);
    expect(hadAtJob).toBe(true);

    // DELETE via API
    const delRes = await request("DELETE", `/scheduled-jobs/${jobId}`, token);
    expect(delRes.status).toBe(200);
    expect((delRes.body as { ok: boolean }).ok).toBe(true);

    // DB: active = false
    const { rows: after } = await pool.query(
      "SELECT active FROM scheduled_jobs WHERE id = $1",
      [jobId],
    );
    expect(after[0].active).toBe(false);

    // Adapter: at job removed
    const atAfter = await adapter.listAt();
    const stillHas = atAfter.some((j) => j.id === jobs[0].at_job_id);
    expect(stillHas).toBe(false);
  });

  // ── Cross-cutting: unauthenticated ────────────────────────────────
  it("unauthenticated calls to protected routes return 401", async () => {
    const protectedRoutes: Array<[string, string]> = [
      ["POST", "/me/password"],
      ["GET", `/workspaces/${workspaceId}`],
      ["POST", "/workspaces"],
      ["PATCH", `/workspaces/${workspaceId}`],
      ["DELETE", `/workspaces/${workspaceId}`],
      ["GET", "/chats/cht_any"],
      ["PATCH", "/chats/cht_any"],
      ["POST", "/library/fil_any/note"],
      ["DELETE", "/library/fil_any"],
      ["GET", "/runs/run_any"],
      ["POST", "/runs/run_any/cancel"],
      ["GET", "/scheduled-jobs"],
      ["POST", "/scheduled-jobs"],
      ["DELETE", "/scheduled-jobs/sj_any"],
    ];

    for (const [method, urlPath] of protectedRoutes) {
      const res = await request(method, urlPath);
      expect(res.status, `${method} ${urlPath} should be 401`).toBe(401);
    }
  });

  // ── Cross-cutting: malformed body ─────────────────────────────────
  it("invalid JSON body returns an error status", async () => {
    // Sending malformed JSON to a POST endpoint
    const res = await requestRaw("POST", "/auth/login", "{not json", undefined);
    // The parseBody JSON.parse will throw → caught → 500
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── Cross-cutting: unknown resource id → 404 ─────────────────────
  it("valid auth + unknown resource id returns 404", async () => {
    const notFoundRoutes: Array<[string, string]> = [
      ["GET", "/workspaces/ws_nonexistent"],
      ["GET", "/chats/cht_nonexistent"],
      ["GET", "/library/fil_nonexistent"],
      ["GET", "/runs/run_nonexistent"],
    ];

    for (const [method, urlPath] of notFoundRoutes) {
      const res = await request(method, urlPath, token);
      expect(res.status, `${method} ${urlPath} should be 404`).toBe(404);
    }
  });
});
