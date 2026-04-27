import pg from "pg";
import { UnauthorizedError, UserSchema, type User } from "@desk/shared";
import { hashPassword, verifyPassword, isLegacyHash } from "../passwords.js";

type Queryable = pg.Pool | pg.PoolClient;

function rowToUser(row: Record<string, unknown>): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    email: row.email,
    avatarPath: row.avatar_path ?? undefined,
    timezone: row.timezone ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
  });
}

export async function findById(db: Queryable, id: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function findByUsername(db: Queryable, username: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE username = $1", [username]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function findByEmail(db: Queryable, email: string): Promise<User | null> {
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function insert(
  db: Queryable,
  data: { id: string; username: string; passwordHash: string; email: string; avatarPath?: string },
): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (id, username, password_hash, email, avatar_path)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.id, data.username, data.passwordHash, data.email, data.avatarPath ?? null],
  );
  return rowToUser(rows[0]);
}

export async function updateProfile(
  db: Queryable,
  id: string,
  data: { username?: string; email?: string; avatarPath?: string },
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.username !== undefined) {
    sets.push(`username = $${idx++}`);
    params.push(data.username);
  }
  if (data.email !== undefined) {
    sets.push(`email = $${idx++}`);
    params.push(data.email);
  }
  if (data.avatarPath !== undefined) {
    sets.push(`avatar_path = $${idx++}`);
    params.push(data.avatarPath);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function updatePassword(
  db: Queryable,
  id: string,
  passwordHash: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE users SET password_hash = $1 WHERE id = $2",
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
  db: Queryable,
  id: string,
  timezone: string,
): Promise<void> {
  await db.query(
    `UPDATE users SET timezone = $1
     WHERE id = $2 AND (timezone IS DISTINCT FROM $1)`,
    [timezone, id],
  );
}

export async function getPasswordHash(
  db: Queryable,
  id: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT password_hash FROM users WHERE id = $1",
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
  db: Queryable,
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
  db: Queryable,
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
