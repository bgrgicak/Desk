import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId, NotFoundError, ValidationError } from "@roomy-ai/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";
import * as users from "../../src/queries/users.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as workspaceAgents from "../../src/queries/workspaceAgents.js";

let pool: Pool;
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
  await workspaces.insert(pool, { id: workspaceId, userId, name: "WorkspaceA", path: `wsa-${workspaceId.slice(-6)}` });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query("DELETE FROM workspace_agents WHERE workspace_id = ?", [workspaceId]);
  await agents.updateMeta(pool, agent1, { enabled: true });
  await agents.updateMeta(pool, agent2, { enabled: true });
  await agents.setOrder(pool, userId, [agent1, agent2]);
});

describe("workspace_agents queries", () => {
  it("addToWorkspace enrolls agents and lists them in enrollment order", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list.map((r) => r.agentId)).toEqual([agent1, agent2]);
  });

  it("listForWorkspace follows global model order and hides inactive agents", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    await agents.setOrder(pool, userId, [agent2, agent1]);
    await agents.updateMeta(pool, agent1, { enabled: false });

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list.map((r) => r.agentId)).toEqual([agent2]);
  });

  it("addToWorkspace is idempotent", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    const again = await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    expect(again.agentId).toBe(agent1);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list).toHaveLength(1);
  });

  it("removeFromWorkspace removes an enrolled agent", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent2);
    await workspaceAgents.removeFromWorkspace(pool, workspaceId, agent1);

    const list = await workspaceAgents.listForWorkspace(pool, workspaceId);
    expect(list.map((r) => r.agentId)).toEqual([agent2]);
  });

  it("removeFromWorkspace throws NotFoundError for an un-enrolled agent", async () => {
    await expect(
      workspaceAgents.removeFromWorkspace(pool, workspaceId, agent1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cascade deletes rows when the workspace is deleted", async () => {
    const wsThrow = generateId("workspace");
    await workspaces.insert(pool, { id: wsThrow, userId, name: "Throw", path: `throw-${wsThrow.slice(-6)}` });
    await workspaceAgents.addToWorkspace(pool, wsThrow, agent1);

    await pool.query("DELETE FROM workspaces WHERE id = ?", [wsThrow]);
    const { rows } = await pool.query(
      "SELECT 1 FROM workspace_agents WHERE workspace_id = ?",
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

  it("rejects creation when the agent is globally inactive", async () => {
    await workspaceAgents.addToWorkspace(pool, workspaceId, agent1);
    await agents.updateMeta(pool, agent1, { enabled: false });
    const { insert } = await import("../../src/queries/chats.js");
    await expect(
      insert(pool, {
        id: generateId("chat"),
        workspaceId,
        agentId: agent1,
        title: "Inactive chat",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
