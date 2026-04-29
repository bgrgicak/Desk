import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@desk/db";
import { runMigrations, queries } from "@desk/db";
import { generateId } from "@desk/shared";
import {
  issueSession,
  revokeSession,
  verifySession,
  clearSessions,
} from "../src/auth/sessions.js";

let pool: Pool;
let userId: string;
let dbPath: string;

beforeAll(async () => {
  // Per-test-file SQLite file so workers don't collide.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-auth-"));
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
});

afterAll(async () => {
  await pool?.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
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

  it("verifySession returns null for tokens older than 7 days", async () => {
    const token = await issueSession(pool, userId);
    // Backdate the row past the 7-day TTL. Faking JS timers would not
    // affect the row's issued_at (set by SQLite's strftime('now')), so we
    // shift the row directly — the TTL check still uses the row's
    // wall-clock value.
    await pool.query(
      `UPDATE auth_sessions
          SET issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days', '-1 second')`,
    );
    expect(await verifySession(pool, token)).toBeNull();
  });

  it("verifySession still returns userId just before 7-day expiry", async () => {
    const token = await issueSession(pool, userId);
    await pool.query(
      `UPDATE auth_sessions
          SET issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days', '+5 seconds')`,
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
