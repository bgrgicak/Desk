import * as crypto from "node:crypto";
import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { UnauthorizedError } from "@agent-desk/shared";
import { issueSession, revokeSession } from "../auth/sessions.js";
import type { VaultStore } from "../vault/store.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function handleLogin(
  pool: Pool,
  body: { username: string; password: string },
): Promise<{ token: string }> {
  const user = await queries.users.login(pool, body.username, body.password);
  if (!user) throw new UnauthorizedError("Invalid credentials");

  const token = await issueSession(pool, user.id);
  return { token };
}

/**
 * Logout — revokes the bearer token and, when no live sessions remain
 * for the same user, locks that user's secrets vault so the in-memory
 * master is dropped. Multi-device users keep the vault unlocked while
 * any session is alive.
 */
export async function handleLogout(
  pool: Pool,
  vault: VaultStore,
  authHeader: string | undefined,
): Promise<{ ok: boolean }> {
  if (!authHeader?.startsWith("Bearer ")) return { ok: true };
  const token = authHeader.slice(7);

  // Resolve the userId from the token before we revoke it — once revoked,
  // the row is gone and we can't look up "who was that?". The hash has
  // to be computed identically to issueSession.
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT user_id FROM auth_sessions WHERE token_hash = ?`,
    [tokenHash],
  );
  const userId = rows.length ? (rows[0].user_id as string) : null;

  await revokeSession(pool, token);

  if (userId) {
    const remaining = await queries.authSessions.countActiveByUserId(
      pool,
      userId,
      SESSION_TTL_MS,
    );
    if (remaining === 0) {
      vault.lock(userId);
    }
  }
  return { ok: true };
}
