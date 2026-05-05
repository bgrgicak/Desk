import { type Pool } from "../pool.js";

export type AppScope = "chat" | "library";

export interface AppSession {
  id: string;
  userId: string;
  scope: AppScope;
  /** Null for library-scope sessions. */
  chatId: string | null;
  workspaceId: string;
  appName: string;
  capabilities: string[];
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

function rowToSession(row: Record<string, unknown>): AppSession {
  let capabilities: string[] = [];
  if (typeof row.capabilities === "string" && row.capabilities) {
    try {
      const parsed = JSON.parse(row.capabilities);
      if (Array.isArray(parsed)) {
        capabilities = parsed.filter((c): c is string => typeof c === "string");
      }
    } catch {
      // Treat malformed JSON as no capabilities — fail closed.
    }
  }
  return {
    id: String(row.id),
    userId: String(row.user_id),
    scope: row.scope as AppScope,
    chatId: row.chat_id ? String(row.chat_id) : null,
    workspaceId: String(row.workspace_id),
    appName: String(row.app_name),
    capabilities,
    tokenHash: String(row.token_hash),
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

export async function issue(
  db: Pool,
  data: {
    id: string;
    userId: string;
    scope: AppScope;
    chatId: string | null;
    workspaceId: string;
    appName: string;
    capabilities: string[];
    tokenHash: string;
    expiresAt: Date;
  },
): Promise<AppSession> {
  const { rows } = await db.query(
    `INSERT INTO app_sessions
       (id, user_id, scope, chat_id, workspace_id, app_name, capabilities, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      data.id,
      data.userId,
      data.scope,
      data.chatId,
      data.workspaceId,
      data.appName,
      JSON.stringify(data.capabilities),
      data.tokenHash,
      data.expiresAt.toISOString(),
    ],
  );
  return rowToSession(rows[0]);
}

/**
 * Verifies an app-session token. Returns the session if the row exists,
 * is non-revoked, and hasn't expired. Otherwise returns null. Path-scope
 * check (chat + appName) is the caller's responsibility — `verify` only
 * resolves the token to a session row.
 */
export async function verify(
  db: Pool,
  tokenHash: string,
): Promise<AppSession | null> {
  const { rows } = await db.query(
    `SELECT * FROM app_sessions
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const session = rowToSession(rows[0]);
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await db.query("DELETE FROM app_sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }
  return session;
}

export async function revoke(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE app_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND revoked_at IS NULL`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteExpired(db: Pool): Promise<number> {
  const result = await db.query(
    `DELETE FROM app_sessions WHERE expires_at < ?`,
    [new Date().toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function deleteAll(db: Pool): Promise<void> {
  await db.query("DELETE FROM app_sessions");
}
