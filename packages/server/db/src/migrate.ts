import fs from "node:fs";
import path from "node:path";
import { Pool, transact } from "./pool.js";

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "migrations",
);

/**
 * Apply pending SQL migrations from `migrations/` in lexical filename
 * order. Each file runs inside its own synchronous transaction; the
 * schema_migrations table tracks which versions have applied.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  pool.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const { rows: applied } = await pool.query<{ version: string }>(
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
    try {
      transact(pool, (p) => {
        p.exec(sql);
        p.querySync(
          "INSERT INTO schema_migrations (version) VALUES (?)",
          [version],
        );
      });
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }
}
