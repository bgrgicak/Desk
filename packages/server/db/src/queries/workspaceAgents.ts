import { type Pool } from "../pool.js";
import { WorkspaceAgentSchema, type WorkspaceAgent, NotFoundError } from "@agent-desk/shared";

function rowToWorkspaceAgent(row: Record<string, unknown>): WorkspaceAgent {
  return WorkspaceAgentSchema.parse({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    addedAt: row.added_at as string,
  });
}

/**
 * Lists the globally-active agents enabled in a workspace, ordered by the
 * user's global model order. Callers that need a fallback "default" agent pick
 * the first row.
 */
export async function listForWorkspace(
  db: Pool,
  workspaceId: string,
): Promise<WorkspaceAgent[]> {
  const { rows } = await db.query(
    `SELECT wa.*
       FROM workspace_agents wa
       JOIN agents a ON a.id = wa.agent_id
      WHERE wa.workspace_id = ?
        AND a.enabled = 1
      ORDER BY a.sort_order ASC, a.name COLLATE NOCASE ASC, a.id ASC, wa.added_at ASC, wa.ROWID ASC`,
    [workspaceId],
  );
  return rows.map(rowToWorkspaceAgent);
}

export async function findForWorkspace(
  db: Pool,
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceAgent | null> {
  const { rows } = await db.query(
    "SELECT * FROM workspace_agents WHERE workspace_id = ? AND agent_id = ?",
    [workspaceId, agentId],
  );
  return rows.length ? rowToWorkspaceAgent(rows[0]) : null;
}

export async function addToWorkspace(
  db: Pool,
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceAgent> {
  const { rows } = await db.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?)
     ON CONFLICT (workspace_id, agent_id) DO NOTHING
     RETURNING *`,
    [workspaceId, agentId],
  );
  if (rows.length) return rowToWorkspaceAgent(rows[0]);
  const existing = await findForWorkspace(db, workspaceId, agentId);
  if (!existing) throw new NotFoundError(`Agent not enabled in workspace: ${agentId}`);
  return existing;
}

export async function removeFromWorkspace(
  db: Pool,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const current = await findForWorkspace(db, workspaceId, agentId);
  if (!current) throw new NotFoundError(`Agent not enabled in workspace: ${agentId}`);
  await db.query(
    "DELETE FROM workspace_agents WHERE workspace_id = ? AND agent_id = ?",
    [workspaceId, agentId],
  );
}
