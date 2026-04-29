import pg from "pg";

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Upserts authorship for a batch of paths in one round-trip. `agent_id`
 * reflects the *last* agent to touch each file (overwritten on conflict).
 * `creator_agent_id` is set only on the first insert and preserved on
 * conflict, so it remains a stable record of the original author even
 * after subsequent edits.
 */
export async function upsertAuthors(
  db: Queryable,
  workspaceId: string,
  agentId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await db.query(
    `INSERT INTO library_file_authors (workspace_id, path, agent_id, creator_agent_id, updated_at)
     SELECT $1, unnest($2::text[]), $3, $3, now()
     ON CONFLICT (workspace_id, path)
     DO UPDATE SET agent_id = EXCLUDED.agent_id, updated_at = EXCLUDED.updated_at`,
    [workspaceId, paths, agentId],
  );
}

export interface LibraryFileAuthors {
  agentId: string;
  creatorAgentId: string | null;
}

/**
 * Returns a map of path → { agentId, creatorAgentId } for all authored
 * files in a workspace. Paths missing a creator (legacy rows that
 * predate the column being set) yield `creatorAgentId: null`.
 */
export async function listByWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<Map<string, LibraryFileAuthors>> {
  const { rows } = await db.query(
    `SELECT path, agent_id, creator_agent_id
       FROM library_file_authors
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  const result = new Map<string, LibraryFileAuthors>();
  for (const row of rows) {
    if (!row.agent_id) continue;
    result.set(row.path as string, {
      agentId: row.agent_id as string,
      creatorAgentId: (row.creator_agent_id as string | null) ?? null,
    });
  }
  return result;
}
