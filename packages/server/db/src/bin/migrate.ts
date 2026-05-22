#!/usr/bin/env node
import { createPool } from "../pool.js";
import { runMigrations } from "../migrate.js";
import { withModule } from "@roomy-ai/shared/logger";
const log = withModule("db/bin/migrate");

const pool = createPool();
try {
  await runMigrations(pool);
  log.info("Migrations applied successfully.");
} catch (err) {
  log.error({ err }, "Migration failed");
  process.exit(1);
} finally {
  await pool.end();
}
