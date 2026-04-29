import { type Pool } from "../pool.js";
import { AgentSchema, type Agent } from "@desk/shared";

function rowToAgent(row: Record<string, unknown>): Agent {
  return AgentSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    instructions: row.instructions,
    model: row.model,
  });
}

export async function list(db: Pool): Promise<Agent[]> {
  const { rows } = await db.query("SELECT * FROM agents ORDER BY name");
  return rows.map(rowToAgent);
}

export async function listByUser(db: Pool, userId: string): Promise<Agent[]> {
  const { rows } = await db.query(
    "SELECT * FROM agents WHERE user_id = ? ORDER BY name",
    [userId],
  );
  return rows.map(rowToAgent);
}

export async function findById(db: Pool, id: string): Promise<Agent | null> {
  const { rows } = await db.query("SELECT * FROM agents WHERE id = ?", [id]);
  return rows.length ? rowToAgent(rows[0]) : null;
}

export async function insert(
  db: Pool,
  data: { id: string; userId: string; name: string; instructions?: string; model?: string },
): Promise<Agent> {
  const { rows } = await db.query(
    `INSERT INTO agents (id, user_id, name, instructions, model)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.name,
      data.instructions ?? "",
      data.model ?? "opencode/big-pickle",
    ],
  );
  return rowToAgent(rows[0]);
}

export async function updateMeta(
  db: Pool,
  id: string,
  data: { name?: string; instructions?: string; model?: string },
): Promise<Agent | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) {
    sets.push(`name = ?`);
    params.push(data.name);
  }
  if (data.instructions !== undefined) {
    sets.push(`instructions = ?`);
    params.push(data.instructions);
  }
  if (data.model !== undefined) {
    sets.push(`model = ?`);
    params.push(data.model);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToAgent(rows[0]) : null;
}

export async function remove(db: Pool, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM agents WHERE id = ?", [id]);
  return (rowCount ?? 0) > 0;
}
