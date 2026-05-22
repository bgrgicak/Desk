import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-signup-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-signup-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;
  vault = new VaultStore(path.join(home, ".vaults"));

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

beforeEach(async () => {
  await pool.query("DELETE FROM users WHERE username NOT IN (?)", ["roomy"]);
  await clearSessions(pool);
  clearRateLimits();
  prevSignupEnv = process.env.ROOMY_ENABLE_SIGNUP;
});

afterAll(async () => {
  if (prevSignupEnv === undefined) delete process.env.ROOMY_ENABLE_SIGNUP;
  else process.env.ROOMY_ENABLE_SIGNUP = prevSignupEnv;
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

// Bootstrap a user row through the public signup endpoint so the
// downstream test starts in the post-first-run state. Caller is
// responsible for any env-var dance — this just creates the user.
async function bootstrapExistingUser(): Promise<void> {
  const prev = process.env.ROOMY_ENABLE_SIGNUP;
  process.env.ROOMY_ENABLE_SIGNUP = "1";
  const res = await request("POST", "/auth/signup", {
    username: "preexisting",
    email: "preexisting@example.com",
    password: "correct-horse-battery",
  });
  if (res.status !== 200) {
    throw new Error(`bootstrap signup failed (${res.status})`);
  }
  if (prev === undefined) delete process.env.ROOMY_ENABLE_SIGNUP;
  else process.env.ROOMY_ENABLE_SIGNUP = prev;
  clearRateLimits();
}

describe("GET /auth/signup-status", () => {
  it("reports firstRun and enabled on an empty DB", async () => {
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
    const body = res.body as { enabled: boolean; firstRun: boolean };
    // No users seeded — first-run unlocks signup automatically.
    expect(body.firstRun).toBe(true);
    expect(body.enabled).toBe(true);
  });

  it("returns enabled: false when users exist and ROOMY_ENABLE_SIGNUP is unset", async () => {
    await bootstrapExistingUser();
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
    const body = res.body as { enabled: boolean; firstRun: boolean };
    expect(body.firstRun).toBe(false);
    expect(body.enabled).toBe(false);
  });

  it("returns enabled: true when ROOMY_ENABLE_SIGNUP=1", async () => {
    await bootstrapExistingUser();
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
    const body = res.body as { enabled: boolean; firstRun: boolean };
    expect(body.firstRun).toBe(false);
    expect(body.enabled).toBe(true);
  });

  it("does not require authentication", async () => {
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("GET", "/auth/signup-status");
    expect(res.status).toBe(200);
  });
});

describe("POST /auth/signup", () => {
  it("allows signup on first-run even without ROOMY_ENABLE_SIGNUP", async () => {
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("POST", "/auth/signup", {
      username: "firstuser",
      email: "first@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(200);
    expect(typeof (res.body as { token: string }).token).toBe("string");
  });

  it("refuses when ROOMY_ENABLE_SIGNUP is unset and a user already exists", async () => {
    await bootstrapExistingUser();
    delete process.env.ROOMY_ENABLE_SIGNUP;
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/disabled/i);
  });

  it("creates a user and returns a session token when enabled", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
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

  it("does NOT seed a default agent — the new user must add a model explicitly", async () => {
    // A fresh user has no vault and no connector credentials. Auto-creating
    // an agent here would render in the onboarding "Add AI providers" step
    // as if the user already configured a provider — misleading them about
    // what state exists on their behalf, and blurring the line between
    // "credentials I added" and "rows the server seeded for me".
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "freshie",
      email: "freshie@example.com",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(200);
    const user = await queries.users.findByUsername(pool, "freshie");
    expect(user).toBeTruthy();
    const agents = await queries.agents.listByUser(pool, user!.id);
    expect(agents).toEqual([]);
  });

  it("does NOT auto-create a vault at signup when no vaultPassword is supplied", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
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

  it("creates the vault inline when vaultPassword is supplied", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "vaultuser",
      email: "vaultuser@example.com",
      password: "correct-horse-battery",
      vaultPassword: "another-strong-passphrase",
    });
    expect(res.status).toBe(200);
    const user = await queries.users.findByUsername(pool, "vaultuser");
    expect(user).toBeTruthy();
    const status = await vault.status(user!.id);
    expect(status.exists).toBe(true);
  });

  it("rolls back the user when vaultPassword fails policy", async () => {
    // A weak vault password is caught by enforcePasswordPolicy. The
    // failure has to land before any DB writes so the username can be
    // immediately re-used in the wizard's retry.
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "rollback",
      email: "rollback@example.com",
      password: "correct-horse-battery",
      vaultPassword: "short",
    });
    expect(res.status).toBe(400);
    const user = await queries.users.findByUsername(pool, "rollback");
    expect(user).toBeNull();
  });

  it("creates an optional first workspace alongside the hub", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "withroom",
      email: "withroom@example.com",
      password: "correct-horse-battery",
      workspace: { name: "My first room", description: "scratchpad", color: "#fef3c7" },
    });
    expect(res.status).toBe(200);
    const user = await queries.users.findByUsername(pool, "withroom");
    expect(user).toBeTruthy();
    const ws = await queries.workspaces.listByUser(pool, user!.id);
    // Hub + the optional room.
    expect(ws.length).toBe(2);
    expect(ws.some((w) => w.name === "My first room")).toBe(true);
  });

  it("treats an empty workspace.name as 'skip' rather than 400", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "skiproom",
      email: "skiproom@example.com",
      password: "correct-horse-battery",
      workspace: { name: "   " },
    });
    expect(res.status).toBe(200);
    const user = await queries.users.findByUsername(pool, "skiproom");
    expect(user).toBeTruthy();
    const ws = await queries.workspaces.listByUser(pool, user!.id);
    // Only the hub.
    expect(ws.length).toBe(1);
    expect(ws[0].kind).toBe("hub");
  });

  it("rejects empty / too-long / control-char display names", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    // Empty after trimming.
    const empty = await request("POST", "/auth/signup", {
      username: "   ",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(empty.status).toBe(400);
    // Longer than 80 chars.
    const tooLong = await request("POST", "/auth/signup", {
      username: "x".repeat(81),
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(tooLong.status).toBe(400);
    // Display name with embedded control character.
    const ctrl = await request("POST", "/auth/signup", {
      username: "badname",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(ctrl.status).toBe(400);
    // Spaces and short names are now allowed (display name, not handle).
    const okWithSpace = await request("POST", "/auth/signup", {
      username: "Al",
      email: "al@example.com",
      password: "correct-horse-battery",
    });
    expect(okWithSpace.status).toBe(200);
  });

  it("rejects malformed emails", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "not-an-email",
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(400);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "short",
    });
    expect(res.status).toBe(400);
  });

  it("rejects the documented seed password", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const res = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "change-me-before-first-boot",
    });
    expect(res.status).toBe(400);
  });

  it("allows two users to share the same display name (username is no longer unique)", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const first = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(first.status).toBe(200);
    const second = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice2@example.com",
      password: "another-strong-passphrase",
    });
    expect(second.status).toBe(200);
  });

  it("rejects duplicate emails", async () => {
    process.env.ROOMY_ENABLE_SIGNUP = "1";
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
    process.env.ROOMY_ENABLE_SIGNUP = "1";
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
    process.env.ROOMY_ENABLE_SIGNUP = "1";
    const signupRes = await request("POST", "/auth/signup", {
      username: "alice",
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(signupRes.status).toBe(200);
    clearRateLimits();
    const loginRes = await request("POST", "/auth/login", {
      email: "alice@example.com",
      password: "correct-horse-battery",
    });
    expect(loginRes.status).toBe(200);
    expect(typeof (loginRes.body as { token: string }).token).toBe("string");
  });
});
