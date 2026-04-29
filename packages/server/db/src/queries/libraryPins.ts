import { type Pool } from "../pool.js";

type Queryable = Pool;

export async function pin(
  db: Queryable,
  workspaceId: string,
  path: string,
): Promise<void> {
  await db.query(
    `INSERT INTO library_pins (workspace_id, path)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
    [workspaceId, path],
  );
}

export async function unpin(
  db: Queryable,
  workspaceId: string,
  path: string,
): Promise<void> {
  await db.query(
    `DELETE FROM library_pins WHERE workspace_id = ? AND path = ?`,
    [workspaceId, path],
  );
}

export async function updatePinPath(
  db: Queryable,
  workspaceId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await db.query(
    `UPDATE library_pins SET path = ? WHERE workspace_id = ? AND path = ?`,
    [newPath, workspaceId, oldPath],
  );
}

export async function updateFolderPinPaths(
  db: Queryable,
  workspaceId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  // SQLite has no `substring(... from N)` form; use substr(haystack, N).
  // The Postgres original pinned by-position params ($1/$2/$3 reused), so
  // each unique value appeared once in the values array — under `?` we
  // have to push one entry per occurrence and follow textual order.
  await db.query(
    `UPDATE library_pins
        SET path = ? || substr(path, length(?) + 1)
      WHERE workspace_id = ? AND path LIKE ? || '/%'`,
    [newPrefix, oldPrefix, workspaceId, oldPrefix],
  );
}

export async function listPinnedPaths(
  db: Queryable,
  workspaceId: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{ path: string }>(
    `SELECT path FROM library_pins WHERE workspace_id = ?`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.path));
}
