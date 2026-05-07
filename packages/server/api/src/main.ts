/**
 * Entry point for the desk-server process.
 *
 * Reads runtime config from env, wires up storage + scheduler + run manager,
 * starts the HTTP + WS server on $PORT, and runs migrations + seed on boot.
 *
 * Kept tiny on purpose — real behaviour lives in `app.ts`. This file is the
 * I/O boundary the host launcher (`dev.sh` / `desk start`) drives.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPool, runMigrations, seedIfEmpty } from "@agent-desk/db";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  enforceLogRetention,
  reconcileArtifactRefs,
  resolveDeskHome,
} from "@agent-desk/storage";
import { queries } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { auditSandboxMounts, writeGoalSkillFiles } from "@agent-desk/runtime";
import { createApp } from "./app.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { broadcast, clearConnections } from "./ws/registry.js";
import type { WsEvent } from "@agent-desk/shared";

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const DESK_HOME = resolveDeskHome();
// Default to ~/Desk/.database/desk.sqlite3. Dotfile parent so the DB
// stays out of any in-app library listing of ~/Desk; tests override
// DESK_DB_PATH to a per-run mkdtemp path.
const DESK_DB_PATH =
  process.env.DESK_DB_PATH
  ?? path.join(DESK_HOME, "Desk", ".database", "desk.sqlite3");

async function main(): Promise<void> {
  // better-sqlite3 doesn't create parent directories — make sure the
  // tree exists before opening the file (a fresh ~/Desk doesn't have
  // .database yet).
  await fs.mkdir(path.dirname(DESK_DB_PATH), { recursive: true });
  const pool = createPool({ path: DESK_DB_PATH });

  // One-shot schema + seed. Idempotent — safe on every boot.
  await runMigrations(pool);
  await seedIfEmpty(pool);
  await pruneExpiredSessions(pool);

  // Boot-time visibility for the on-disk root. A silent split between this
  // value and the bind source the runtime computes once dropped every user
  // upload into a parallel tree.
  // eslint-disable-next-line no-console
  console.log(
    `desk-server DESK_HOME=${DESK_HOME} (source=${process.env.DESK_HOME ? "env" : process.env.HOME ? "$HOME" : "fallback"})`,
  );
  if (!process.env.DESK_HOME) {
    // eslint-disable-next-line no-console
    console.warn(
      "DESK_HOME is not set explicitly. Falling back to $HOME; " +
        "set DESK_HOME to pin the on-disk root.",
    );
  }
  await fs.mkdir(DESK_HOME, { recursive: true });
  await ensureLayout(DESK_HOME);
  await writeGoalSkillFiles(DESK_HOME);
  // Ensure every existing workspace has its on-disk tree, so a server
  // started after migration 0010 backfill still has folders for rows
  // that were created before per-workspace dirs existed.
  for (const ws of await queries.workspaces.list(pool)) {
    await ensureWorkspaceLayout(DESK_HOME, ws.path);
  }

  // Repair/flag artifactRef messages whose target moved or vanished while
  // the server was down.
  const reconciled = await reconcileArtifactRefs(pool, DESK_HOME);
  if (reconciled.checked > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `artifactRef reconcile: checked=${reconciled.checked} repaired=${reconciled.repaired} missing=${reconciled.missing}`,
    );
  }

  // Log retention: keep the last N log files per chat. Evicted files go
  // to ~/Desk/.trash/logs/ so nothing is silently destroyed.
  const LOG_RETENTION_FILES = parseInt(process.env.DESK_LOG_RETENTION_FILES ?? "500", 10);
  const LOG_RETENTION_INTERVAL_MS = parseInt(process.env.DESK_LOG_RETENTION_INTERVAL_MS ?? "3600000", 10);
  const runRetention = async (): Promise<void> => {
    try {
      const res = await enforceLogRetention(DESK_HOME, LOG_RETENTION_FILES);
      if (res.evicted > 0) {
        // eslint-disable-next-line no-console
        console.log(`log retention: scanned=${res.scanned} evicted=${res.evicted}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("log retention failed:", err);
    }
  };
  await runRetention();
  const retentionTimer = setInterval(() => { void runRetention(); }, LOG_RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  // Broadcast targets the single v1 user.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users LIMIT 1",
  );
  const broadcastUserId: string | undefined = rows[0]?.id;

  const runManager = createRunManager({
    pool,
    emit: (event: WsEvent) => {
      if (broadcastUserId) broadcast(broadcastUserId, event);
    },
  });

  const POLL_INTERVAL_MS = parseInt(
    process.env.DESK_SCHEDULER_POLL_INTERVAL_MS ?? "60000",
    10,
  );
  const pollTimer = runManager.startPolling(POLL_INTERVAL_MS);

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

  void auditSandboxMounts(DESK_HOME).then((drift) => {
    for (const d of drift) {
      // eslint-disable-next-line no-console
      console.warn(
        `sandbox bind drift: ${d.containerName} mounts ${JSON.stringify(d.actualBinds)} ` +
          `but DESK_HOME=${DESK_HOME} would place workspaces under ${d.expectedPrefix}. ` +
          `Container will be recreated on next run.`,
      );
    }
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    clearInterval(pollTimer);
    clearInterval(retentionTimer);
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
