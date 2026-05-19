import { type IncomingMessage } from "node:http";
import { type Pool } from "@agent-desk/db";
import { UnauthorizedError } from "@agent-desk/shared";
import { verifySession } from "./sessions.js";

/**
 * The /apps/* dispatcher's `issue` endpoint runs after requireAuth has
 * already let the path through (no global Bearer check on /apps/*). This
 * helper re-applies the Bearer check locally so the issue endpoint
 * cannot mint app-session tokens without a valid user session.
 *
 * Lives next to the rest of the auth helpers — it's an auth check
 * rather than a generic HTTP utility.
 */
export async function requireBearerForApps(pool: Pool, req: IncomingMessage): Promise<string> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }
  const userId = await verifySession(pool, auth.slice(7));
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired session token");
  }
  return userId;
}
