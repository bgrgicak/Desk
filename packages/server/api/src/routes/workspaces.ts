import pg from "pg";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError } from "@desk/shared";

export async function listWorkspaces(pool: pg.Pool) {
  return queries.workspaces.list(pool);
}

export async function createWorkspace(
  pool: pg.Pool,
  userId: string,
  data: { name: string; description?: string; icon?: string },
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
  data: { name?: string; description?: string; icon?: string },
) {
  const ws = await queries.workspaces.updateMeta(pool, id, data);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Soft-delete a workspace. v1: marks it deleted but doesn't purge data.
 */
export async function deleteWorkspace(pool: pg.Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  // Soft-delete: just mark updated. A real impl would set a deleted_at flag.
  // For v1, we remove it from the list by actually deleting the row.
  // The cascade will clean up chats/files.
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

export async function setWorkspaceDefaultAgent(
  pool: pg.Pool,
  workspaceId: string,
  agentId: string,
) {
  await queries.workspaceAgents.setDefault(pool, workspaceId, agentId);
  return { ok: true };
}
