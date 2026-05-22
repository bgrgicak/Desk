import { type Pool, transact } from "../pool.js";
import { AgentSchema, ValidationError, type Agent } from "@roomy-ai/shared";

const ORDER_SQL = "sort_order ASC, name COLLATE NOCASE ASC, id ASC";

function rowToAgent(row: Record<string, unknown>): Agent {
  return AgentSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    model: row.model,
    enabled: row.enabled === undefined ? true : !!row.enabled,
    sortOrder: row.sort_order === undefined ? 0 : Number(row.sort_order),
  });
}

export async function list(db: Pool): Promise<Agent[]> {
  const { rows } = await db.query(`SELECT * FROM agents ORDER BY ${ORDER_SQL}`);
  return rows.map(rowToAgent);
}

export async function listByUser(db: Pool, userId: string): Promise<Agent[]> {
  const { rows } = await db.query(
    `SELECT * FROM agents WHERE user_id = ? ORDER BY ${ORDER_SQL}`,
    [userId],
  );
  return rows.map(rowToAgent);
}

export async function listActiveByUser(db: Pool, userId: string): Promise<Agent[]> {
  const { rows } = await db.query(
    `SELECT * FROM agents WHERE user_id = ? AND enabled = 1 ORDER BY ${ORDER_SQL}`,
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
  data: { id: string; userId: string; name: string; model?: string; enabled?: boolean },
): Promise<Agent> {
  const { rows } = await db.query(
    `INSERT INTO agents (id, user_id, name, model, enabled, sort_order)
     VALUES (
       ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(sort_order) + 1 FROM agents WHERE user_id = ?), 0)
     )
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.name,
      data.model ?? "anthropic/claude-haiku-4-5",
      data.enabled ?? true,
      data.userId,
    ],
  );
  return rowToAgent(rows[0]);
}

export async function updateMeta(
  db: Pool,
  id: string,
  data: { name?: string; model?: string; enabled?: boolean; sortOrder?: number },
): Promise<Agent | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) {
    sets.push(`name = ?`);
    params.push(data.name);
  }
  if (data.model !== undefined) {
    sets.push(`model = ?`);
    params.push(data.model);
  }
  if (data.enabled !== undefined) {
    sets.push(`enabled = ?`);
    params.push(data.enabled ? 1 : 0);
  }
  if (data.sortOrder !== undefined) {
    sets.push(`sort_order = ?`);
    params.push(data.sortOrder);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToAgent(rows[0]) : null;
}

export async function setOrder(
  db: Pool,
  userId: string,
  agentIds: string[],
): Promise<Agent[]> {
  const owned = await listByUser(db, userId);
  const ownedIds = new Set(owned.map((a) => a.id));
  const requestedIds = new Set(agentIds);
  if (
    requestedIds.size !== agentIds.length ||
    requestedIds.size !== ownedIds.size ||
    agentIds.some((id) => !ownedIds.has(id))
  ) {
    throw new ValidationError("Agent order must include each of the user's agents exactly once.");
  }

  transact(db, (tx) => {
    agentIds.forEach((id, index) => {
      tx.querySync(
        `UPDATE agents SET sort_order = ? WHERE user_id = ? AND id = ?`,
        [index, userId, id],
      );
    });
  });
  return listByUser(db, userId);
}

export async function remove(db: Pool, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM agents WHERE id = ?", [id]);
  return (rowCount ?? 0) > 0;
}
