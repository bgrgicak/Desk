import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { runMigrations, insertSeedFixture } from "@roomy-ai/db";
import { generateId } from "@roomy-ai/shared";
import { ensureLayout, ensureWorkspaceLayout } from "../../src/layout.js";

export interface TestStorageContext {
  pool: Pool;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  chatId: string;
  /** Temp dir holding the SQLite file — removed during teardown. */
  dbDir: string;
}

export async function setupTestStorage(): Promise<TestStorageContext> {
  // Per-test-file SQLite file so workers don't collide on the same DB.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-storage-test-db-"));
  const dbPath = path.join(dbDir, "test.sqlite3");
  const pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  // Seed default data
  await insertSeedFixture(pool, { username: "testuser", password: "testpass" });

  // Get workspace and create a chat for tests
  const { rows: wsRows } = await pool.query("SELECT id, path FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;
  const workspaceSlug = wsRows[0].path as string;

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  // Ensure the seeded agent is enrolled in the workspace (M3 invariant)
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?)
     ON CONFLICT (workspace_id, agent_id) DO NOTHING`,
    [workspaceId, agentId],
  );

  const chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Test Chat"],
  );

  // Create temp home directory
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-storage-test-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, workspaceSlug);

  return { pool, home, workspaceId, workspaceSlug, chatId, dbDir };
}

export async function teardownTestStorage(ctx: TestStorageContext): Promise<void> {
  if (!ctx) return;
  await ctx.pool.end();

  // Clean up temp home and DB dir.
  await fs.rm(ctx.home, { recursive: true, force: true });
  await fs.rm(ctx.dbDir, { recursive: true, force: true });
}
