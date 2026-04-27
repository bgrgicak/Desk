import pg from "pg";

type Queryable = pg.Pool | pg.PoolClient;

export type KeyAccessAction = "read" | "write" | "delete";

export interface KeyAccessEntry {
  id: string;
  userId: string;
  action: KeyAccessAction;
  providers: string[];
  reason: string | null;
  createdAt: Date;
}

export async function logKeyAccess(
  db: Queryable,
  userId: string,
  action: KeyAccessAction,
  providers: string[],
  reason?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO provider_key_access_log (user_id, action, providers, reason)
     VALUES ($1, $2, $3, $4)`,
    [userId, action, providers, reason ?? null],
  );
}

export async function getKeyAccessLog(
  db: Queryable,
  userId: string,
  limit = 100,
): Promise<KeyAccessEntry[]> {
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    action: KeyAccessAction;
    providers: string[];
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, action, providers, reason, created_at
     FROM provider_key_access_log
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    action: r.action,
    providers: r.providers,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}
