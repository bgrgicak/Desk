import { type Pool, type PoolClient } from "@desk/db";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError, slugifyWorkspaceName } from "@desk/shared";
import { ensureWorkspaceLayout, renameWorkspaceDir, trashWorkspaceDir } from "@desk/storage";

export async function listWorkspaces(pool: Pool, userId?: string) {
  if (userId) return queries.workspaces.listByUser(pool, userId);
  return queries.workspaces.list(pool);
}

/**
 * Creates a workspace and auto-enrolls the caller's first agent (from
 * `agents.listByUser`, which orders by name). Without this, chat creation
 * would 400 on every agentId in the new workspace — users would have to
 * open settings and enroll an agent before the workspace is usable.
 * Users can override the enrollment via the Agent access settings panel.
 *
 * The workspace's on-disk directory at `~/Desk/workspaces/{slug}/` is
 * created before the DB insert so every successful insert has a matching
 * folder. Slug is derived from `name` with a `-2`, `-3`, ... suffix on
 * collision so two workspaces can't share a directory.
 */
export async function createWorkspace(
  pool: Pool,
  userId: string,
  home: string,
  data: { name: string; description?: string; icon?: string; color?: string },
) {
  const path = await queries.workspaces.reserveWorkspacePath(pool, data.name);
  await ensureWorkspaceLayout(home, path);
  const ws = await queries.workspaces.insert(pool, {
    id: generateId("workspace"),
    userId,
    path,
    ...data,
  });
  const userAgents = await queries.agents.listByUser(pool, userId);
  if (userAgents.length > 0) {
    await queries.workspaceAgents.addToWorkspace(pool, ws.id, userAgents[0].id);
  }
  return ws;
}

export async function getWorkspace(pool: Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Updates workspace metadata. When `name` changes, computes a new slug
 * from the new name; if it differs from the current slug and is free,
 * renames the on-disk directory and updates the `path` column to match.
 * All other changes are pure metadata and skip the filesystem op.
 */
export async function patchWorkspace(
  pool: Pool,
  home: string,
  id: string,
  data: { name?: string; description?: string; icon?: string; color?: string },
) {
  const current = await queries.workspaces.findById(pool, id);
  if (!current) throw new NotFoundError(`Workspace not found: ${id}`);

  let newPath: string | undefined;
  if (data.name !== undefined && data.name !== current.name) {
    const desired = slugifyWorkspaceName(data.name);
    if (desired !== current.path) {
      newPath = await queries.workspaces.reserveWorkspacePath(pool, data.name, id);
      await renameWorkspaceDir(home, current.path, newPath);
    }
  }

  const ws = await queries.workspaces.updateMeta(pool, id, {
    ...data,
    ...(newPath ? { path: newPath } : {}),
  });
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Hard-deletes a workspace (FK cascade removes chats/messages/workspace_agents)
 * and moves its on-disk directory into `~/Desk/.trash/workspaces/`.
 * Refuses to delete the user's last workspace — the app requires at least one.
 */
export async function deleteWorkspace(
  pool: Pool,
  home: string,
  userId: string,
  id: string,
) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  const owned = await queries.workspaces.listByUser(pool, userId);
  if (owned.length <= 1) {
    throw new ValidationError(
      "Cannot delete the last workspace; create another one first.",
    );
  }
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  await trashWorkspaceDir(home, ws.path).catch(() => {
    // Best-effort; DB state is already gone.
  });
  return { ok: true };
}

/** Lists agents enabled in a workspace, ordered by enrollment time. */
export async function listWorkspaceAgents(pool: Pool, workspaceId: string) {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const memberships = await queries.workspaceAgents.listForWorkspace(pool, workspaceId);
  const agents = await Promise.all(
    memberships.map(async (m) => {
      const agent = await queries.agents.findById(pool, m.agentId);
      return agent ? { ...agent, addedAt: m.addedAt } : null;
    }),
  );
  return agents.filter((a): a is NonNullable<typeof a> => a !== null);
}

/** Adds an agent to a workspace. Validates that the agent belongs to the workspace's owner. */
export async function addAgentToWorkspace(
  pool: Pool,
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
  pool: Pool,
  workspaceId: string,
  agentId: string,
) {
  await queries.workspaceAgents.removeFromWorkspace(pool, workspaceId, agentId);
  return { ok: true };
}
