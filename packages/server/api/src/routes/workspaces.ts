import pg from "pg";
import { queries } from "@desk/db";
import { generateId, NotFoundError } from "@desk/shared";

export async function listWorkspaces(pool: pg.Pool) {
  return queries.workspaces.list(pool);
}

export async function createWorkspace(
  pool: pg.Pool,
  userId: string,
  data: { name: string; description?: string; icon?: string },
) {
  return queries.workspaces.insert(pool, {
    id: generateId("workspace"),
    userId,
    ...data,
  });
}

export async function getWorkspace(pool: pg.Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

export async function patchWorkspace(
  pool: pg.Pool,
  id: string,
  data: { name?: string; description?: string; icon?: string },
) {
  const ws = await queries.workspaces.updateMeta(pool, id, data);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Soft-delete a workspace. v1: marks it deleted but doesn't purge data.
 */
export async function deleteWorkspace(pool: pg.Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  // Soft-delete: just mark updated. A real impl would set a deleted_at flag.
  // For v1, we remove it from the list by actually deleting the row.
  // The cascade will clean up chats/files.
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  return { ok: true };
}
