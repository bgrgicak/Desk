import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { generateId, NotFoundError, ValidationError } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";
import * as users from "../../src/queries/users.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as workspaceAgents from "../../src/queries/workspaceAgents.js";

let pool: pg.Pool;
let userId: string;
let workspaceId: string;
let agent1: string;
let agent2: string;

beforeAll(async () => {
  pool = await setupTestDb();
  userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "wa-owner",
    passwordHash: "x",
    email: "wa-owner@example.com",
  });
  agent1 = generateId("agent");
  agent2 = generateId("agent");
  await agents.insert(pool, { id: agent1, userId, name: "AgentOne" });
  await agents.insert(pool, { id: agent2, userId, name: "AgentTwo" });
  workspaceId = generateId("workspace");
  await workspaces.insert(pool, { id: workspaceId, userId, name: "WorkspaceA" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query("DELETE FROM workspace_agents WHERE workspace_id = $1", [workspaceId]);
});

describe("workspace_agents queries", () => {
  it("addToWorkspace marks the first agent as default automatically", async () => {
    const wa = await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    expect(wa.isDefault).toBe(true);

    const wa2 = await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    expect(wa2.isDefault).toBe(false);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list).toHaveLength(2);
    expect(list.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it("addToWorkspace is idempotent — re-adding keeps existing is_default", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    // Re-adding agent1 should not flip its default state
    const again = await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    expect(again.isDefault).toBe(true);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list).toHaveLength(2);
  });

  it("setDefault atomically swaps the default flag", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    await workspaceAgents.setDefault(pool, workspaceId, agent2);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list.find((r) => r.agentId === agent1)!.isDefault).toBe(false);
    expect(list.find((r) => r.agentId === agent2)!.isDefault).toBe(true);

    const def = await workspaceAgents.getDefault(pool, workspaceId);
    expect(def?.agentId).toBe(agent2);
  });

  it("setDefault fails when the target is not in the workspace", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    const orphan = generateId("agent");
    await agents.insert(pool, { id: orphan, userId, name: "Orphan" });

    await expect(
      workspaceAgents.setDefault(pool, workspaceId, orphan),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removeFromWorkspace rejects removing the default when others exist", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);

    await expect(
      workspaceAgents.removeFromWorkspace(pool, workspaceId, agent1),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("removeFromWorkspace allows removing the default when it's the only one", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.removeFromWorkspace(pool, workspaceId, agent1);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list).toHaveLength(0);
  });

  it("removes a non-default agent cleanly", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    await workspaceAgents.removeFromWorkspace(pool, workspaceId, agent2);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list.map((r) => r.agentId)).toEqual([agent1]);
  });

  it("cascade deletes rows when the workspace is deleted", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    // Create a throwaway workspace so we don't torch the outer describe's state
    const wsThrow = generateId("workspace");
    await workspaces.insert(pool, { id: wsThrow, userId, name: "Throw" });
    await workspaceAgents.addToWorkspace(pool, wsThrow, agent1);

    await pool.query("DELETE FROM workspaces WHERE id = $1", [wsThrow]);
    const { rows } = await pool.query(
      "SELECT 1 FROM workspace_agents WHERE workspace_id = $1",
      [wsThrow],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("chats.insert validation against workspace_agents", () => {
  it("rejects creation when the agent is not in the workspace", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    // agent2 is NOT added
    const { insert } = await import("../../src/queries/chats.js");
    await expect(
      insert(pool, {
        id: generateId("chat"),
        workspaceId,
        agentId: agent2,
        title: "Bad chat",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows creation when the agent is in the workspace", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    const { insert } = await import("../../src/queries/chats.js");
    const chat = await insert(pool, {
      id: generateId("chat"),
      workspaceId,
      agentId: agent1,
      title: "Valid chat",
    });
    expect(chat.agentId).toBe(agent1);
  });
});
