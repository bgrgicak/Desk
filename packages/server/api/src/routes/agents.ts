import pg from "pg";
import { queries } from "@desk/db";
import { generateId, NotFoundError } from "@desk/shared";

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
