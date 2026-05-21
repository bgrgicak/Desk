import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { createApp, type AppOptions } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearRateLimits } from "../src/auth/rateLimit.js";
import { VaultStore } from "../src/vault/store.js";

let pool: Pool;
let home: string;
let dbPath: string;
let server: http.Server;
let vault: VaultStore;
let prevSignupEnv: string | undefined;
let prevVaultPasswordEnv: string | undefined;

function appOpts(): AppOptions {
  return {
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
    vault,
  };
}

function request(method: string, reqPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-signup-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-signup-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  vault = new VaultStore(path.join(home, "vaults"));

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

beforeEach(async () => {
  await pool.query("DELETE FROM users WHERE username NOT IN (?)", ["desk"]);
  await clearSessions(pool);
  clearRateLimits();
  prevSignupEnv = process.env.DESK_ENABLE_SIGNUP;
  prevVaultPasswordEnv = process.env.DESK_VAULT_PASSWORD;
});

afterAll(async () => {
  if (prevSignupEnv === undefined) delete process.env.DESK_ENABLE_SIGNUP;
  else process.env.DESK_ENABLE_SIGNUP = prevSignupEnv;
  if (prevVaultPasswordEnv === undefined) delete process.env.DESK_VAULT_PASSWORD;
  else process.env.DESK_VAULT_PASSWORD = prevVaultPasswordEnv;
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("GET /auth/signup-status", () => {
  it("returns enabled: false by default", async () => {
    delete process.env.DESK_ENABLE_SIGNUP;
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
    expect((res.body as { enabled: boolean }).enabled).toBe(false);
  });

  it("returns enabled: true when DESK_ENABLE_SIGNUP=1", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
    expect((res.body as { enabled: boolean }).enabled).toBe(true);
  });

  it("does not require authentication", async () => {
    delete process.env.DESK_ENABLE_SIGNUP;
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
  });
});

describe("POST /auth/signup", () => {
  it("refuses when DESK_ENABLE_SIGNUP is unset", async () => {
    delete process.env.DESK_ENABLE_SIGNUP;
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/disabled/i);
  });

  it("creates a user and returns a session token when enabled", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(200);
    const body = res.body as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token).toMatch(/^ses_/);

    const user = await queries.users.findByUsername(pool, "alice");
    expect(user).toBeTruthy();
    expect(user?.email).toBe("alice@example.com");
  });

  it("does NOT auto-create a vault at signup, even with DESK_VAULT_PASSWORD set", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    process.env.DESK_VAULT_PASSWORD = "would-have-been-auto-applied";
    const res = await request("POST", "/auth/signup", {
      username: "vaultless",
      email: "vaultless@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(200);
    const user = await queries.users.findByUsername(pool, "vaultless");
    expect(user).toBeTruthy();
    // The vault file should not exist — the user is expected to set a
    // password through the VaultDialog on first credential save.
    const status = await vault.status(user!.id);
    expect(status).toEqual({ exists: false, locked: true });
  });

  it("rejects usernames that fail the pattern", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const bad = await request("POST", "/auth/signup", {
      username: "x",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(bad.status).toBe(400);
    const spaces = await request("POST", "/auth/signup", {
      username: "with space",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(spaces.status).toBe(400);
  });

  it("rejects malformed emails", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "not-an-email",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(400);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "short",
    });
    expect(res.status).toBe(400);
  });

  it("rejects the documented seed password", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "change-me-before-first-boot",
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate usernames", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const ok = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(ok.status).toBe(200);
    const dup = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice2@example.com",
      password: "another-strong-passphrase",
    });
    expect(dup.status).toBe(409);
  });

  it("rejects duplicate emails", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const ok = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(ok.status).toBe(200);
    const dup = await request("POST", "/auth/signup", {
      username: "bob",
      email: "alice@example.com",
      password: "another-strong-passphrase",
    });
    expect(dup.status).toBe(409);
  });

  it("rate-limits after 5 attempts per IP per minute", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    let last;
    for (let i = 0; i < 6; i++) {
      last = await request("POST", "/auth/signup", {
        username: `user${i}`,
        email: `user${i}@example.com`,
        password: "correct-horse-battery",
      });
    }
    expect(last?.status).toBe(429);
  });

  it("allows the new user to log in with the chosen password", async () => {
    process.env.DESK_ENABLE_SIGNUP = "1";
    const signupRes = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(signupRes.status).toBe(200);
    clearRateLimits();
    const loginRes = await request("POST", "/auth/login", {
      username: "alice",
      password: "correct-horse-battery",
    });
    expect(loginRes.status).toBe(200);
    expect(typeof (loginRes.body as { token: string }).token).toBe("string");
  });
});
