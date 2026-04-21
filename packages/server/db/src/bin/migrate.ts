#!/usr/bin/env node
import { createPool } from "../pool.js";
import { runMigrations } from "../migrate.js";

const pool = createPool();
try {
  await runMigrations(pool);
  console.log("Migrations applied successfully.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
