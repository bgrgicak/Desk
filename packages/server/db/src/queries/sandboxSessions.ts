import pg from "pg";
import { SandboxSessionSchema, type SandboxSession } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToSandboxSession(row: Record<string, unknown>): SandboxSession {
  return SandboxSessionSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    tokenHash: row.token_hash,
    issuedAt: (row.issued_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : undefined,
  });
}

export async function issue(
  db: Queryable,
  data: { id: string; agentId: string; tokenHash: string },
): Promise<SandboxSession> {
  const { rows } = await db.query(
    `INSERT INTO sandbox_sessions (id, agent_id, token_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [data.id, data.agentId, data.tokenHash],
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
