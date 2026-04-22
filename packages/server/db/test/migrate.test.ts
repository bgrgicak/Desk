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
  "runs",
  "run_events",
  "scheduled_jobs",
  "sandbox_sessions",
  "schema_migrations",
];

const droppedTables = ["files"];

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
    expect(indexNames).toContain("idx_run_events_run_seq");
    // files indexes are gone along with the table.
    expect(indexNames).not.toContain("idx_files_workspace_class_created");
    expect(indexNames).not.toContain("idx_files_name_trgm");
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
