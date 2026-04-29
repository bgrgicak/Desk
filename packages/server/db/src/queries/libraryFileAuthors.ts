import { type Pool } from "../pool.js";

type Queryable = Pool;

/**
 * Upserts authorship for a batch of paths in one round-trip. `agent_id`
 * reflects the *last* agent to touch each file (overwritten on conflict).
 * `creator_agent_id` is set only on the first insert and preserved on
 * conflict, so it remains a stable record of the original author even
 * after subsequent edits.
 *
 * SQLite has no array type, so we expand to N rows in a single
 * multi-VALUES insert. better-sqlite3 imposes a SQLITE_MAX_VARIABLE_NUMBER
 * cap (default 32766) — well above any realistic single-run scan size.
 */
export async function upsertAuthors(
  db: Queryable,
  workspaceId: string,
  agentId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const values = paths.map(() => "(?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").join(",\n            ");
  const params: unknown[] = [];
  for (const path of paths) {
    params.push(workspaceId, path, agentId, agentId);
  }
  await db.query(
    `INSERT INTO library_file_authors (workspace_id, path, agent_id, creator_agent_id, updated_at)
     VALUES ${values}
     ON CONFLICT (workspace_id, path)
     DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
    params,
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
      WHERE workspace_id = ?`,
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
