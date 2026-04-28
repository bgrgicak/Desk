import { type Pool, type PoolClient } from "../pool.js";
import { SandboxSessionSchema, type SandboxSession } from "@desk/shared";

type Queryable = Pool | PoolClient;

function rowToSandboxSession(row: Record<string, unknown>): SandboxSession {
  return SandboxSessionSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id ?? undefined,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at as string,
    revokedAt: row.revoked_at ? row.revoked_at as string : undefined,
  });
}

export async function issue(
  db: Queryable,
  data: { id: string; agentId: string; workspaceId?: string; tokenHash: string },
): Promise<SandboxSession> {
  const { rows } = await db.query(
    `INSERT INTO sandbox_sessions (id, agent_id, workspace_id, token_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.id, data.agentId, data.workspaceId ?? null, data.tokenHash],
  );
  return rowToSandboxSession(rows[0]);
}

export async function findByTokenHash(
  db: Queryable,
  tokenHash: string,
): Promise<SandboxSession | null> {
  const { rows } = await db.query(
    "SELECT * FROM sandbox_sessions WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash],
  );
  return rows.length ? rowToSandboxSession(rows[0]) : null;
}

export async function revoke(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE sandbox_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
  return (rowCount ?? 0) > 0;
}
