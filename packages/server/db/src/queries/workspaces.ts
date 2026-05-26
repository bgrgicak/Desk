import { type Pool } from "../pool.js";
import {
  WorkspaceSchema,
  slugifyWorkspaceName,
  type Workspace,
  type WorkspaceKind,
} from "@roomy-ai/shared";

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color ?? "",
    path: row.path,
    kind: (row.kind as WorkspaceKind | undefined) ?? "project",
    createdAt: row.created_at as string,
  });
}

/**
 * Sort order for `listByUser`: project workspaces first by created_at,
 * hub workspace last. Clients identify the hub by `kind`, not by index.
 */
const LIST_SORT = `ORDER BY (kind = 'hub') ASC, created_at`;

export async function list(db: Pool): Promise<Workspace[]> {
  const { rows } = await db.query(`SELECT * FROM workspaces ${LIST_SORT}`);
  return rows.map(rowToWorkspace);
}

export async function listByUser(db: Pool, userId: string): Promise<Workspace[]> {
  const { rows } = await db.query(
    `SELECT * FROM workspaces WHERE user_id = ? ${LIST_SORT}`,
    [userId],
  );
  return rows.map(rowToWorkspace);
}

export async function findById(db: Pool, id: string): Promise<Workspace | null> {
  const { rows } = await db.query("SELECT * FROM workspaces WHERE id = ?", [id]);
  return rows.length ? rowToWorkspace(rows[0]) : null;
}

/**
 * Returns the user's hub workspace, or null if it does not exist yet
 * (e.g. before the boot-time auto-create runs). Hub uniqueness is
 * enforced at the DB level via `workspaces_user_hub_unique`.
 */
export async function findHubByUser(db: Pool, userId: string): Promise<Workspace | null> {
  const { rows } = await db.query(
    "SELECT * FROM workspaces WHERE user_id = ? AND kind = 'hub' LIMIT 1",
    [userId],
  );
  return rows.length ? rowToWorkspace(rows[0]) : null;
}

/**
 * Returns a directory slug for `name` that doesn't collide with any
 * existing workspaces.path value. Suffixes `-2`, `-3`, ... until free.
 * Optional `excludeId` lets a rename check "is this free or mine?".
 */
export async function reserveWorkspacePath(
  db: Pool,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugifyWorkspaceName(name);
  const { rows } = await db.query<{ path: string }>(
    excludeId
      ? `SELECT path FROM workspaces WHERE (path = ? OR path LIKE ?) AND id <> ?`
      : `SELECT path FROM workspaces WHERE path = ? OR path LIKE ?`,
    excludeId ? [base, `${base}-%`, excludeId] : [base, `${base}-%`],
  );
  const taken = new Set(rows.map((r) => r.path));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export async function insert(
  db: Pool,
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
    /** Defaults to 'project'. Internal callers (createHub) pass 'hub'. The
     * API never accepts a user-supplied kind, so production-path inserts
     * from `POST /workspaces` always end up as 'project'. */
    kind?: WorkspaceKind;
  },
): Promise<Workspace> {
  const path = data.path ?? (await reserveWorkspacePath(db, data.name));
  const { rows } = await db.query(
    `INSERT INTO workspaces (id, user_id, name, path, description, icon, color, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.name,
      path,
      data.description ?? "",
      data.icon ?? "",
      data.color ?? "",
      data.kind ?? "project",
    ],
  );
  return rowToWorkspace(rows[0]);
}

export async function updateMeta(
  db: Pool,
  id: string,
  data: { name?: string; description?: string; icon?: string; color?: string; path?: string },
): Promise<Workspace | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) {
    sets.push(`name = ?`);
    params.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push(`description = ?`);
    params.push(data.description);
  }
  if (data.icon !== undefined) {
    sets.push(`icon = ?`);
    params.push(data.icon);
  }
  if (data.color !== undefined) {
    sets.push(`color = ?`);
    params.push(data.color);
  }
  if (data.path !== undefined) {
    sets.push(`path = ?`);
    params.push(data.path);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE workspaces SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToWorkspace(rows[0]) : null;
}
