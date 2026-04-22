import pg from "pg";
import { queries } from "@desk/db";
import { NotFoundError, UnauthorizedError } from "@desk/shared";

export async function getMe(pool: pg.Pool, userId: string) {
  const user = await queries.users.findById(pool, userId);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function patchMe(
  pool: pg.Pool,
  userId: string,
  data: { username?: string; email?: string; avatarPath?: string },
) {
  const user = await queries.users.updateProfile(pool, userId, data);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function changePassword(
  pool: pg.Pool,
  userId: string,
  data: { currentPassword: string; newPassword: string },
) {
  const hash = await queries.users.getPasswordHash(pool, userId);
  // v1: plain-text comparison (prefix "plain:"), matching handleLogin.
  if (!hash || hash !== `plain:${data.currentPassword}`) {
    throw new UnauthorizedError("Current password is incorrect");
  }
  await queries.users.updatePassword(pool, userId, `plain:${data.newPassword}`);
  return { ok: true };
}

/**
 * Soft-delete current account. v1: no-op stub — records the intent but
 * does not actually remove data.
 */
export async function deleteMe(
  _pool: pg.Pool,
  _userId: string,
): Promise<{ ok: true; message: string }> {
  return { ok: true, message: "Account marked for deletion" };
}
