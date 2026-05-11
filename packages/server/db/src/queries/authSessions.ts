import { type Pool } from "../pool.js";

export async function insert(
  db: Pool,
  data: { tokenHash: string; userId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO auth_sessions (token_hash, user_id)
     VALUES (?, ?)`,
    [data.tokenHash, data.userId],
  );
}

/**
 * Look up a session by its hashed token. Returns userId iff the row exists
 * and is younger than `ttlMs`. Expired rows are deleted lazily here so a
 * compromised token can't be reused even if the cleanup job is paused.
 */
export async function verify(
  db: Pool,
  tokenHash: string,
  ttlMs: number,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT user_id, issued_at FROM auth_sessions WHERE token_hash = ?`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const issuedAt = new Date(rows[0].issued_at as string).getTime();
  if (Date.now() - issuedAt > ttlMs) {
    await db.query(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash]);
    return null;
  }
  return rows[0].user_id as string;
}

export async function deleteByTokenHash(
  db: Pool,
  tokenHash: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM auth_sessions WHERE token_hash = ?`,
    [tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteAll(db: Pool): Promise<void> {
  await db.query(`DELETE FROM auth_sessions`);
}

/**
 * Count active (non-expired) sessions for a user. Powers the
 * "lock the vault when the last session logs out" check.
 */
export async function countActiveByUserId(
  db: Pool,
  userId: string,
  ttlMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM auth_sessions
     WHERE user_id = ? AND issued_at >= ?`,
    [userId, cutoff],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Bulk-delete rows older than the TTL. Cheap to run at boot. */
export async function deleteExpired(
  db: Pool,
  ttlMs: number,
): Promise<number> {
  // SQLite has no INTERVAL type — express the TTL as a strftime offset.
  // Negative number → subtract from `now`, gives us the "issued before"
  // cutoff in the same ISO 8601 format the column uses.
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const result = await db.query(
    `DELETE FROM auth_sessions WHERE issued_at < ?`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}
