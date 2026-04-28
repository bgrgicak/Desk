import { type Pool, type PoolClient } from "../pool.js";
import { WorkspaceSchema, slugifyWorkspaceName, type Workspace } from "@desk/shared";

type Queryable = Pool | PoolClient;

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color ?? "",
    path: row.path,
    createdAt: row.created_at as string,
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

/**
 * Returns a directory slug for `name` that doesn't collide with any
 * existing workspaces.path value. Suffixes `-2`, `-3`, ... until free.
 * Optional `excludeId` lets a rename check "is this free or mine?".
 */
export async function reserveWorkspacePath(
  db: Queryable,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugifyWorkspaceName(name);
  const { rows } = await db.query<{ path: string }>(
    excludeId
      ? `SELECT path FROM workspaces WHERE (path = $1 OR path LIKE $2) AND id <> $3`
      : `SELECT path FROM workspaces WHERE path = $1 OR path LIKE $2`,
    excludeId ? [base, `${base}-%`, excludeId] : [base, `${base}-%`],
  );
  const taken = new Set(rows.map((r) => r.path));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export async function insert(
  db: Queryable,
  data: {
    id: string;
    userId: string;
    name: string;
    /** Pre-resolved directory slug. When omitted, derived from `name` via
     * `reserveWorkspacePath` so every workspace lands in its own folder. */
    path?: string;
    description?: string;
    icon?: string;
    color?: string;
  },
): Promise<Workspace> {
  const path = data.path ?? (await reserveWorkspacePath(db, data.name));
  const { rows } = await db.query(
    `INSERT INTO workspaces (id, user_id, name, path, description, icon, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.name,
      path,
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
  data: { name?: string; description?: string; icon?: string; color?: string; path?: string },
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
  if (data.path !== undefined) {
    sets.push(`path = $${idx++}`);
    params.push(data.path);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToWorkspace(rows[0]) : null;
}
