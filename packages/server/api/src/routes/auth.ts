import pg from "pg";
import { queries } from "@desk/db";
import { UnauthorizedError } from "@desk/shared";
import { issueSession, revokeSession } from "../auth/sessions.js";

export async function handleLogin(
  pool: pg.Pool,
  body: { username: string; password: string },
): Promise<{ token: string }> {
  const user = await queries.users.findByUsername(pool, body.username);
  if (!user) throw new UnauthorizedError("Invalid credentials");

  const hash = await queries.users.getPasswordHash(pool, user.id);
  // v1: plain-text password comparison (prefix "plain:")
  if (!hash || hash !== `plain:${body.password}`) {
    throw new UnauthorizedError("Invalid credentials");
  }

  const token = issueSession(user.id);
  return { token };
}

export function handleLogout(authHeader: string | undefined): { ok: boolean } {
  if (authHeader?.startsWith("Bearer ")) {
    revokeSession(authHeader.slice(7));
  }
  return { ok: true };
}
