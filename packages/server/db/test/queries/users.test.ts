import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";

let pool: pg.Pool;

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
});
