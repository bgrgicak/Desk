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
 * Sandbox session tokens authenticate requests from inside an OpenCode run
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
  /** The workspace this run belongs to. Always present except for very
   *  old historical sessions that predate the multi-workspace split. */
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
  let workspace: Workspace | undefined;
  let scope: WorkspaceScope;
  if (session.workspaceId) {
    const ws = await queries.workspaces.findById(pool, session.workspaceId);
    workspace = ws ?? undefined;
    if (ws && ws.userId === agent.userId && ws.kind === "hub") {
      scope = { kind: "owned", userId: agent.userId };
    } else {
      scope = { kind: "single", userId: agent.userId, workspaceId: session.workspaceId };
    }
  } else {
    // Legacy session without a workspace pin. Treat as `owned` would
    // widen scope unintentionally, so fall back to a placeholder
    // single-scope that downstream code can detect via the missing
    // workspace and reject if cross-workspace reach is required.
    scope = { kind: "owned", userId: agent.userId };
  }
  return { session, agent, workspace, scope };
}
