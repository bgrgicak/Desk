/**
 * Integration tests for `DELETE /workspaces/:id` focused on the "at least
 * one workspace" invariant. The happy-path cascade is already covered by
 * chat-delete.integration.test.ts and routes-coverage.test.ts; this file
 * exists specifically to pin the guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { runMigrations, queries, hashPassword } from "@roomy-ai/db";
import { ensureLayout, ensureWorkspaceLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let token: string;
let userId: string;

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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-ws-delete-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-ws-delete-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "ws-delete-user",
    passwordHash: await hashPassword("pw"),
    email: "wsd@example.com",
  });
  const login = await request("POST", "/auth/login", null, {
    username: "ws-delete-user",
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
  delete process.env.ROOMY_HOME;
});

async function insertWorkspace(name: string): Promise<{ id: string; slug: string }> {
  const id = generateId("workspace");
  const slug = await queries.workspaces.reserveWorkspacePath(pool, name);
  await ensureWorkspaceLayout(home, slug);
  await queries.workspaces.insert(pool, {
    id,
    userId,
    name,
    path: slug,
    description: "",
    icon: "",
  });
  return { id, slug };
}

describe("DELETE /workspaces/:id — last-workspace guard", () => {
  it("refuses to delete the user's only workspace with 400", async () => {
    const { id: onlyId, slug: onlySlug } = await insertWorkspace("only");

    const res = await request("DELETE", `/workspaces/${onlyId}`, token);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION" });

    // Row still present and on-disk directory untouched.
    const rows = await pool.query("SELECT id FROM workspaces WHERE id = ?", [onlyId]);
    expect(rows.rowCount).toBe(1);
    const dirStat = await fs.stat(path.join(home, onlySlug));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("allows deletion once a sibling workspace exists and moves its dir to trash", async () => {
    const { id: siblingId, slug: siblingSlug } = await insertWorkspace("sibling");

    // "only" is still there from the previous test; now there are 2.
    const listRes = await request("GET", "/workspaces", token);
    const names = (listRes.body as Array<{ name: string }>).map(w => w.name);
    expect(names).toEqual(expect.arrayContaining(["only", "sibling"]));

    const siblingDir = path.join(home, siblingSlug);
    expect((await fs.stat(siblingDir)).isDirectory()).toBe(true);

    const delRes = await request("DELETE", `/workspaces/${siblingId}`, token);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true });

    // FS dir for the deleted workspace is gone from ~/Roomy/
    // and present under ~/Roomy/.trash/workspaces/ with a timestamped suffix.
    await expect(fs.stat(siblingDir)).rejects.toMatchObject({ code: "ENOENT" });
    const trashEntries = await fs.readdir(path.join(home, ".trash", "workspaces"));
    expect(trashEntries.some(name => name.startsWith(`${siblingSlug}-`))).toBe(true);

    // Back to exactly one workspace — deleting that one must again be refused.
    const onlyId = (listRes.body as Array<{ id: string; name: string }>)
      .find(w => w.name === "only")!.id;
    const finalDel = await request("DELETE", `/workspaces/${onlyId}`, token);
    expect(finalDel.status).toBe(400);
  });
});
