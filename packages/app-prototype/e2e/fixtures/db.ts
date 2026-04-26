import pg from "pg";

const ADMIN_BASE_URL =
  process.env.DESK_E2E_DATABASE_URL ??
  "postgresql://desk:desk@127.0.0.1:55432/postgres";

export function adminUrl(): string {
  return ADMIN_BASE_URL;
}

export function testDbUrl(dbName: string): string {
  const u = new URL(ADMIN_BASE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function createTestDatabase(dbName: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_BASE_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: testDbUrl(dbName) });
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } finally {
    await pool.end();
  }
}

export async function dropTestDatabase(dbName: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_BASE_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await admin.end();
  }
}
