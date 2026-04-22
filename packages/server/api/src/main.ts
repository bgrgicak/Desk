/**
 * Entry point for the desk-server process.
 *
 * Reads runtime config from env, wires up storage + scheduler + run manager,
 * starts the HTTP + WS server on $PORT, and runs migrations + seed on boot.
 *
 * Kept tiny on purpose — real behaviour lives in `app.ts`. This file only
 * hosts the I/O boundary that systemd drives.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty, seedProviderKeysFromEnv } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createRunManager, createAdapter } from "@desk/scheduler";
import { createApp } from "./app.js";
import { broadcast, clearConnections } from "./ws/registry.js";
import type { WsEvent } from "@desk/shared";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql:///desk?host=/var/run/postgresql";
const DESK_HOME = process.env.DESK_HOME ?? path.join(process.env.HOME ?? "/var/lib/desk", "Desk");

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  // One-shot schema + seed. Idempotent — safe on every boot.
  await runMigrations(pool);
  await seedIfEmpty(pool);
  await seedProviderKeysFromEnv(pool);

  await fs.mkdir(DESK_HOME, { recursive: true });
  await ensureLayout(DESK_HOME);

  // Broadcast targets the single v1 user.
  const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId: string | undefined = rows[0]?.id;

  const runManager = createRunManager({
    pool,
    adapter: createAdapter(),
    emit: (event: WsEvent) => {
      if (broadcastUserId) broadcast(broadcastUserId, event);
    },
  });

  const server = createApp({
    pool,
    storage: { pool, home: DESK_HOME },
    runManager,
    broadcastUserId,
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, "0.0.0.0", resolve);
  });

  // eslint-disable-next-line no-console
  console.log(`desk-server listening on :${PORT}`);

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    clearConnections();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("desk-server fatal error:", err);
  process.exit(1);
});
