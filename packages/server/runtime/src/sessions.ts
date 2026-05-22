import * as crypto from "node:crypto";
import { type Pool } from "@agent-desk/db";
import { generateId, type SandboxSession } from "@agent-desk/shared";
import { queries } from "@agent-desk/db";

/**
 * Per-run sandbox session tokens. The runtime mints one before invoking
 * pi and revokes it after the run finishes. The token is passed into
 * the container as `DESK_SANDBOX_TOKEN`; the `desk` CLI forwards it to the
 * REST API as `X-Desk-Sandbox-Token`. Server-side verification lives in
 * `packages/server/api/src/auth/sandboxToken.ts`.
 */

const TOKEN_PREFIX = "tok_";
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function mintToken(
  pool: Pool,
  agentId: string,
  opts?: { runId?: string; workspaceId?: string },
): Promise<{ token: string; session: SandboxSession }> {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const token = TOKEN_PREFIX + raw;
  const session = await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    runId: opts?.runId,
    workspaceId: opts?.workspaceId,
    tokenHash: hashToken(token),
  });
  return { token, session };
}

export async function revokeToken(
  pool: Pool,
  sessionId: string,
): Promise<void> {
  await queries.sandboxSessions.revoke(pool, sessionId);
}
