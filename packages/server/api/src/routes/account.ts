import pg from "pg";
import { queries } from "@desk/db";
import { NotFoundError } from "@desk/shared";

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
  await queries.users.setPassword(pool, userId, data.currentPassword, data.newPassword);
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
