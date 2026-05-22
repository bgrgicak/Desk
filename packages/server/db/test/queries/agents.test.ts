import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@roomy-ai/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";
import * as users from "../../src/queries/users.js";

let pool: Pool;
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
    });
    expect(agent.id).toBe(agentId);
    expect(agent.userId).toBe(ownerId);
    expect(agent.name).toBe("TestAgent");
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

  it("orders agents per user and filters active agents", async () => {
    const userId = generateId("user");
    await users.insert(pool, {
      id: userId,
      username: "ordered-owner",
      passwordHash: "x",
      email: "ordered-owner@example.com",
    });

    const firstId = generateId("agent");
    const secondId = generateId("agent");
    const thirdId = generateId("agent");
    const first = await agents.insert(pool, { id: firstId, userId, name: "First", model: "anthropic/fail" });
    const second = await agents.insert(pool, { id: secondId, userId, name: "Second", model: "codex/gpt-5.5" });
    const third = await agents.insert(pool, { id: thirdId, userId, name: "Third", model: "openai/gpt-5.4" });

    expect(first.enabled).toBe(true);
    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(third.sortOrder).toBe(2);

    await agents.setOrder(pool, userId, [thirdId, firstId, secondId]);
    await agents.updateMeta(pool, firstId, { enabled: false });

    const ordered = await agents.listByUser(pool, userId);
    expect(ordered.map((a) => a.id)).toEqual([thirdId, firstId, secondId]);
    expect(ordered.map((a) => a.sortOrder)).toEqual([0, 1, 2]);
    expect(ordered.find((a) => a.id === firstId)?.enabled).toBe(false);

    const active = await agents.listActiveByUser(pool, userId);
    expect(active.map((a) => a.id)).toEqual([thirdId, secondId]);
  });
});
