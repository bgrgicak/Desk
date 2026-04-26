import * as crypto from "node:crypto";
import pg from "pg";
import {
  generateId,
  UnauthorizedError,
  type SandboxSession,
  type Agent,
} from "@desk/shared";
import { queries } from "@desk/db";

const TOKEN_PREFIX = "tok_";
const TOKEN_BYTES = 32; // 256 bits

/** Hash a plaintext token for storage. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a new sandbox session token for an agent+run pair.
 * Returns the plaintext token (only returned once).
 */
export async function issueSessionToken(
  pool: pg.Pool,
  agentId: string,
  opts?: { runId?: string; workspaceId?: string },
): Promise<{ token: string; session: SandboxSession }> {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const token = TOKEN_PREFIX + raw;
  const tokenHash = hashToken(token);
  const id = generateId("sandboxSession");

  const session = await queries.sandboxSessions.issue(pool, {
    id,
    agentId,
    workspaceId: opts?.workspaceId,
    tokenHash,
  });

  return { token, session };
}

/**
 * Revokes a session by its ID.
 */
export async function revokeSession(
  pool: pg.Pool,
  sessionId: string,
): Promise<void> {
  await queries.sandboxSessions.revoke(pool, sessionId);
}

export interface AuthResult {
  session: SandboxSession;
  agent: Agent;
}

/**
 * Authenticates a request by verifying the X-Desk-Sandbox-Token header.
 * Returns the session and the associated agent.
 */
export async function authenticate(
  pool: pg.Pool,
  headerValue: string | undefined,
): Promise<AuthResult> {
  if (!headerValue) {
    throw new UnauthorizedError("Missing X-Desk-Sandbox-Token header");
  }

  const tokenHash = hashToken(headerValue);
  const session = await queries.sandboxSessions.findByTokenHash(pool, tokenHash);
  if (!session) {
    throw new UnauthorizedError("Invalid or revoked sandbox token");
  }

  const agent = await queries.agents.findById(pool, session.agentId);
  if (!agent) {
    throw new UnauthorizedError("Agent not found for session");
  }

  return { session, agent };
}
