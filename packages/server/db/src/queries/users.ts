import pg from "pg";
import { UserSchema, type User } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToUser(row: Record<string, unknown>): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    email: row.email,
    avatarPath: row.avatar_path ?? undefined,
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
