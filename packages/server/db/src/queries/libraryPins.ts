import pg from "pg";

type Queryable = pg.Pool | pg.PoolClient;

export async function pin(
  db: Queryable,
  workspaceId: string,
  path: string,
): Promise<void> {
  await db.query(
    `INSERT INTO library_pins (workspace_id, path)
     VALUES ($1, $2)
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
    `DELETE FROM library_pins WHERE workspace_id = $1 AND path = $2`,
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
    `UPDATE library_pins SET path = $3 WHERE workspace_id = $1 AND path = $2`,
    [workspaceId, oldPath, newPath],
  );
}

export async function updateFolderPinPaths(
  db: Queryable,
  workspaceId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  await db.query(
    `UPDATE library_pins
     SET path = $3 || substring(path from length($2) + 1)
     WHERE workspace_id = $1 AND path LIKE $2 || '/%'`,
    [workspaceId, oldPrefix, newPrefix],
  );
}

export async function listPinnedPaths(
  db: Queryable,
  workspaceId: string,
): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT path FROM library_pins WHERE workspace_id = $1`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.path as string));
}
