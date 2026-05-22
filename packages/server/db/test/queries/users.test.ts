import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId, UnauthorizedError } from "@roomy-ai/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import { hashPassword } from "../../src/passwords.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("users queries", () => {
  const userId = generateId("user");

  it("inserts a user", async () => {
    const user = await users.insert(pool, {
      id: userId,
      username: "testuser",
      passwordHash: "hash123",
      email: "test@example.com",
    });
    expect(user.id).toBe(userId);
    expect(user.username).toBe("testuser");
    expect(user.email).toBe("test@example.com");
  });

  it("finds by id", async () => {
    const user = await users.findById(pool, userId);
    expect(user).not.toBeNull();
    expect(user!.username).toBe("testuser");
  });

  it("finds by username", async () => {
    const user = await users.findByUsername(pool, "testuser");
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
  });

  it("finds by email", async () => {
    const user = await users.findByEmail(pool, "test@example.com");
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
  });

  it("returns null for nonexistent id", async () => {
    const user = await users.findById(pool, "usr_nonexistent");
    expect(user).toBeNull();
  });

  it("updates profile", async () => {
    const updated = await users.updateProfile(pool, userId, { username: "updated" });
    expect(updated).not.toBeNull();
    expect(updated!.username).toBe("updated");
  });

  it("updates password", async () => {
    const ok = await users.updatePassword(pool, userId, "newhash");
    expect(ok).toBe(true);
    const hash = await users.getPasswordHash(pool, userId);
    expect(hash).toBe("newhash");
  });

  it("login() verifies argon2id hashes and rejects wrong passwords", async () => {
    const loginId = generateId("user");
    const hash = await hashPassword("correct-horse");
    await users.insert(pool, {
      id: loginId,
      username: "loginer",
      passwordHash: hash,
      email: "loginer@example.com",
    });

    const ok = await users.login(pool, "loginer@example.com", "correct-horse");
    expect(ok?.id).toBe(loginId);

    const wrong = await users.login(pool, "loginer@example.com", "battery-staple");
    expect(wrong).toBeNull();

    const missing = await users.login(pool, "nobody@example.com", "whatever");
    expect(missing).toBeNull();
  });

  it("login() opportunistically rehashes legacy plain: entries", async () => {
    const legacyId = generateId("user");
    await users.insert(pool, {
      id: legacyId,
      username: "legacy",
      passwordHash: "plain:s3cret",
      email: "legacy@example.com",
    });

    const ok = await users.login(pool, "legacy@example.com", "s3cret");
    expect(ok?.id).toBe(legacyId);

    const rehashed = await users.getPasswordHash(pool, legacyId);
    expect(rehashed).not.toBeNull();
    expect(rehashed!.startsWith("plain:")).toBe(false);
    expect(rehashed!.startsWith("$argon2id$")).toBe(true);

    const stillOk = await users.login(pool, "legacy@example.com", "s3cret");
    expect(stillOk?.id).toBe(legacyId);
  });

  it("setPassword() verifies current password and writes argon2id hash", async () => {
    const spId = generateId("user");
    const hash = await hashPassword("old-pass");
    await users.insert(pool, {
      id: spId,
      username: "pwchanger",
      passwordHash: hash,
      email: "pwchanger@example.com",
    });

    await users.setPassword(pool, spId, "old-pass", "new-pass");
    const stored = await users.getPasswordHash(pool, spId);
    expect(stored!.startsWith("$argon2id$")).toBe(true);

    const ok = await users.login(pool, "pwchanger@example.com", "new-pass");
    expect(ok?.id).toBe(spId);

    await expect(
      users.setPassword(pool, spId, "wrong-current", "whatever"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("two users can share the same display name (username is no longer unique)", async () => {
    const aliceId = generateId("user");
    const bobId = generateId("user");
    await users.insert(pool, {
      id: aliceId,
      username: "Alex",
      passwordHash: "hash-a",
      email: "alex-1@example.com",
    });
    // Same display name, distinct email — should succeed.
    await users.insert(pool, {
      id: bobId,
      username: "Alex",
      passwordHash: "hash-b",
      email: "alex-2@example.com",
    });

    expect(await users.findById(pool, aliceId)).not.toBeNull();
    expect(await users.findById(pool, bobId)).not.toBeNull();
  });
});
