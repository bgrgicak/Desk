import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_test_${workerId}`;

/**
 * Derives an admin connection string from DATABASE_URL / DESK_TEST_DATABASE_URL.
 * Replaces the database name with "postgres" so we can CREATE/DROP test databases.
 */
function adminConnectionString(): string {
  const base = process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

/** Builds a connection string for the per-worker test database. */
function testConnectionString(): string {
  const base = process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
  const url = new URL(base);
  url.pathname = `/${testDbName}`;
  return url.toString();
}

function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: adminConnectionString() });
}

export async function setupTestDb(): Promise<pg.Pool> {
  const admin = adminPool();
  try {
    // Terminate existing connections so we can drop cleanly
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: testConnectionString() });

  // Enable pg_trgm for the test DB (requires superuser or CREATE extension privilege)
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch {
    // pg_trgm may not be available in the test environment; migrations will fail
    // on the GIN indexes if so, but the test harness will report the real error.
  }

  await runMigrations(pool);
  return pool;
}

export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  await pool.end();

  const admin = adminPool();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
}
