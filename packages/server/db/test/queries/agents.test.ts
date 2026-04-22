import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";
import * as users from "../../src/queries/users.js";

let pool: pg.Pool;
const ownerId = generateId("user");

beforeAll(async () => {
  pool = await setupTestDb();
  await users.insert(pool, {
    id: ownerId,
    username: "agent-owner",
    passwordHash: "x",
    email: "agent-owner@example.com",
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("agents queries", () => {
  const agentId = generateId("agent");

  it("inserts an agent", async () => {
    const agent = await agents.insert(pool, {
      id: agentId,
      userId: ownerId,
      name: "TestAgent",
      toolAllowlist: ["file.read", "file.write"],
    });
    expect(agent.id).toBe(agentId);
    expect(agent.userId).toBe(ownerId);
    expect(agent.name).toBe("TestAgent");
    expect(agent.toolAllowlist).toEqual(["file.read", "file.write"]);
  });

  it("listByUser returns only agents owned by the user", async () => {
    const other = generateId("user");
    await users.insert(pool, {
      id: other,
      username: "other-owner",
      passwordHash: "x",
      email: "other-owner@example.com",
    });
    const otherAgent = generateId("agent");
    await agents.insert(pool, {
      id: otherAgent,
      userId: other,
      name: "OtherAgent",
    });

    const mine = await agents.listByUser(pool, ownerId);
    expect(mine.some((a) => a.id === agentId)).toBe(true);
    expect(mine.some((a) => a.id === otherAgent)).toBe(false);
  });

  it("lists agents", async () => {
    const list = await agents.list(pool);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.find((a) => a.id === agentId)).toBeDefined();
  });

  it("finds by id", async () => {
    const agent = await agents.findById(pool, agentId);
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("TestAgent");
  });

  it("updates meta", async () => {
    const updated = await agents.updateMeta(pool, agentId, { name: "UpdatedAgent" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("UpdatedAgent");
  });

  it("gets tool allowlist", async () => {
    const tools = await agents.getToolAllowlist(pool, agentId);
    expect(tools).toEqual(["file.read", "file.write"]);
  });
});
