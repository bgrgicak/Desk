import pg from "pg";
import type { SandboxSession } from "@desk/shared";
import { issueSessionToken, revokeSession } from "@desk/tools";

/**
 * Thin wrapper around @desk/tools session management.
 * Keeps runtime code from touching the DB directly for sessions.
 */

export async function mintToken(
  pool: pg.Pool,
  agentId: string,
  opts?: { runId?: string; workspaceId?: string },
): Promise<{ token: string; session: SandboxSession }> {
  return issueSessionToken(pool, agentId, opts);
}

export async function revokeToken(
  pool: pg.Pool,
  sessionId: string,
): Promise<void> {
  return revokeSession(pool, sessionId);
}
