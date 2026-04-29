import * as crypto from "node:crypto";
import { type Pool } from "@desk/db";
import { queries } from "@desk/db";
import { UnauthorizedError, type Agent, type SandboxSession } from "@desk/shared";

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
 */

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface SandboxAuth {
  session: SandboxSession;
  agent: Agent;
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
  return { session, agent };
}
