import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import { hashPassword } from "@roomy-ai/db";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearRateLimits } from "../src/auth/rateLimit.js";

let pool: Pool;
let home: string;
let userId: string;
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

function request(method: string, reqPath: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-ratelimit-http-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-ratelimit-http-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "ratelimit-test",
    passwordHash: await hashPassword("correct-horse-battery"),
    email: "ratelimit@example.com",
  });

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

beforeEach(async () => {
  await clearSessions(pool);
  clearRateLimits();
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

describe("rate limiting — HTTP layer", () => {
  it("returns 429 with Retry-After after too many /auth/login attempts from one IP", async () => {
    // Per-IP cap is 10/min. Burst 11 attempts with a wrong password.
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request("POST", "/auth/login", {
        body: { username: "ratelimit-test", password: "wrong" },
      });
    }
    expect(last?.status).toBe(429);
    expect((last?.body as { code: string }).code).toBe("RATE_LIMITED");
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("still allows a successful login from a fresh IP after limit was reset", async () => {
    for (let i = 0; i < 11; i++) {
      await request("POST", "/auth/login", { body: { username: "ratelimit-test", password: "wrong" } });
    }
    clearRateLimits("auth.login");
    const ok = await request("POST", "/auth/login", {
      body: { username: "ratelimit-test", password: "correct-horse-battery" },
    });
    expect(ok.status).toBe(200);
    expect(typeof (ok.body as { token?: string }).token).toBe("string");
  });

  it("returns 429 after too many /me/password attempts for the same user", async () => {
    const token = await issueSession(pool, userId);
    // Per-user cap is 10 / 5 min. Burst 11.
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request("POST", "/me/password", {
        token,
        body: { currentPassword: "wrong", newPassword: "anything-longer-than-needed" },
      });
    }
    expect(last?.status).toBe(429);
    expect((last?.body as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("returns 429 after too many /vault/unlock attempts (per-IP bucket trips first)", async () => {
    const token = await issueSession(pool, userId);
    // Create a vault first so the unlock attempts go through the normal
    // "wrong password" path (401) instead of "vault does not exist"
    // (500). The 11th request should hit the rate limit regardless of
    // those response codes.
    await request("POST", "/vault/setup", { token, body: { password: "correct-horse-battery-staple" } });
    await request("POST", "/vault/lock", { token });
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request("POST", "/vault/unlock", { token, body: { password: "guess-which-fails" } });
    }
    expect(last?.status).toBe(429);
  });
});
