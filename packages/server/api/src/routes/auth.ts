import pg from "pg";
import { queries } from "@desk/db";
import { UnauthorizedError } from "@desk/shared";
import { issueSession, revokeSession } from "../auth/sessions.js";

export async function handleLogin(
  pool: pg.Pool,
  body: { username: string; password: string },
): Promise<{ token: string }> {
  const user = await queries.users.login(pool, body.username, body.password);
  if (!user) throw new UnauthorizedError("Invalid credentials");

  const token = issueSession(user.id);
  return { token };
}

export function handleLogout(authHeader: string | undefined): { ok: boolean } {
  if (authHeader?.startsWith("Bearer ")) {
    revokeSession(authHeader.slice(7));
  }
  return { ok: true };
}
