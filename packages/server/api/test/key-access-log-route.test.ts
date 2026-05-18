import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";

let pool: Pool;
let home: string;
let userId: string;
let otherUserId: string;
let dbPath: string;
let server: http.Server;
let token: string;

function appOpts(): AppOptions {
  return {
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
  };
}

function request(method: string, reqPath: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
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
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-key-log-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-key-log-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "key-log-test",
    passwordHash: "$2b$10$placeholder",
    email: "key-log@example.com",
  });
  otherUserId = generateId("user");
  await queries.users.insert(pool, {
    id: otherUserId,
    username: "key-log-other",
    passwordHash: "$2b$10$placeholder",
    email: "other@example.com",
  });

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

beforeEach(async () => {
  await pool.query("DELETE FROM provider_key_access_log", []);
  await clearSessions(pool);
  token = await issueSession(pool, userId);
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("GET /me/key-access-log", () => {
  it("requires authentication", async () => {
    const res = await request("GET", "/me/key-access-log");
    expect(res.status).toBe(401);
  });

  it("returns empty entries when the user has no log rows", async () => {
    const res = await request("GET", "/me/key-access-log", token);
    expect(res.status).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toEqual([]);
  });

  it("returns the user's own entries newest first with ISO timestamps", async () => {
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "write", ["OPENAI_API_KEY"], "user_update");
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], "sandbox_run:msg_1");

    const res = await request("GET", "/me/key-access-log", token);
    expect(res.status).toBe(200);
    const entries = (res.body as { entries: Array<{ action: string; providers: string[]; reason: string | null; createdAt: string }> }).entries;
    expect(entries).toHaveLength(2);
    // Newest first
    expect(entries[0].action).toBe("read");
    expect(entries[0].providers).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(entries[0].reason).toBe("sandbox_run:msg_1");
    expect(entries[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[1].action).toBe("write");
  });

  it("scopes to the calling user — never returns another user's entries", async () => {
    await queries.providerKeyAccessLog.logKeyAccess(pool, otherUserId, "read", ["LEAKED"], "other_user");
    const res = await request("GET", "/me/key-access-log", token);
    expect(res.status).toBe(200);
    const entries = (res.body as { entries: unknown[] }).entries;
    expect(entries).toEqual([]);
  });

  it("rejects out-of-range limit", async () => {
    const tooSmall = await request("GET", "/me/key-access-log?limit=0", token);
    expect(tooSmall.status).toBe(400);
    const tooLarge = await request("GET", "/me/key-access-log?limit=10000", token);
    expect(tooLarge.status).toBe(400);
    const nonNumeric = await request("GET", "/me/key-access-log?limit=abc", token);
    expect(nonNumeric.status).toBe(400);
  });

  it("honours a valid limit", async () => {
    for (let i = 0; i < 5; i++) {
      await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["KEY_" + i], "sandbox_run");
    }
    const res = await request("GET", "/me/key-access-log?limit=2", token);
    expect(res.status).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toHaveLength(2);
  });
});
