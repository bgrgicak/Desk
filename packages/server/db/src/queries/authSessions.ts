import pg from "pg";

type Queryable = pg.Pool | pg.PoolClient;

export async function insert(
  db: Queryable,
  data: { tokenHash: string; userId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO auth_sessions (token_hash, user_id)
     VALUES ($1, $2)`,
    [data.tokenHash, data.userId],
  );
}

/**
 * Look up a session by its hashed token. Returns userId iff the row exists
 * and is younger than `ttlMs`. Expired rows are deleted lazily here so a
 * compromised token can't be reused even if the cleanup job is paused.
 */
export async function verify(
  db: Queryable,
  tokenHash: string,
  ttlMs: number,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT user_id, issued_at FROM auth_sessions WHERE token_hash = $1`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const issuedAt = (rows[0].issued_at as Date).getTime();
  if (Date.now() - issuedAt > ttlMs) {
    await db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [tokenHash]);
    return null;
  }
  return rows[0].user_id as string;
}

export async function deleteByTokenHash(
  db: Queryable,
  tokenHash: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM auth_sessions WHERE token_hash = $1`,
    [tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteAll(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM auth_sessions`);
}

/** Bulk-delete rows older than the TTL. Cheap to run at boot. */
export async function deleteExpired(
  db: Queryable,
  ttlMs: number,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM auth_sessions
      WHERE issued_at < now() - ($1::bigint || ' milliseconds')::interval`,
    [ttlMs],
  );
  return result.rowCount ?? 0;
}
