import pg from "pg";
import { WorkspaceSchema, type Workspace } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color ?? "",
    createdAt: (row.created_at as Date).toISOString(),
  });
}

export async function list(db: Queryable): Promise<Workspace[]> {
  const { rows } = await db.query("SELECT * FROM workspaces ORDER BY created_at");
  return rows.map(rowToWorkspace);
}

export async function listByUser(db: Queryable, userId: string): Promise<Workspace[]> {
  const { rows } = await db.query(
    "SELECT * FROM workspaces WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return rows.map(rowToWorkspace);
}

export async function findById(db: Queryable, id: string): Promise<Workspace | null> {
  const { rows } = await db.query("SELECT * FROM workspaces WHERE id = $1", [id]);
  return rows.length ? rowToWorkspace(rows[0]) : null;
}

export async function insert(
  db: Queryable,
  data: { id: string; userId: string; name: string; description?: string; icon?: string; color?: string },
): Promise<Workspace> {
  const { rows } = await db.query(
    `INSERT INTO workspaces (id, user_id, name, description, icon, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.name,
      data.description ?? "",
      data.icon ?? "",
      data.color ?? "",
    ],
  );
  return rowToWorkspace(rows[0]);
}

export async function updateMeta(
  db: Queryable,
  id: string,
  data: { name?: string; description?: string; icon?: string; color?: string },
): Promise<Workspace | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push(`description = $${idx++}`);
    params.push(data.description);
  }
  if (data.icon !== undefined) {
    sets.push(`icon = $${idx++}`);
    params.push(data.icon);
  }
  if (data.color !== undefined) {
    sets.push(`color = $${idx++}`);
    params.push(data.color);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToWorkspace(rows[0]) : null;
}
