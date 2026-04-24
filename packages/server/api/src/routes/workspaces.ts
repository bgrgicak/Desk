import pg from "pg";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError } from "@desk/shared";

export async function listWorkspaces(pool: pg.Pool, userId?: string) {
  if (userId) return queries.workspaces.listByUser(pool, userId);
  return queries.workspaces.list(pool);
}

export async function createWorkspace(
  pool: pg.Pool,
  userId: string,
  data: { name: string; description?: string; icon?: string; color?: string },
) {
  return queries.workspaces.insert(pool, {
    id: generateId("workspace"),
    userId,
    ...data,
  });
}

export async function getWorkspace(pool: pg.Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

export async function patchWorkspace(
  pool: pg.Pool,
  id: string,
  data: { name?: string; description?: string; icon?: string; color?: string },
) {
  const ws = await queries.workspaces.updateMeta(pool, id, data);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Hard-deletes a workspace (FK cascade removes chats/messages/workspace_agents).
 * Refuses to delete the user's last workspace — the app requires at least one.
 */
export async function deleteWorkspace(pool: pg.Pool, userId: string, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  const owned = await queries.workspaces.listByUser(pool, userId);
  if (owned.length <= 1) {
    throw new ValidationError(
      "Cannot delete the last workspace; create another one first.",
    );
  }
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  return { ok: true };
}

/** Lists agents enabled in a workspace, with defaults. */
export async function listWorkspaceAgents(pool: pg.Pool, workspaceId: string) {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const memberships = await queries.workspaceAgents.listForWorkspace(pool, workspaceId);
  const agents = await Promise.all(
    memberships.map(async (m) => {
      const agent = await queries.agents.findById(pool, m.agentId);
      return agent ? { ...agent, isDefault: m.isDefault, addedAt: m.addedAt } : null;
    }),
  );
  return agents.filter((a): a is NonNullable<typeof a> => a !== null);
}

/** Adds an agent to a workspace. Validates that the agent belongs to the workspace's owner. */
export async function addAgentToWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  agentId: string,
) {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const agent = await queries.agents.findById(pool, agentId);
  if (!agent) throw new NotFoundError(`Agent not found: ${agentId}`);
  if (agent.userId !== ws.userId) {
    throw new ValidationError(
      "Agent owner does not match workspace owner; cannot add to workspace",
    );
  }
  return queries.workspaceAgents.addToWorkspace(pool, workspaceId, agentId);
}

export async function removeAgentFromWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  agentId: string,
) {
  await queries.workspaceAgents.removeFromWorkspace(pool, workspaceId, agentId);
  return { ok: true };
}

/**
 * Sets the workspace default agent. Auto-enrolls the agent in the workspace
 * first if it isn't already a member — clicking "make default" on a globally-
 * listed agent should not 404 just because the user hasn't separately enrolled
 * it. Owner mismatch is still rejected by addAgentToWorkspace.
 */
export async function setWorkspaceDefaultAgent(
  pool: pg.Pool,
  workspaceId: string,
  agentId: string,
) {
  const enrolled = await queries.workspaceAgents.findForWorkspace(
    pool,
    workspaceId,
    agentId,
  );
  if (!enrolled) {
    await addAgentToWorkspace(pool, workspaceId, agentId);
  }
  await queries.workspaceAgents.setDefault(pool, workspaceId, agentId);
  return { ok: true };
}
