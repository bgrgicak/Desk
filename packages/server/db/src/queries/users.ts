import { type Pool } from "../pool.js";
import { UnauthorizedError, UserSchema, type User } from "@agent-desk/shared";
import { hashPassword, verifyPassword, isLegacyHash } from "../passwords.js";

function rowToUser(row: Record<string, unknown>): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    email: row.email,
    avatarPath: row.avatar_path ?? undefined,
    timezone: row.timezone ?? undefined,
    createdAt: row.created_at as string,
    mustChangePassword: row.must_change_password === 1 || row.must_change_password === true,
  });
}

export async function findById(db: Pool, id: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE id = ?", [id]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function findByUsername(db: Pool, username: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE username = ?", [username]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function findByEmail(db: Pool, email: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function insert(
  db: Pool,
  data: { id: string; username: string; passwordHash: string; email: string; avatarPath?: string },
): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (id, username, password_hash, email, avatar_path)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [data.id, data.username, data.passwordHash, data.email, data.avatarPath ?? null],
  );
  return rowToUser(rows[0]);
}

export async function updateProfile(
  db: Pool,
  id: string,
  data: { username?: string; email?: string; avatarPath?: string },
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.username !== undefined) {
    sets.push(`username = ?`);
    params.push(data.username);
  }
  if (data.email !== undefined) {
    sets.push(`email = ?`);
    params.push(data.email);
  }
  if (data.avatarPath !== undefined) {
    sets.push(`avatar_path = ?`);
    params.push(data.avatarPath);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function updatePassword(
  db: Pool,
  id: string,
  passwordHash: string,
): Promise<boolean> {
  // Clear must_change_password whenever the password changes — a successful
  // change means the user is no longer on the public seed credential. The
  // legacy-hash rehash path (login.ts) also goes through here, so anyone
  // logging in with a non-seed password also has the flag cleared even if
  // it was incorrectly set.
  const { rowCount } = await db.query(
    "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    [passwordHash, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Sets the user's IANA timezone if it differs from what's stored. No-op when
 * the value matches, so it's safe to call on every authed request from the
 * `X-Client-Timezone` header without a DB write storm.
 */
export async function setTimezoneIfChanged(
  db: Pool,
  id: string,
  timezone: string,
): Promise<void> {
  // The timezone value is bound twice — once for the SET, once in the
  // WHERE guard — so it's repeated in the params array.
  await db.query(
    `UPDATE users SET timezone = ?
     WHERE id = ? AND (timezone IS DISTINCT FROM ?)`,
    [timezone, id, timezone],
  );
}

export async function getPasswordHash(
  db: Pool,
  id: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT password_hash FROM users WHERE id = ?",
    [id],
  );
  return rows.length ? (rows[0].password_hash as string) : null;
}

/**
 * Authenticates by username + password. Returns the user on success, null on
 * bad username or password. Opportunistically rehashes legacy `plain:` entries
 * on successful login.
 */
export async function login(
  db: Pool,
  username: string,
  password: string,
): Promise<User | null> {
  const user = await findByUsername(db, username);
  if (!user) return null;

  const hash = await getPasswordHash(db, user.id);
  if (!hash) return null;

  if (!(await verifyPassword(hash, password))) return null;

  if (isLegacyHash(hash)) {
    const rehashed = await hashPassword(password);
    await updatePassword(db, user.id, rehashed);
  }

  return user;
}

/**
 * Changes a user's password. Verifies the current password before writing the
 * new argon2id hash. Throws UnauthorizedError when the current password is
 * wrong.
 */
export async function setPassword(
  db: Pool,
  id: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const hash = await getPasswordHash(db, id);
  if (!hash || !(await verifyPassword(hash, currentPassword))) {
    throw new UnauthorizedError("Current password is incorrect");
  }
  const rehashed = await hashPassword(newPassword);
  await updatePassword(db, id, rehashed);
}
