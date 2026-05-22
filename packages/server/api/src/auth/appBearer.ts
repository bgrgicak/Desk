import { type IncomingMessage } from "node:http";
import { type Pool } from "@roomy-ai/db";
import { UnauthorizedError } from "@roomy-ai/shared";
import { verifySession } from "./sessions.js";
import { enforceMustChangePassword } from "./middleware.js";

/**
 * The /apps/* dispatcher's `issue` endpoint runs after requireAuth has
 * already let the path through (no global Bearer check on /apps/*).
 * This helper re-applies the Bearer check locally so the issue
 * endpoint cannot mint app-session tokens without a valid user
 * session.
 *
 * Also re-applies the must-change-password gate.  The global
 * middleware skips /apps/* (so static-app cookie reads can hit the
 * dist routes), which means without this call a user still on the
 * documented public seed credential could mint app-session tokens
 * or access app dist routes even though the rest of the API refuses
 * them.  `enforceMustChangePassword` throws a `RoomyError(FORBIDDEN)`
 * that the dispatcher's catch maps to 403, matching how the
 * non-/apps routes behave.
 *
 * Lives next to the rest of the auth helpers — it's an auth check
 * rather than a generic HTTP utility.
 */
export async function requireBearerForApps(
  pool: Pool,
  req: IncomingMessage,
  opts?: { method?: string; path?: string },
): Promise<string> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }
  const userId = await verifySession(pool, auth.slice(7));
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired session token");
  }
  await enforceMustChangePassword(
    pool,
    userId,
    opts?.method ?? "GET",
    opts?.path ?? "/apps",
  );
  return userId;
}
