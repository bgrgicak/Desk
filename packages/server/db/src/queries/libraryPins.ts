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
