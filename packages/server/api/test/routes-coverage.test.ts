/**
 * Integration tests covering the 12 previously-untested HTTP endpoints.
 * Each test hits a real Postgres-backed API server (per-worker test DB).
 *
 * Discovered bugs / gaps (not fixed here — separate task):
 *  - PATCH /chats/:id does not accept agentId; spec says it should be patchable.
 *  - DELETE /workspaces/:id does a hard DELETE, not soft-delete. No deleted_at flag.
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

  // Encryption key for user_settings.provider_keys_encrypted
  process.env.DESK_SECRET_KEY_PATH = path.join(home, "secret.key");

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

function requestMultipart(
  method: string,
  urlPath: string,
  token: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer }>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const boundary = `----desk-rc-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const header = [`--${boundary}`];
      const disposition = p.filename
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`
        : `Content-Disposition: form-data; name="${p.name}"`;
      header.push(disposition);
      if (p.contentType) header.push(`Content-Type: ${p.contentType}`);
      header.push("", "");
      chunks.push(Buffer.from(header.join("\r\n")));
      chunks.push(p.body);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(chunks);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(payload.length),
      Authorization: `Bearer ${token}`,
    };

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const bufs: Buffer[] = [];
        res.on("data", (c: Buffer) => bufs.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(bufs).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
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
      currentPassword: "testpass",
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
    await request("POST", "/me/password", token, {
      currentPassword: "newpass123",
      newPassword: "testpass",
    });
  });

  it("POST /me/password — wrong current password returns 401 and does not change", async () => {
    const badRes = await request("POST", "/me/password", token, {
      currentPassword: "not-the-right-password",
      newPassword: "should-not-apply",
    });
    expect(badRes.status).toBe(401);

    // Login with original password still works
    const okLogin = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "testpass",
    });
    expect(okLogin.status).toBe(200);
  });

  // ── 1b. /me/providers ─────────────────────────────────────────────
  it("GET /me/providers — returns every known key masked-or-null", async () => {
    const res = await request("GET", "/me/providers", token);
    expect(res.status).toBe(200);
    const body = res.body as { providers: Record<string, string | null> };
    expect(typeof body.providers).toBe("object");
    // Every PROVIDER_KEY_VARS entry must appear; exact names checked below.
    expect(body.providers).toHaveProperty("ANTHROPIC_API_KEY");
    expect(body.providers).toHaveProperty("OPENAI_API_KEY");
    expect(body.providers).toHaveProperty("AWS_REGION");
  });

  it("PUT /me/providers — sets, updates, masks, deletes a key", async () => {
    // Set
    const setRes = await request("PUT", "/me/providers", token, {
      providers: { ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop" },
    });
    expect(setRes.status).toBe(200);
    const setBody = setRes.body as { providers: Record<string, string | null> };
    expect(setBody.providers.ANTHROPIC_API_KEY).not.toBeNull();
    // Masking: full value must not appear verbatim
    expect(setBody.providers.ANTHROPIC_API_KEY).not.toBe("sk-ant-abcdefghijklmnop");
    expect(setBody.providers.ANTHROPIC_API_KEY).toContain("...");

    // Partial update leaves other keys alone
    const updateRes = await request("PUT", "/me/providers", token, {
      providers: { OPENAI_API_KEY: "sk-openai-0987654321" },
    });
    expect(updateRes.status).toBe(200);
    const updateBody = updateRes.body as { providers: Record<string, string | null> };
    expect(updateBody.providers.ANTHROPIC_API_KEY).not.toBeNull();
    expect(updateBody.providers.OPENAI_API_KEY).not.toBeNull();

    // Delete via null
    const delRes = await request("PUT", "/me/providers", token, {
      providers: { ANTHROPIC_API_KEY: null },
    });
    expect(delRes.status).toBe(200);
    const delBody = delRes.body as { providers: Record<string, string | null> };
    expect(delBody.providers.ANTHROPIC_API_KEY).toBeNull();
    expect(delBody.providers.OPENAI_API_KEY).not.toBeNull();

    // Clean up
    await request("PUT", "/me/providers", token, {
      providers: { OPENAI_API_KEY: null },
    });
  });

  it("PUT /me/providers — rejects unknown key names", async () => {
    const res = await request("PUT", "/me/providers", token, {
      providers: { BOGUS_KEY: "x" },
    });
    expect(res.status).toBe(400);
  });

  // ── 1c. Workspace agents ──────────────────────────────────────────
  it("GET /workspaces/:id/agents — returns the seeded agent", async () => {
    const res = await request("GET", `/workspaces/${workspaceId}/agents`, token);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((a) => a.id === agentId)).toBe(true);
  });

  it("POST /agents + POST /workspaces/:id/agents — enrolls a new agent", async () => {
    const createRes = await request("POST", "/agents", token, {
      name: "Sidekick",
      instructions: "Assist",
      model: "anthropic/claude-opus-4-7",
    });
    expect(createRes.status).toBe(201);
    const created = createRes.body as { id: string };
    expect(created.id).toMatch(/^agt_/);

    const addRes = await request("POST", `/workspaces/${workspaceId}/agents`, token, {
      agentId: created.id,
    });
    expect(addRes.status).toBe(201);

    // Idempotent re-add is OK
    const addAgain = await request("POST", `/workspaces/${workspaceId}/agents`, token, {
      agentId: created.id,
    });
    expect(addAgain.status).toBe(201);

    const listRes = await request("GET", `/workspaces/${workspaceId}/agents`, token);
    const list = listRes.body as Array<{ id: string }>;
    expect(list.some((a) => a.id === created.id)).toBe(true);

    // Remove the newly-enrolled agent to restore state for downstream tests.
    const delRes = await request(
      "DELETE",
      `/workspaces/${workspaceId}/agents/${created.id}`,
      token,
    );
    expect(delRes.status).toBe(200);
  });

  it("POST /chats rejects an agent not in the workspace", async () => {
    // Create an agent but don't enroll it
    const createRes = await request("POST", "/agents", token, { name: "Outsider" });
    const outsider = (createRes.body as { id: string }).id;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId: outsider,
      title: "Bad chat",
    });
    expect(chatRes.status).toBe(400);
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
      `INSERT INTO workspaces (id, user_id, name, path) VALUES ($1, $2, $3, $4)`,
      [tmpWsId, userId, "ToDelete", `todelete-${tmpWsId.slice(-6)}`],
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
  });

  it("PATCH /chats/:id — agentId re-binds the chat when the new agent is enrolled", async () => {
    // Create a second agent and enroll it in the workspace.
    const createAgent = await request("POST", "/agents", token, {
      name: "Switcher",
      instructions: "Assist",
      model: "anthropic/claude-opus-4-7",
    });
    const otherAgentId = (createAgent.body as { id: string }).id;
    const enroll = await request("POST", `/workspaces/${workspaceId}/agents`, token, {
      agentId: otherAgentId,
    });
    expect(enroll.status).toBe(201);

    // Create a chat bound to the default agent.
    const createRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "BindOrig",
    });
    const chat = createRes.body as { id: string; agentId: string };
    expect(chat.agentId).toBe(agentId);

    // Re-bind to the other agent.
    const patchRes = await request("PATCH", `/chats/${chat.id}`, token, {
      agentId: otherAgentId,
    });
    expect(patchRes.status).toBe(200);
    expect((patchRes.body as { agentId: string }).agentId).toBe(otherAgentId);

    const getRes = await request("GET", `/chats/${chat.id}`, token);
    expect((getRes.body as { agentId: string }).agentId).toBe(otherAgentId);
  });

  it("PATCH /chats/:id — rejects an agent not enrolled in the chat's workspace", async () => {
    // Create an agent but skip the workspace enrollment step.
    const createAgent = await request("POST", "/agents", token, {
      name: "Stranger",
      instructions: "",
      model: "anthropic/claude-opus-4-7",
    });
    const strangerId = (createAgent.body as { id: string }).id;

    const createRes = await request("POST", "/chats", token, {
      workspaceId,
      agentId,
      title: "BindReject",
    });
    const chat = createRes.body as { id: string };

    const patchRes = await request("PATCH", `/chats/${chat.id}`, token, {
      agentId: strangerId,
    });
    expect(patchRes.status).toBe(400);
  });

  // ── 7. DELETE /library + multipart upload ────────────────────────
  it("DELETE /library?path=... — file moves to trash and stops resolving", async () => {
    const content = "file to delete";
    const uploadRes = await requestMultipart(
      "POST",
      "/library",
      token,
      [{ name: "file", filename: "to-delete.txt", contentType: "text/plain", body: Buffer.from(content) }],
    );
    const file = uploadRes.body as { path: string; name: string };
    expect(file.path).toBe(file.name);

    // Delete moves the file to the trash.
    const delRes = await request(
      "DELETE",
      `/library?path=${encodeURIComponent(file.path)}`,
      token,
    );
    expect(delRes.status).toBe(200);
    expect((delRes.body as { ok: boolean }).ok).toBe(true);

    // Subsequent stat through the API fails (file was moved to .trash).
    const statRes = await request(
      "GET",
      `/library/meta?path=${encodeURIComponent(file.path)}`,
      token,
    );
    expect(statRes.status).toBe(404);
  });

  // M6 replaced /runs and /scheduled-jobs with per-message endpoints.
  // See test/internal-messages-fire.integration.test.ts and the PATCH/
  // DELETE/logs coverage added there.

  // ── 13. GET /tools/models ─────────────────────────────────────────
  it("GET /tools/models — returns a bare array of { id, provider }", async () => {
    const res = await request("GET", "/tools/models", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    // Fake sandbox driver always returns free opencode models (no key required).
    expect(body.some((m) => m.provider === "opencode")).toBe(true);
    for (const m of body) {
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
      // No leftover fields from the old response shape.
      expect(m).not.toHaveProperty("providerId");
      expect(m).not.toHaveProperty("modelId");
      expect(m).not.toHaveProperty("fullId");
    }
  });

  it("GET /tools/models?provider=opencode — filters to provider", async () => {
    const res = await request("GET", "/tools/models?provider=opencode", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((m) => m.provider === "opencode")).toBe(true);
  });

  it("GET /tools/models?provider=bad..id — rejects malformed provider", async () => {
    const res = await request("GET", "/tools/models?provider=bad$id", token);
    expect(res.status).toBe(400);
  });

  // ── Cross-cutting: unauthenticated ────────────────────────────────
  it("unauthenticated calls to protected routes return 401", async () => {
    const protectedRoutes: Array<[string, string]> = [
      ["POST", "/me/password"],
      ["GET", "/me/providers"],
      ["PUT", "/me/providers"],
      ["GET", `/workspaces/${workspaceId}`],
      ["POST", "/workspaces"],
      ["PATCH", `/workspaces/${workspaceId}`],
      ["DELETE", `/workspaces/${workspaceId}`],
      ["GET", "/chats/cht_any"],
      ["PATCH", "/chats/cht_any"],
      ["DELETE", "/library?path=whatever"],
      ["GET", "/tools/models"],
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
      ["GET", "/library/meta?path=does-not-exist"],
      ["GET", "/runs/run_nonexistent"],
    ];

    for (const [method, urlPath] of notFoundRoutes) {
      const res = await request(method, urlPath, token);
      expect(res.status, `${method} ${urlPath} should be 404`).toBe(404);
    }
  });
});
