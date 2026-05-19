import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as providerKeyAccessLog from "../../src/queries/providerKeyAccessLog.js";
import * as users from "../../src/queries/users.js";
import { hashPassword } from "../../src/passwords.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

async function makeUser(username: string): Promise<string> {
  const id = generateId("user");
  await users.insert(pool, {
    id,
    username,
    passwordHash: await hashPassword("pw"),
    email: `${username}@example.com`,
  });
  return id;
}

describe("providerKeyAccessLog queries", () => {
  it("logKeyAccess inserts a row and getKeyAccessLog returns it", async () => {
    const userId = await makeUser("pkal-user1");
    await providerKeyAccessLog.logKeyAccess(
      pool, userId, "write", ["GEMINI_API_KEY"], "user_update",
    );
    const log = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(log).toHaveLength(1);
    expect(log[0].userId).toBe(userId);
    expect(log[0].action).toBe("write");
    expect(log[0].providers).toEqual(["GEMINI_API_KEY"]);
    expect(log[0].reason).toBe("user_update");
    expect(log[0].createdAt).toBeInstanceOf(Date);
  });

  it("getKeyAccessLog returns entries newest-first", async () => {
    const userId = await makeUser("pkal-user2");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "write", ["GEMINI_API_KEY"], "user_update");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["GEMINI_API_KEY"], "sandbox_run:msg_1");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "delete", ["OPENAI_API_KEY"], "user_update");
    const log = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(log).toHaveLength(3);
    expect(log[0].action).toBe("delete");
    expect(log[1].action).toBe("read");
    expect(log[2].action).toBe("write");
  });

  it("getKeyAccessLog is scoped per user", async () => {
    const userA = await makeUser("pkal-user3");
    const userB = await makeUser("pkal-user4");
    await providerKeyAccessLog.logKeyAccess(pool, userA, "write", ["GEMINI_API_KEY"], "user_update");
    await providerKeyAccessLog.logKeyAccess(pool, userB, "read", ["OPENAI_API_KEY"], "sandbox_run:msg_2");
    const logA = await providerKeyAccessLog.getKeyAccessLog(pool, userA);
    const logB = await providerKeyAccessLog.getKeyAccessLog(pool, userB);
    expect(logA).toHaveLength(1);
    expect(logA[0].action).toBe("write");
    expect(logB).toHaveLength(1);
    expect(logB[0].action).toBe("read");
  });

  it("logKeyAccess accepts null reason", async () => {
    const userId = await makeUser("pkal-user5");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["GEMINI_API_KEY"]);
    const log = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(log[0].reason).toBeNull();
  });

  it("getKeyAccessLog respects limit", async () => {
    const userId = await makeUser("pkal-user6");
    for (let i = 0; i < 5; i++) {
      await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["GEMINI_API_KEY"], `sandbox_run:msg_${i}`);
    }
    const log = await providerKeyAccessLog.getKeyAccessLog(pool, userId, 3);
    expect(log).toHaveLength(3);
  });

  it("rows are deleted when user is deleted (ON DELETE CASCADE)", async () => {
    const userId = await makeUser("pkal-user7");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "write", ["GEMINI_API_KEY"], "user_update");
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    const log = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(log).toHaveLength(0);
  });

  it("pruneKeyAccessLog removes only rows older than the cutoff", async () => {
    const userId = await makeUser("pkal-user8");
    // Two fresh rows + one row deliberately back-dated past the cutoff.
    await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["OPENAI_API_KEY"], "sandbox_run:fresh1");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["OPENAI_API_KEY"], "sandbox_run:fresh2");
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO provider_key_access_log (user_id, action, providers, reason, created_at)
       VALUES (?, 'read', ?, 'sandbox_run:stale', ?)`,
      [userId, JSON.stringify(["OPENAI_API_KEY"]), oldDate],
    );
    const before = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(before).toHaveLength(3);

    const removed = await providerKeyAccessLog.pruneKeyAccessLog(pool, 90);
    expect(removed).toBe(1);

    const after = await providerKeyAccessLog.getKeyAccessLog(pool, userId);
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.reason !== "sandbox_run:stale")).toBe(true);
  });

  it("pruneKeyAccessLog returns 0 when nothing is past the cutoff", async () => {
    const userId = await makeUser("pkal-user9");
    await providerKeyAccessLog.logKeyAccess(pool, userId, "read", ["OPENAI_API_KEY"], "sandbox_run:fresh");
    const removed = await providerKeyAccessLog.pruneKeyAccessLog(pool, 90);
    expect(removed).toBe(0);
  });
});
