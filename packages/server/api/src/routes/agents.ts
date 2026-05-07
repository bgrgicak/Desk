import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { generateId, NotFoundError, ValidationError } from "@agent-desk/shared";

export async function listAgents(pool: Pool, userId: string) {
  return queries.agents.listByUser(pool, userId);
}

export async function createAgent(
  pool: Pool,
  userId: string,
  data: { name: string; model?: string },
) {
  return queries.agents.insert(pool, {
    id: generateId("agent"),
    userId,
    ...data,
  });
}

export async function getAgent(pool: Pool, id: string) {
  const agent = await queries.agents.findById(pool, id);
  if (!agent) throw new NotFoundError(`Agent not found: ${id}`);
  return agent;
}

export async function patchAgent(
  pool: Pool,
  id: string,
  data: { name?: string; model?: string },
) {
  const agent = await queries.agents.updateMeta(pool, id, data);
  if (!agent) throw new NotFoundError(`Agent not found: ${id}`);
  return agent;
}

/**
 * Deletes an agent and cascades to its chats/messages/workspace memberships
 * (FK ON DELETE CASCADE in 0001_init.sql and 0003_workspace_agents.sql). The
 * on-disk chat directories owned by those chats are orphaned — acceptable for
 * the prototype; revisit when the agent lifecycle gains production-grade
 * constraints (e.g. reassign chats before delete).
 *
 * Refuses to delete the user's last agent — every user must retain at least
 * one so compose + existing chats remain usable.
 */
export async function deleteAgent(pool: Pool, userId: string, id: string) {
  const owned = await queries.agents.listByUser(pool, userId);
  if (owned.length <= 1) {
    throw new ValidationError(
      "Cannot delete the last agent; create another one first.",
    );
  }
  const soleWorkspaceAgent = await pool.query<{ id: string }>(
    `SELECT w.id
     FROM workspaces w
     JOIN workspace_agents wa ON wa.workspace_id = w.id
     WHERE w.user_id = ?
       AND wa.agent_id = ?
       AND (SELECT count(*) FROM workspace_agents other WHERE other.workspace_id = w.id) = 1
     LIMIT 1`,
    [userId, id],
  );
  if (soleWorkspaceAgent.rows.length > 0) {
    throw new ValidationError(
      "Cannot delete an agent that is the only agent in a workspace; add another agent to that workspace first.",
    );
  }
  const ok = await queries.agents.remove(pool, id);
  if (!ok) throw new NotFoundError(`Agent not found: ${id}`);
  return { ok: true as const };
}
