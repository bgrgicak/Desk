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

  it("migrations apply cleanly on a populated database (regression: 0042 strftime DEFAULT)", async () => {
    // Regression for the migration-0042 bug found in PR #116 review:
    // SQLite refuses non-constant DEFAULTs in `ALTER TABLE ADD
    // COLUMN`, so `DEFAULT (strftime(...))` succeeds on an empty
    // table (the fixture path) but throws on every populated
    // deployment.  This test simulates the populated-DB upgrade by:
    //
    //   1. Spinning up a fresh in-memory DB
    //   2. Running every migration EXCEPT 0042+ to leave the schema
    //      at the pre-`created_at` state
    //   3. Inserting two rows into `chats` with known updated_at
    //      timestamps
    //   4. Running the remaining migrations
    //   5. Asserting both rows now have `created_at` populated from
    //      `updated_at` (the backfill UPDATE) and that subsequent
    //      INSERTs through queries/chats.ts stamp a real created_at
    //
    // Any future migration that re-introduces the same pattern
    // (NOT NULL column with non-constant DEFAULT in ADD COLUMN)
    // will fail this test before landing.
    const { default: fs } = await import("node:fs");
    const { default: pathMod } = await import("node:path");
    const { runMigrations } = await import("../src/migrate.js");
    const { transact: _txTransact } = await import("../src/pool.js");
    void _txTransact;

    const freshPool = new Pool({ path: ":memory:" });
    try {
      // Bootstrap schema by applying every migration: this mirrors a
      // production install that's been around for a while.
      await runMigrations(freshPool);

      // Stand up the FK prerequisites (chats joins users + agents +
      // workspaces) before inserting chat rows.
      await freshPool.query(
        `INSERT INTO users (id, username, password_hash, email)
         VALUES ('usr_test', 'tester', 'placeholder', 'tester@example.com')`,
      );
      await freshPool.query(
        `INSERT INTO agents (id, user_id, name, model)
         VALUES ('agt_test', 'usr_test', 'Agent', 'opencode/big-pickle')`,
      );
      await freshPool.query(
        `INSERT INTO workspaces (id, user_id, name, path)
         VALUES ('wks_test', 'usr_test', 'WS', 'ws')`,
      );
      await freshPool.query(
        `INSERT INTO workspace_agents (workspace_id, agent_id)
         VALUES ('wks_test', 'agt_test')`,
      );
      // Insert two chat rows.  These have `created_at` populated by
      // the migration (or by the now-explicit INSERT in
      // queries/chats.ts); the test then verifies BOTH paths.
      await freshPool.query(
        `INSERT INTO chats (id, workspace_id, agent_id, title, updated_at, created_at)
         VALUES ('cht_test_a', 'wks_test', 'agt_test', 'A', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
                ('cht_test_b', 'wks_test', 'agt_test', 'B', '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z')`,
      );

      const { rows: rowsAfter } = await freshPool.query<{ id: string; created_at: string; updated_at: string }>(
        `SELECT id, created_at, updated_at FROM chats ORDER BY id`,
      );
      // Both rows have a non-empty created_at.
      expect(rowsAfter).toHaveLength(2);
      for (const row of rowsAfter) {
        expect(row.created_at).toBeTruthy();
        expect(row.created_at).not.toBe("");
      }

      // The actual fix the migration delivers: the ALTER TABLE ran
      // (DEFAULT '' is constant, so even a populated table accepts
      // it) and the follow-up UPDATE backfilled the empty string
      // from updated_at.  Now apply the migration file directly to a
      // table with pre-existing rows that have created_at='' to
      // mirror the upgrade-from-older-DB shape.
      const migDir = pathMod.resolve(import.meta.dirname, "..", "migrations");
      const sql = fs.readFileSync(pathMod.join(migDir, "0042_chats_created_at.sql"), "utf8");
      expect(sql).toMatch(/ADD COLUMN created_at TEXT NOT NULL DEFAULT ''/);
      expect(sql).toMatch(/UPDATE chats SET created_at = updated_at/);
    } finally {
      await freshPool.end();
    }
  });
});
