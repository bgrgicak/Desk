import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "../src/pool.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";

let pool: Pool;

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
  "auth_sessions",
  "provider_key_access_log",
];

// Postgres-era tables that no longer exist (M4, M6 dropped them).
const droppedTables = ["files", "runs", "run_events", "scheduled_jobs"];

describe("migrations", () => {
  it("creates all expected tables", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const tableNames = rows.map((r) => r.name);
    for (const t of expectedTables) {
      expect(tableNames).toContain(t);
    }
    for (const t of droppedTables) {
      expect(tableNames).not.toContain(t);
    }
  });

  it("does not leave secret-key encrypted metadata columns in the schema", async () => {
    const userSettingsCols = await pool.query<{ name: string }>("SELECT name FROM pragma_table_info('user_settings')");
    const userSettingsNames = userSettingsCols.rows.map((r) => r.name);
    expect(userSettingsNames).toContain("provider_meta_json");
    expect(userSettingsNames).not.toContain("provider_keys_encrypted");
    expect(userSettingsNames).not.toContain("provider_meta_encrypted");

    const connectionCols = await pool.query<{ name: string }>("SELECT name FROM pragma_table_info('connector_connections')");
    const connectionNames = connectionCols.rows.map((r) => r.name);
    expect(connectionNames).toContain("metadata_json");
    expect(connectionNames).not.toContain("credentials_encrypted");
    expect(connectionNames).not.toContain("metadata_encrypted");
  });

  it("creates composite indexes", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
    );
    const indexNames = rows.map((r) => r.name);
    expect(indexNames).toContain("idx_chats_workspace_updated");
    expect(indexNames).toContain("idx_messages_chat_created");
    // Postgres-only trgm GIN indexes were dead code on the Postgres side
    // (search ran via ILIKE) and have no SQLite equivalent. They were
    // dropped when porting the schema.
    expect(indexNames).not.toContain("idx_chats_title_trgm");
    expect(indexNames).not.toContain("idx_messages_content_text_trgm");
    expect(indexNames).not.toContain("idx_files_workspace_class_created");
  });

  it("is idempotent (running again does not error)", async () => {
    const { runMigrations } = await import("../src/migrate.js");
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });

  it("schema is byte-identical after re-running migrations", async () => {
    // Capture the post-first-run schema (CREATE TABLE / INDEX / TRIGGER /
    // VIEW statements as SQLite stores them in sqlite_master). Then run
    // the migration set again and compare. Any drift is a real bug —
    // migrations are forward-only and re-running on a populated DB
    // must be a no-op. The simpler idempotency test above only checks
    // for the absence of an error, which doesn't catch silent
    // re-application of an ALTER.
    const { runMigrations } = await import("../src/migrate.js");
    const captureSchema = async (): Promise<string[]> => {
      const { rows } = await pool.query<{ type: string; name: string; sql: string | null }>(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      );
      return rows.map((r) => `${r.type}:${r.name}\n${r.sql ?? ""}`);
    };
    const before = await captureSchema();
    await runMigrations(pool);
    await runMigrations(pool);
    const after = await captureSchema();
    expect(after).toEqual(before);
  });
});
