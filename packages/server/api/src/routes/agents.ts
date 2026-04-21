import pg from "pg";
import { queries } from "@desk/db";
import { NotFoundError } from "@desk/shared";

export async function listAgents(pool: pg.Pool) {
  return queries.agents.list(pool);
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
