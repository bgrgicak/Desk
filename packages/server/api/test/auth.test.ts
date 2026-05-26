import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { hashPassword, runMigrations, queries } from "@roomy-ai/db";
import { generateId } from "@roomy-ai/shared";
import {
  issueSession,
  revokeSession,
  verifySession,
  clearSessions,
} from "../src/auth/sessions.js";
import { handleLogin } from "../src/routes/auth.js";
import { UnauthorizedError } from "@roomy-ai/shared";

let pool: Pool;
let userId: string;
let dbPath: string;

beforeAll(async () => {
  // Per-test-file SQLite file so workers don't collide.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-auth-"));
  dbPath = path.join(tmpDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  // verifySession requires the row's user_id FK to resolve.
  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "auth-test",
    passwordHash: "$2b$10$placeholder",
    email: "auth-test@example.com",
  });
});

afterEach(async () => {
  await clearSessions(pool);
  await pool.query("DELETE FROM users WHERE username = ?", ["second-user"]);
});

afterAll(async () => {
  await pool?.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

describe("password login (handleLogin)", () => {
  it("authenticates by email + password and returns a session token", async () => {
    const id = generateId("user");
    await queries.users.insert(pool, {
      id,
      username: "Login Tester",
      passwordHash: await hashPassword("correct-horse-battery-staple"),
      email: "login-tester@example.com",
    });

    const { token } = await handleLogin(pool, {
      email: "login-tester@example.com",
      password: "correct-horse-battery-staple",
    });

    expect(token).toMatch(/^ses_/);
    expect(await verifySession(pool, token)).toBe(id);

    await pool.query("DELETE FROM users WHERE id = ?", [id]);
  });

  it("rejects an unknown email with 401", async () => {
    await expect(
      handleLogin(pool, { email: "nobody@example.com", password: "whatever" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a wrong password with 401", async () => {
    const id = generateId("user");
    await queries.users.insert(pool, {
      id,
      username: "wrong-pw",
      passwordHash: await hashPassword("right-pass"),
      email: "wrong-pw@example.com",
    });

    await expect(
      handleLogin(pool, { email: "wrong-pw@example.com", password: "not-it" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    await pool.query("DELETE FROM users WHERE id = ?", [id]);
  });

  it("two users with the same display name can each log in by their own email", async () => {
    const aliceId = generateId("user");
    const bobId = generateId("user");
    await queries.users.insert(pool, {
      id: aliceId,
      username: "Alex",
      passwordHash: await hashPassword("alice-pw-1234"),
      email: "alice@example.com",
    });
    await queries.users.insert(pool, {
      id: bobId,
      username: "Alex",
      passwordHash: await hashPassword("bob-pw-1234"),
      email: "bob@example.com",
    });

    const a = await handleLogin(pool, {
      email: "alice@example.com",
      password: "alice-pw-1234",
    });
    const b = await handleLogin(pool, {
      email: "bob@example.com",
      password: "bob-pw-1234",
    });
    expect(await verifySession(pool, a.token)).toBe(aliceId);
    expect(await verifySession(pool, b.token)).toBe(bobId);

    await pool.query("DELETE FROM users WHERE id IN (?, ?)", [aliceId, bobId]);
  });
});

describe("session store", () => {
  it("issueSession returns a ses_ prefixed token", async () => {
    const token = await issueSession(pool, userId);
    expect(token).toMatch(/^ses_/);
  });

  it("verifySession returns userId for valid token", async () => {
    const token = await issueSession(pool, userId);
    expect(await verifySession(pool, token)).toBe(userId);
  });

  it("verifySession returns null for unknown token", async () => {
    expect(await verifySession(pool, "ses_unknown")).toBeNull();
  });

  it("revokeSession invalidates the token", async () => {
    const token = await issueSession(pool, userId);
    expect(await revokeSession(pool, token)).toBe(true);
    expect(await verifySession(pool, token)).toBeNull();
  });

  it("revokeSession returns false for unknown token", async () => {
    expect(await revokeSession(pool, "ses_unknown")).toBe(false);
  });

  it("verifySession returns null for tokens older than 30 days", async () => {
    const token = await issueSession(pool, userId);
    // Backdate the row past the 30-day TTL. Faking JS timers would not
    // affect the row's issued_at (set by SQLite's strftime('now')), so we
    // shift the row directly — the TTL check still uses the row's
    // wall-clock value.
    await pool.query(
      `UPDATE auth_sessions
          SET issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days', '-1 second')`,
    );
    expect(await verifySession(pool, token)).toBeNull();
  });

  it("verifySession still returns userId just before 30-day expiry", async () => {
    const token = await issueSession(pool, userId);
    await pool.query(
      `UPDATE auth_sessions
          SET issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days', '+5 seconds')`,
    );
    expect(await verifySession(pool, token)).toBe(userId);
  });

  it("session survives a fresh pool against the same database", async () => {
    // Regression: the session store used to live in a process-local Map,
    // so any server restart wiped every active token even though the
    // browser's stored token was still in its TTL — every subsequent
    // request returned 401 "Invalid or expired session token". Closing
    // the pool and opening a new one against the same database is the
    // closest in-process proxy for a process restart; verifySession must
    // still resolve the token.
    //
    // EXCLUSIVE locking_mode means we close before re-opening — concurrent
    // pools against the same file collide on the lock. That matches the
    // production constraint anyway (the API is the only DB opener).
    const token = await issueSession(pool, userId);
    await pool.end();
    pool = new Pool({ path: dbPath });
    expect(await verifySession(pool, token)).toBe(userId);
  });
});
