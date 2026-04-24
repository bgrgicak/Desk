import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty } from "@desk/db";
import { generateId } from "@desk/shared";
import { ensureLayout, ensureWorkspaceLayout } from "../../src/layout.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_storage_test_${workerId}`;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}

function adminConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: adminConnectionString() });
}

export interface TestStorageContext {
  pool: pg.Pool;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  chatId: string;
}

export async function setupTestStorage(): Promise<TestStorageContext> {
  // Create test database
  const admin = adminPool();
  try {
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

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch {
    // May not be available
  }

  await runMigrations(pool);

  // Seed default data
  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  // Get workspace and create a chat for tests
  const { rows: wsRows } = await pool.query("SELECT id, path FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  const workspaceSlug = wsRows[0].path as string;

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  // Ensure the seeded agent is enrolled in the workspace (M3 invariant)
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id, agent_id) DO NOTHING`,
    [workspaceId, agentId],
  );

  const chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Test Chat"],
  );

  // Create temp home directory
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-storage-test-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, workspaceSlug);

  return { pool, home, workspaceId, workspaceSlug, chatId };
}

export async function teardownTestStorage(ctx: TestStorageContext): Promise<void> {
  if (!ctx) return;
  await ctx.pool.end();

  // Clean up temp home
  await fs.rm(ctx.home, { recursive: true, force: true });

  // Drop test database
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
