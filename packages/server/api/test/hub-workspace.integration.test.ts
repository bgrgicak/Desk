/**
 * Integration tests for the per-user hub workspace.
 *
 * Covers:
 *   - the boot pass auto-creates a hub for every user (idempotent)
 *   - `GET /workspaces` sorts the hub first and exposes `kind`
 *   - the hub can't be deleted via the API
 *   - the hub can't be renamed via PATCH
 *   - users can't create or rename a workspace into a reserved `-hub` slug
 *   - the API rejects a client-supplied `kind` field
 *   - a fresh hub ships with one initial chat + one agent message
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { ensureHubsForAllUsers } from "../src/routes/workspaces.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let token: string;
let userId: string;
let userSlug: string;

function request(
  method: string,
  urlPath: string,
  t: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (t) headers.Authorization = `Bearer ${t}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-hub-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-hub-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  process.env.DESK_DAILY_REFLECTION = "off";

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  userId = generateId("user");
  userSlug = "hubuser";
  await queries.users.insert(pool, {
    id: userId,
    username: userSlug,
    passwordHash: await hashPassword("pw"),
    email: "hubuser@example.com",
  });
  // Mimic the server boot pass.
  await ensureHubsForAllUsers(pool, home);

  const login = await request("POST", "/auth/login", null, {
    username: userSlug,
    password: "pw",
  });
  token = (login.body as { token: string }).token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
  delete process.env.DESK_DAILY_REFLECTION;
});

describe("hub workspace boot pass", () => {
  it("creates a hub for every existing user", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    expect(hub).not.toBeNull();
    expect(hub!.kind).toBe("hub");
    expect(hub!.path).toBe(`${userSlug}-hub`);
  });

  it("is idempotent — a second boot pass does not create a duplicate", async () => {
    const before = await queries.workspaces.listByUser(pool, userId);
    await ensureHubsForAllUsers(pool, home);
    const after = await queries.workspaces.listByUser(pool, userId);
    expect(after.length).toBe(before.length);
    expect(after.filter((w) => w.kind === "hub")).toHaveLength(1);
  });

  it("seeds an initial chat with one agent message", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ?`,
      [hub!.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const messages = await queries.messages.listByChat(pool, rows[0].id, {});
    const visible = messages.items.filter((m) => m.kind !== "summary" && m.role === "agent");
    expect(visible.length).toBeGreaterThanOrEqual(1);
    expect(visible[0].content.type).toBe("text");
  });

  it("creates a hub for a freshly-inserted user when the boot pass runs", async () => {
    const newUserId = generateId("user");
    await queries.users.insert(pool, {
      id: newUserId,
      username: "freshuser",
      passwordHash: await hashPassword("pw"),
      email: "fresh@example.com",
    });
    expect(await queries.workspaces.findHubByUser(pool, newUserId)).toBeNull();
    await ensureHubsForAllUsers(pool, home);
    const hub = await queries.workspaces.findHubByUser(pool, newUserId);
    expect(hub).not.toBeNull();
    expect(hub!.path).toBe("freshuser-hub");
  });
});

describe("GET /workspaces", () => {
  it("sorts the hub first and exposes kind", async () => {
    // Create one project workspace; the hub should still appear first.
    const create = await request("POST", "/workspaces", token, {
      name: "Project Alpha",
    });
    expect(create.status).toBe(201);

    const list = await request("GET", "/workspaces", token);
    expect(list.status).toBe(200);
    const items = list.body as Array<{ id: string; kind: string; path: string }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0].kind).toBe("hub");
    expect(items[0].path).toBe(`${userSlug}-hub`);
    // Subsequent items must not be hubs.
    for (const w of items.slice(1)) {
      expect(w.kind).toBe("project");
    }
  });
});

describe("workspace CRUD guards", () => {
  it("rejects a client-supplied kind on POST /workspaces", async () => {
    const res = await request("POST", "/workspaces", token, {
      name: "trying to be a hub",
      kind: "hub",
    });
    expect(res.status).toBe(400);
  });

  it("rejects creation when the slug ends in a reserved suffix", async () => {
    const res = await request("POST", "/workspaces", token, {
      name: "Imposter Hub",
    });
    expect(res.status).toBe(400);
  });

  it("rejects renaming a project workspace into a reserved suffix", async () => {
    const create = await request("POST", "/workspaces", token, {
      name: "Reserved Rename Target",
    });
    expect(create.status).toBe(201);
    const wsId = (create.body as { id: string }).id;
    const rename = await request("PATCH", `/workspaces/${wsId}`, token, {
      name: "another-hub",
    });
    expect(rename.status).toBe(400);
  });

  it("rejects renaming the hub", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("PATCH", `/workspaces/${hub!.id}`, token, {
      name: "Renamed Hub",
    });
    expect(res.status).toBe(403);
  });

  it("rejects DELETE on the hub", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("DELETE", `/workspaces/${hub!.id}`, token);
    expect(res.status).toBe(403);
  });
});

describe("hub workspace — chats and library access", () => {
  it("GET /chats?workspaceId=<hub-id> returns the hub's chats (not 400)", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("GET", `/chats?workspaceId=${hub!.id}`, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The hub ships with one initial chat.
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("GET /library?workspaceId=<hub-id> returns the hub's library (not 400)", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("GET", `/library?workspaceId=${hub!.id}`, token);
    expect(res.status).toBe(200);
  });
});

describe("pins — hub capabilities", () => {
  let hubId: string;
  let projectId: string;

  beforeAll(async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    hubId = hub!.id;
    const create = await request("POST", "/workspaces", token, { name: "Pin Source" });
    projectId = (create.body as { id: string }).id;
  });

  it("GET /workspaces/{hub-id}/pins returns empty array initially", async () => {
    const res = await request("GET", `/workspaces/${hubId}/pins`, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /workspaces/{hub-id}/pins creates a pin from an owned workspace", async () => {
    const res = await request("POST", `/workspaces/${hubId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_fake123",
    });
    expect(res.status).toBe(201);
    const pin = res.body as { id: string; workspaceId: string; sourceWorkspaceId: string; kind: string; refId: string };
    expect(pin.workspaceId).toBe(hubId);
    expect(pin.sourceWorkspaceId).toBe(projectId);
    expect(pin.kind).toBe("chat");
    expect(pin.refId).toBe("cht_fake123");
  });

  it("POST /workspaces/{hub-id}/pins is idempotent on duplicate (same ref)", async () => {
    const first = await request("POST", `/workspaces/${hubId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_idempotent",
    });
    const second = await request("POST", `/workspaces/${hubId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_idempotent",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((first.body as { id: string }).id).toBe((second.body as { id: string }).id);
  });

  it("DELETE /workspaces/{hub-id}/pins/{pinId} removes a pin", async () => {
    const create = await request("POST", `/workspaces/${hubId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "artifact",
      refId: "art_todelete",
    });
    const pinId = (create.body as { id: string }).id;
    const del = await request("DELETE", `/workspaces/${hubId}/pins/${pinId}`, token);
    expect(del.status).toBe(200);
    const list = await request("GET", `/workspaces/${hubId}/pins`, token);
    const ids = (list.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(pinId);
  });
});

describe("pins — project workspaces cannot use hub-only pin endpoints", () => {
  let projectId: string;

  beforeAll(async () => {
    const create = await request("POST", "/workspaces", token, { name: "No Pins Here" });
    projectId = (create.body as { id: string }).id;
  });

  it("GET /workspaces/{project-id}/pins returns 403", async () => {
    const res = await request("GET", `/workspaces/${projectId}/pins`, token);
    expect(res.status).toBe(403);
  });

  it("POST /workspaces/{project-id}/pins returns 403", async () => {
    const res = await request("POST", `/workspaces/${projectId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_shouldfail",
    });
    expect(res.status).toBe(403);
  });
});
