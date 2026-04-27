import * as crypto from "node:crypto";
import pg from "pg";
import { queries } from "@desk/db";

const TOKEN_PREFIX = "ses_";
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueSession(
  pool: pg.Pool,
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
  pool: pg.Pool,
  token: string,
): Promise<boolean> {
  return queries.authSessions.deleteByTokenHash(pool, hashToken(token));
}

export async function verifySession(
  pool: pg.Pool,
  token: string,
): Promise<string | null> {
  return queries.authSessions.verify(pool, hashToken(token), SESSION_TTL_MS);
}

/**
 * Server-startup hook: drop rows past the TTL so the table doesn't grow
 * unbounded. Lazy-deletion in verifySession() handles the hot path; this
 * keeps the cold tail tidy.
 */
export async function pruneExpiredSessions(pool: pg.Pool): Promise<number> {
  return queries.authSessions.deleteExpired(pool, SESSION_TTL_MS);
}

/** Clears all sessions. For testing. */
export async function clearSessions(pool: pg.Pool): Promise<void> {
  await queries.authSessions.deleteAll(pool);
}
