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
import { createPool, runMigrations, seedIfEmpty, seedProviderKeysFromEnv } from "@desk/db";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  enforceLogRetention,
  reconcileArtifactRefs,
  resolveDeskHome,
} from "@desk/storage";
import { queries } from "@desk/db";
import { createRunManager, createAdapter, reconcile, sweepStaleRuns } from "@desk/scheduler";
import { auditSandboxMounts } from "@desk/runtime";
import { createApp } from "./app.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { broadcast, clearConnections } from "./ws/registry.js";
import type { WsEvent } from "@desk/shared";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql:///desk?host=/var/run/postgresql";
const DESK_HOME = resolveDeskHome();

async function main(): Promise<void> {
  const pool = createPool({ connectionString: DATABASE_URL });

  // One-shot schema + seed. Idempotent — safe on every boot.
  await runMigrations(pool);
  await seedIfEmpty(pool);
  await seedProviderKeysFromEnv(pool);
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
      "DESK_HOME is not set explicitly. Falling back to $HOME or /home/desk; " +
        "set DESK_HOME in /etc/desk-server/env to pin the on-disk root.",
    );
  }
  const drift = await auditSandboxMounts(DESK_HOME);
  for (const d of drift) {
    // eslint-disable-next-line no-console
    console.warn(
      `sandbox bind drift: ${d.containerName} mounts ${JSON.stringify(d.actualBinds)} ` +
        `but DESK_HOME=${DESK_HOME} would place workspaces under ${d.expectedPrefix}. ` +
        `Container will be recreated on next run.`,
    );
  }

  await fs.mkdir(DESK_HOME, { recursive: true });
  await ensureLayout(DESK_HOME);
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
  const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId: string | undefined = rows[0]?.id;

  const adapter = createAdapter();

  // Repair drift between pending messages and the at/cron daemons:
  // reinstall missing entries, fire overdue at-jobs immediately, and
  // garbage-collect orphan scheduler entries. Without this, a lost or
  // missed at-job leaves the message stuck in `pending` with a past
  // execute_at, which the UI renders as "Overdue since …".
  try {
    await reconcile(pool, adapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("scheduler reconcile failed:", err);
  }

  // Periodic sweep for runs that go stale while the server is up — e.g.
  // an at-job the daemon silently dropped, or a message whose executeAt
  // has passed without a fire. sweepStaleRuns is the same repair logic
  // reconcile runs at boot, minus the orphan GC (which is boot-only).
  const SWEEP_INTERVAL_MS = parseInt(
    process.env.DESK_SCHEDULER_SWEEP_INTERVAL_MS ?? "300000",
    10,
  );
  const sweepTimer = setInterval(() => {
    void sweepStaleRuns(pool, adapter).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("scheduler sweep failed:", err);
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const runManager = createRunManager({
    pool,
    adapter,
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
