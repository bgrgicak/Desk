import pg from "pg";

type Queryable = pg.Pool | pg.PoolClient;

/** Upserts authorship for a batch of paths in one round-trip. */
export async function upsertAuthors(
  db: Queryable,
  workspaceId: string,
  agentId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await db.query(
    `INSERT INTO library_file_authors (workspace_id, path, agent_id, updated_at)
     SELECT $1, unnest($2::text[]), $3, now()
     ON CONFLICT (workspace_id, path)
     DO UPDATE SET agent_id = EXCLUDED.agent_id, updated_at = EXCLUDED.updated_at`,
    [workspaceId, paths, agentId],
  );
}

/** Returns a map of path → agentId for all authored files in a workspace. */
export async function listByWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `SELECT path, agent_id FROM library_file_authors WHERE workspace_id = $1`,
    [workspaceId],
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (row.agent_id) result.set(row.path as string, row.agent_id as string);
  }
  return result;
}
