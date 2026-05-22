import * as crypto from "node:crypto";
import { type Pool } from "@roomy-ai/db";
import { queries } from "@roomy-ai/db";

const TOKEN_PREFIX = "ses_";
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bearer-token hash. Exported so call sites that need to look up by
 * token (handleLogout) reuse the same hashing rule instead of
 * re-implementing it. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueSession(
  pool: Pool,
  userId: string,
): Promise<string> {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const token = TOKEN_PREFIX + raw;
  await queries.authSessions.insert(pool, {
    tokenHash: hashToken(token),
    userId,
  });
  return token;
}

export async function revokeSession(
  pool: Pool,
  token: string,
): Promise<boolean> {
  return queries.authSessions.deleteByTokenHash(pool, hashToken(token));
}

export async function verifySession(
  pool: Pool,
  token: string,
): Promise<string | null> {
  return queries.authSessions.verify(pool, hashToken(token), SESSION_TTL_MS);
}

/**
 * Server-startup hook: drop rows past the TTL so the table doesn't grow
 * unbounded. Lazy-deletion in verifySession() handles the hot path; this
 * keeps the cold tail tidy.
 */
export async function pruneExpiredSessions(pool: Pool): Promise<number> {
  return queries.authSessions.deleteExpired(pool, SESSION_TTL_MS);
}

/** Clears all sessions. For testing. */
export async function clearSessions(pool: Pool): Promise<void> {
  await queries.authSessions.deleteAll(pool);
}
