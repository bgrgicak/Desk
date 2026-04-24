import pg from "pg";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError } from "@desk/shared";

export async function listAgents(pool: pg.Pool, userId: string) {
  return queries.agents.listByUser(pool, userId);
}

export async function createAgent(
  pool: pg.Pool,
  userId: string,
  data: { name: string; instructions?: string; model?: string; toolAllowlist?: string[] },
) {
  return queries.agents.insert(pool, {
    id: generateId("agent"),
    userId,
    ...data,
  });
}

export async function getAgent(pool: pg.Pool, id: string) {
  const agent = await queries.agents.findById(pool, id);
  if (!agent) throw new NotFoundError(`Agent not found: ${id}`);
  return agent;
}

export async function patchAgent(
  pool: pg.Pool,
  id: string,
  data: { name?: string; instructions?: string; model?: string },
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
export async function deleteAgent(pool: pg.Pool, userId: string, id: string) {
  const owned = await queries.agents.listByUser(pool, userId);
  if (owned.length <= 1) {
    throw new ValidationError(
      "Cannot delete the last agent; create another one first.",
    );
  }
  const ok = await queries.agents.remove(pool, id);
  if (!ok) throw new NotFoundError(`Agent not found: ${id}`);
  return { ok: true as const };
}
