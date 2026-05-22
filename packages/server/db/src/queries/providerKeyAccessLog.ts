import { type Pool } from "../pool.js";

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
  db: Pool,
  userId: string,
  action: KeyAccessAction,
  providers: string[],
  reason?: string,
): Promise<void> {
  // SQLite stores arrays as JSON text — stringify at the boundary so the
  // column always holds a valid JSON array (matched by the column DEFAULT
  // '[]' and by the array deserialization in getKeyAccessLog).
  await db.query(
    `INSERT INTO provider_key_access_log (user_id, action, providers, reason)
     VALUES (?, ?, ?, ?)`,
    [userId, action, JSON.stringify(providers), reason ?? null],
  );
}

/**
 * Drops audit log rows older than `olderThanDays`. Returns the number
 * of rows deleted. Called by the daily retention reaper in main.ts;
 * provider_key_access_log has no upper bound otherwise and a long-
 * running install accumulates a row per sandbox env injection.
 *
 * Default retention (90 days) is documented in SECURITY.md. Operators
 * who want longer history bump ROOMY_KEY_ACCESS_LOG_RETENTION_DAYS.
 */
export async function pruneKeyAccessLog(
  db: Pool,
  olderThanDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const { rowCount } = await db.query(
    `DELETE FROM provider_key_access_log WHERE created_at < ?`,
    [cutoff],
  );
  return rowCount;
}

export async function getKeyAccessLog(
  db: Pool,
  userId: string,
  limit = 100,
): Promise<KeyAccessEntry[]> {
  const { rows } = await db.query<{
    id: string | number;
    user_id: string;
    action: KeyAccessAction;
    providers: string;
    reason: string | null;
    created_at: string;
  }>(
    // Tie-break by id DESC so concurrent inserts within the same millisecond
    // (common in tests, possible under load) sort deterministically by
    // insertion order — the AUTOINCREMENT id is monotonic.
    `SELECT id, user_id, action, providers, reason, created_at
     FROM provider_key_access_log
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    userId: r.user_id,
    action: r.action,
    providers: JSON.parse(r.providers) as string[],
    reason: r.reason,
    createdAt: new Date(r.created_at),
  }));
}
