import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "migrations",
);

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (appliedSet.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err}`);
      }
    }
  } finally {
    client.release();
  }
}
