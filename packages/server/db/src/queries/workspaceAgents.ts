import pg from "pg";
import { WorkspaceAgentSchema, type WorkspaceAgent, NotFoundError, ValidationError } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToWorkspaceAgent(row: Record<string, unknown>): WorkspaceAgent {
  return WorkspaceAgentSchema.parse({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    isDefault: row.is_default,
    addedAt: (row.added_at as Date).toISOString(),
  });
}

/**
 * Lists the agents enabled in a workspace, with default-flag.
 */
export async function listForWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<WorkspaceAgent[]> {
  const { rows } = await db.query(
    "SELECT * FROM workspace_agents WHERE workspace_id = $1 ORDER BY added_at",
    [workspaceId],
  );
  return rows.map(rowToWorkspaceAgent);
}

export async function findForWorkspace(
  db: Queryable,
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceAgent | null> {
  const { rows } = await db.query(
    "SELECT * FROM workspace_agents WHERE workspace_id = $1 AND agent_id = $2",
    [workspaceId, agentId],
  );
  return rows.length ? rowToWorkspaceAgent(rows[0]) : null;
}

/**
 * Enables an agent in a workspace. If it's the first agent, marks as default.
 */
export async function addToWorkspace(
  db: Queryable,
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceAgent> {
  const { rows: existing } = await db.query(
    "SELECT count(*)::int AS c FROM workspace_agents WHERE workspace_id = $1",
    [workspaceId],
  );
  const isFirst = existing[0].c === 0;

  const { rows } = await db.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE SET is_default = workspace_agents.is_default
     RETURNING *`,
    [workspaceId, agentId, isFirst],
  );
  return rowToWorkspaceAgent(rows[0]);
}

/**
 * Removes an agent from a workspace. Throws if the agent is the default AND
 * other agents exist (caller must set a new default first).
 */
export async function removeFromWorkspace(
  db: Queryable,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const current = await findForWorkspace(db, workspaceId, agentId);
  if (!current) throw new NotFoundError(`Agent not enabled in workspace: ${agentId}`);

  if (current.isDefault) {
    const { rows } = await db.query(
      "SELECT count(*)::int AS c FROM workspace_agents WHERE workspace_id = $1",
      [workspaceId],
    );
    if (rows[0].c > 1) {
      throw new ValidationError(
        "Cannot remove the default agent while other agents exist; set a new default first",
      );
    }
  }

  await db.query(
    "DELETE FROM workspace_agents WHERE workspace_id = $1 AND agent_id = $2",
    [workspaceId, agentId],
  );
}

/**
 * Atomically sets an agent as the workspace default, clearing any previous default.
 */
export async function setDefault(
  db: Queryable,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const existing = await findForWorkspace(db, workspaceId, agentId);
  if (!existing) {
    throw new NotFoundError(`Agent not enabled in workspace: ${agentId}`);
  }
  await db.query(
    `UPDATE workspace_agents SET is_default = (agent_id = $2)
     WHERE workspace_id = $1`,
    [workspaceId, agentId],
  );
}

export async function getDefault(
  db: Queryable,
  workspaceId: string,
): Promise<WorkspaceAgent | null> {
  const { rows } = await db.query(
    "SELECT * FROM workspace_agents WHERE workspace_id = $1 AND is_default = true",
    [workspaceId],
  );
  return rows.length ? rowToWorkspaceAgent(rows[0]) : null;
}
