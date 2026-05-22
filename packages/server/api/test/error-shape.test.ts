import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { createApp, type AppOptions } from "../src/app.js";
import { queries } from "@roomy-ai/db";
import { generateId } from "@roomy-ai/shared";
import { issueSession, clearSessions } from "../src/auth/sessions.js";

let pool: Pool;
let home: string;
let dbPath: string;
let server: http.Server;

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

function request(method: string, reqPath: string, opts: { body?: unknown; token?: string } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
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
    if (payload) req.write(payload);
    req.end();
  });
}

let userId: string;

function assertHasErrorShape(body: unknown): void {
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
  const b = body as Record<string, unknown>;
  expect(typeof b.code).toBe("string");
  expect((b.code as string).length).toBeGreaterThan(0);
  expect(typeof b.message).toBe("string");
  expect((b.message as string).length).toBeGreaterThan(0);
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-err-shape-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-err-shape-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "err-shape-test",
    passwordHash: "$2b$10$placeholder",
    email: "err-shape@example.com",
  });

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

/**
 * Lock the contract that every error response from the API returns a
 * body shaped `{code, message, ...}`. Individual handlers are allowed
 * to extend with extra fields (e.g. /me/library 409 returns the
 * current content alongside) — the test only asserts the floor.
 *
 * If a new route emits a non-conforming error response the failing
 * case here points at it; either add the {code, message} pair or
 * route through a RoomyError subclass so the default dispatcher does it.
 */
describe("uniform error response shape", () => {
  it("401 on missing Authorization", async () => {
    const res = await request("GET", "/me");
    expect(res.status).toBe(401);
    assertHasErrorShape(res.body);
  });

  it("401 on invalid bearer token", async () => {
    const res = await request("GET", "/me", { token: "ses_definitely-not-real" });
    expect(res.status).toBe(401);
    assertHasErrorShape(res.body);
  });

  it("404 on unknown authed route", async () => {
    await clearSessions(pool);
    const token = await issueSession(pool, userId);
    const res = await request("GET", "/totally-fake-endpoint-that-doesnt-exist", { token });
    expect(res.status).toBe(404);
    assertHasErrorShape(res.body);
  });

  it("400 on invalid /auth/login payload", async () => {
    const res = await request("POST", "/auth/login", { body: { email: 42, password: 7 } });
    // Could be 400 (validation) or 401 (rejected creds). Either way the
    // shape must conform.
    expect([400, 401]).toContain(res.status);
    assertHasErrorShape(res.body);
  });

  it("400 on signup when ROOMY_ENABLE_SIGNUP is unset", async () => {
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("POST", "/auth/signup", {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    expect(res.status).toBe(400);
    assertHasErrorShape(res.body);
  });

  it("400 on bad /auth/signup payload when enabled", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      body: { username: "x", email: "bad", password: "short" },
    });
    expect(res.status).toBe(400);
    assertHasErrorShape(res.body);
  });

  it("400 on /vault/setup with a weak password", async () => {
    await clearSessions(pool);
    const token = await issueSession(pool, userId);
    const res = await request("POST", "/vault/setup", {
      token,
      body: { password: "tiny" },
    });
    expect(res.status).toBe(400);
    assertHasErrorShape(res.body);
  });
});
