import { Pool, createPool } from "../../src/pool.js";
import { runMigrations } from "../../src/migrate.js";

/**
 * Spins up a fresh, isolated SQLite database for a test file.
 *
 * Uses an in-memory database (`:memory:`) — no filesystem bytes, no
 * cross-test contamination, teardown is implicit. Tests that need
 * cross-connection visibility should override DESK_DB_PATH to a temp
 * file and skip this helper.
 */
export async function setupTestDb(): Promise<Pool> {
  const pool = createPool({ path: ":memory:" });
  await runMigrations(pool);
  return pool;
}

export async function teardownTestDb(pool: Pool): Promise<void> {
  await pool.end();
}
