import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as workspaces from "../../src/queries/workspaces.js";

let pool: pg.Pool;
let userId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "wsowner",
    passwordHash: "hash",
    email: "wsowner@example.com",
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("workspaces queries", () => {
  const wsId = generateId("workspace");

  it("inserts a workspace", async () => {
    const ws = await workspaces.insert(pool, {
      id: wsId,
      userId,
      name: "TestWS",
    });
    expect(ws.id).toBe(wsId);
    expect(ws.name).toBe("TestWS");
    expect(ws.userId).toBe(userId);
  });

  it("lists workspaces", async () => {
    const list = await workspaces.list(pool);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("finds by id", async () => {
    const ws = await workspaces.findById(pool, wsId);
    expect(ws).not.toBeNull();
    expect(ws!.name).toBe("TestWS");
  });

  it("updates meta", async () => {
    const updated = await workspaces.updateMeta(pool, wsId, {
      name: "Renamed",
      description: "New desc",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.description).toBe("New desc");
  });

  it("cascades delete when user is deleted", async () => {
    const tempUserId = generateId("user");
    await users.insert(pool, {
      id: tempUserId,
      username: "temp",
      passwordHash: "h",
      email: "temp@example.com",
    });
    const tempWsId = generateId("workspace");
    await workspaces.insert(pool, { id: tempWsId, userId: tempUserId, name: "TempWS" });

    await pool.query("DELETE FROM users WHERE id = $1", [tempUserId]);
    const ws = await workspaces.findById(pool, tempWsId);
    expect(ws).toBeNull();
  });
});
