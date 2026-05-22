import { type Pool } from "../pool.js";
import { SandboxSessionSchema, type SandboxSession } from "@roomy-ai/shared";

function rowToSandboxSession(row: Record<string, unknown>): SandboxSession {
  return SandboxSessionSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at as string,
    revokedAt: row.revoked_at ? row.revoked_at as string : undefined,
  });
}

export async function issue(
  db: Pool,
  data: { id: string; agentId: string; runId?: string; workspaceId?: string; tokenHash: string },
): Promise<SandboxSession> {
  const { rows } = await db.query(
    `INSERT INTO sandbox_sessions (id, agent_id, run_id, workspace_id, token_hash)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [data.id, data.agentId, data.runId ?? null, data.workspaceId ?? null, data.tokenHash],
  );
  return rowToSandboxSession(rows[0]);
}

export async function findByTokenHash(
  db: Pool,
  tokenHash: string,
): Promise<SandboxSession | null> {
  const { rows } = await db.query(
    "SELECT * FROM sandbox_sessions WHERE token_hash = ? AND revoked_at IS NULL",
    [tokenHash],
  );
  return rows.length ? rowToSandboxSession(rows[0]) : null;
}

export async function revoke(db: Pool, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE sandbox_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL",
    [id],
  );
  return (rowCount ?? 0) > 0;
}
