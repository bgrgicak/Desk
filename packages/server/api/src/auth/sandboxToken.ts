import * as crypto from "node:crypto";
import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  UnauthorizedError,
  type Agent,
  type SandboxSession,
  type Workspace,
} from "@agent-desk/shared";
import type { WorkspaceScope } from "../workspace-scope.js";

/**
 * Sandbox session tokens authenticate requests from inside an pi run
 * back to the desk-server REST API. The runtime mints one token per run and
 * passes it into the container as `DESK_SANDBOX_TOKEN`. The `desk` CLI
 * forwards it as `X-Desk-Sandbox-Token` on each request.
 *
 * Tokens hash to a row in `sandbox_sessions` (issued by runtime/sessions.ts).
 * `authenticateSandboxToken` resolves the header to (session, agent), and
 * the agent's `userId` is what callers feed into the existing ownership
 * checks (`requireOwnedChat`, etc.).
 *
 * The resolved `WorkspaceScope` is the same shape the user-facing API
 * uses — `single` for project-workspace runs, `owned` for hub runs. This
 * is the boundary where "the agent is running in the hub" turns into
 * "the agent's HTTP requests can read across all the user's workspaces."
 */

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface SandboxAuth {
  session: SandboxSession;
  agent: Agent;
  /** The workspace this run belongs to. Absent when the workspace has
   *  been deleted after the token was minted, or for very old sessions
   *  that predate the multi-workspace split. */
  workspace?: Workspace;
  scope: WorkspaceScope;
}

export async function authenticateSandboxToken(
  pool: Pool,
  headerValue: string | undefined,
): Promise<SandboxAuth> {
  if (!headerValue) {
    throw new UnauthorizedError("Missing X-Desk-Sandbox-Token header");
  }
  const session = await queries.sandboxSessions.findByTokenHash(pool, hashToken(headerValue));
  if (!session) {
    throw new UnauthorizedError("Invalid or revoked sandbox token");
  }
  const agent = await queries.agents.findById(pool, session.agentId);
  if (!agent) {
    throw new UnauthorizedError("Agent not found for sandbox session");
  }
  if (!session.workspaceId) {
    // Pre-multi-workspace sessions had no workspace pin. Granting any scope
    // here would either silently widen access (`owned`) or hand out a
    // single-scope with no target. Reject so the caller re-mints a current
    // token instead of inheriting whatever the historical implementation
    // happened to do.
    throw new UnauthorizedError("Sandbox token has no workspace; re-authenticate");
  }
  const ws = await queries.workspaces.findById(pool, session.workspaceId);
  const workspace: Workspace | undefined = ws ?? undefined;
  // Cross-user safety: a session must belong to a workspace owned by the
  // session's agent's user. A workspace whose owner has diverged from the
  // agent's user (e.g. workspace reassigned, agent moved between users)
  // is treated as untrusted.
  if (ws && ws.userId !== agent.userId) {
    throw new UnauthorizedError("Sandbox token is for a workspace the agent no longer owns");
  }
  const scope: WorkspaceScope =
    ws && ws.kind === "hub"
      ? { kind: "owned", userId: agent.userId }
      : { kind: "single", userId: agent.userId, workspaceId: session.workspaceId };
  return { session, agent, workspace, scope };
}
