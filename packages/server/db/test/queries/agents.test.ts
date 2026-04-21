import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("agents queries", () => {
  const agentId = generateId("agent");

  it("inserts an agent", async () => {
    const agent = await agents.insert(pool, {
      id: agentId,
      name: "TestAgent",
      toolAllowlist: ["file.read", "file.write"],
    });
    expect(agent.id).toBe(agentId);
    expect(agent.name).toBe("TestAgent");
    expect(agent.toolAllowlist).toEqual(["file.read", "file.write"]);
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
