import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

const expectedTables = [
  "users",
  "user_settings",
  "agents",
  "workspaces",
  "workspace_agents",
  "chats",
  "messages",
  "sandbox_sessions",
  "schema_migrations",
];

// M4 dropped files; M6 dropped runs/scheduled_jobs/run_events.
const droppedTables = ["files", "runs", "run_events", "scheduled_jobs"];

describe("migrations", () => {
  it("creates all expected tables", async () => {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const tableNames = rows.map((r) => r.tablename);
    for (const t of expectedTables) {
      expect(tableNames).toContain(t);
    }
    // Verify the files table is actually gone (M4 drop).
    for (const t of droppedTables) {
      expect(tableNames).not.toContain(t);
    }
  });

  it("creates composite indexes", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    );
    const indexNames = rows.map((r) => r.indexname);
    expect(indexNames).toContain("idx_chats_workspace_updated");
    expect(indexNames).toContain("idx_messages_chat_created");
    // files, runs, scheduled_jobs, run_events indexes all gone with their tables.
    expect(indexNames).not.toContain("idx_files_workspace_class_created");
    expect(indexNames).not.toContain("idx_files_name_trgm");
    expect(indexNames).not.toContain("idx_run_events_run_seq");
  });

  it("creates pg_trgm GIN indexes for chats and messages", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    );
    const indexNames = rows.map((r) => r.indexname);
    expect(indexNames).toContain("idx_chats_title_trgm");
    expect(indexNames).toContain("idx_messages_content_text_trgm");
  });

  it("is idempotent (running again does not error)", async () => {
    const { runMigrations } = await import("../src/migrate.js");
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });
});
