import * as crypto from "node:crypto";

const TOKEN_PREFIX = "ses_";
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  userId: string;
  issuedAt: number;
}

/** In-memory session store. Good enough for single-user v1. */
const sessions = new Map<string, SessionEntry>();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function issueSession(userId: string): string {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const token = TOKEN_PREFIX + raw;
  const hash = hashToken(token);
  sessions.set(hash, { userId, issuedAt: Date.now() });
  return token;
}

export function revokeSession(token: string): boolean {
  const hash = hashToken(token);
  return sessions.delete(hash);
}

export function verifySession(token: string): string | null {
  const hash = hashToken(token);
  const entry = sessions.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > SESSION_TTL_MS) {
    sessions.delete(hash);
    return null;
  }
  return entry.userId;
}

/** Clears all sessions. For testing. */
export function clearSessions(): void {
  sessions.clear();
}
