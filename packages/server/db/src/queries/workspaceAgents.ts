import { type Pool } from "../pool.js";
import { WorkspaceAgentSchema, type WorkspaceAgent, NotFoundError } from "@desk/shared";

function rowToWorkspaceAgent(row: Record<string, unknown>): WorkspaceAgent {
  return WorkspaceAgentSchema.parse({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    addedAt: row.added_at as string,
  });
}

/**
 * Lists the agents enabled in a workspace, ordered by enrollment time.
 * Callers that need a fallback "default" agent pick the first row.
 */
export async function listForWorkspace(
  db: Pool,
  workspaceId: string,
): Promise<WorkspaceAgent[]> {
  // Tie-break by ROWID so rows added in the same millisecond keep their
  // insertion order. SQLite's added_at default has ms precision but two
  // calls in the same tick still collide; ROWID is monotonic per insert.
  const { rows } = await db.query(
    "SELECT * FROM workspace_agents WHERE workspace_id = ? ORDER BY added_at, ROWID",
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
