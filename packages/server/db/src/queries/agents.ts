import pg from "pg";
import { AgentSchema, type Agent } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToAgent(row: Record<string, unknown>): Agent {
  return AgentSchema.parse({
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    model: row.model,
    toolAllowlist: row.tool_allowlist,
  });
}

export async function list(db: Queryable): Promise<Agent[]> {
  const { rows } = await db.query("SELECT * FROM agents ORDER BY name");
  return rows.map(rowToAgent);
}

export async function findById(db: Queryable, id: string): Promise<Agent | null> {
  const { rows } = await db.query("SELECT * FROM agents WHERE id = $1", [id]);
  return rows.length ? rowToAgent(rows[0]) : null;
}

export async function insert(
  db: Queryable,
  data: { id: string; name: string; instructions?: string; model?: string; toolAllowlist?: string[] },
): Promise<Agent> {
  const { rows } = await db.query(
    `INSERT INTO agents (id, name, instructions, model, tool_allowlist)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      data.id,
      data.name,
      data.instructions ?? "",
      data.model ?? "claude-sonnet-4-20250514",
      JSON.stringify(data.toolAllowlist ?? []),
    ],
  );
  return rowToAgent(rows[0]);
}

export async function updateMeta(
  db: Queryable,
  id: string,
  data: { name?: string; instructions?: string; model?: string },
): Promise<Agent | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(data.name);
  }
  if (data.instructions !== undefined) {
    sets.push(`instructions = $${idx++}`);
    params.push(data.instructions);
  }
  if (data.model !== undefined) {
    sets.push(`model = $${idx++}`);
    params.push(data.model);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToAgent(rows[0]) : null;
}

export async function getToolAllowlist(db: Queryable, id: string): Promise<string[] | null> {
  const { rows } = await db.query(
    "SELECT tool_allowlist FROM agents WHERE id = $1",
    [id],
  );
  if (!rows.length) return null;
  return rows[0].tool_allowlist as string[];
}
