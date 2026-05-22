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
import { createPool, queries, runMigrations, seedIfEmpty } from "@agent-desk/db";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  enforceLogRetention,
  migrateLegacyWorkspaceLayout,
  reconcileArtifactRefs,
  resolveDeskHome,
} from "@agent-desk/storage";
import { createRunManager, ensureDailyReflectionTasks } from "@agent-desk/scheduler";
import {
  auditSandboxMounts,
  buildDaemonEnv,
  detectEngine,
  killOpencodeDaemonsForOrphans,
  productionReflectWorkspace,
  pruneDriftedContainers,
  refreshSandboxConnections,
  resolveLocalSourceEnv,
  writeBuiltinApps,
  writeGoalSkillFiles,
} from "@agent-desk/runtime";
import { createApp } from "./app.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { broadcast, clearConnections } from "./ws/registry.js";
import { ensureHubsForAllUsers } from "./routes/workspaces.js";
import { VaultStore } from "./vault/store.js";
import { resolveProviderKeys } from "./providerKeys.js";
import { resolveVaultPasswordEnv } from "./envFile.js";
import type { WsEvent } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("api/main");

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const DESK_HOME = resolveDeskHome();
// Default to $DESK_HOME/.database/desk.sqlite3. Dotfile parent so the DB
// stays out of any in-app library listing; tests override
// DESK_DB_PATH to a per-run mkdtemp path.
const DESK_DB_PATH =
  process.env.DESK_DB_PATH
  ?? path.join(DESK_HOME, ".database", "desk.sqlite3");

const PRE_MIGRATION_BACKUP_KEEP = parseInt(
  process.env.DESK_PRE_MIGRATION_BACKUP_KEEP ?? "10",
  10,
);

/**
 * Snapshot the SQLite DB to ${DESK_HOME}/backups/pre-migration-<ts>.db
 * before migrations run. Uses the same VACUUM INTO path as the
 * /internal/backup endpoint — works while the pool holds an exclusive
 * lock, produces a checkpointed copy. Old snapshots beyond
 * PRE_MIGRATION_BACKUP_KEEP are deleted, oldest first.
 *
 * Skipped silently when the DB is empty (first boot) since VACUUM INTO
 * needs at least one page to operate on. Errors are logged and the boot
 * continues — losing the safety net is preferable to refusing to start.
 */
async function snapshotBeforeMigrations(
  pool: ReturnType<typeof createPool>,
  deskHome: string,
  dbPath: string,
): Promise<void> {
  try {
    const stat = await fs.stat(dbPath).catch(() => null);
    if (!stat || stat.size === 0) return; // first boot

    const backupDir = path.join(deskHome, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backupDir, `pre-migration-${ts}.db`);

    // VACUUM INTO takes the path as a literal SQL string. SQLite's
    // single-quote escape covers the normal injection vectors, but a
    // DESK_HOME containing newlines, NUL bytes or backslashes would
    // sneak past the escape on certain SQLite versions. Reject those
    // explicitly so the backup never runs with a path we didn't sanitise.
    // eslint-disable-next-line no-control-regex -- intentional: rejecting NUL byte injection in path
    if (/[\u0000\n\r]/.test(target)) {
      log.warn({ target }, "pre-migration backup skipped: target path contains disallowed characters");
      return;
    }
    pool.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    log.info(`pre-migration backup: ${target}`);

    // Retention: keep only the most-recent N pre-migration-*.db files.
    const entries = (await fs.readdir(backupDir))
      .filter((name) => name.startsWith("pre-migration-") && name.endsWith(".db"))
      .sort(); // ISO timestamps sort lexicographically
    const stale = entries.slice(0, Math.max(0, entries.length - PRE_MIGRATION_BACKUP_KEEP));
    for (const name of stale) {
      await fs.rm(path.join(backupDir, name), { force: true });
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, "pre-migration backup failed (continuing boot)");
  }
}

async function main(): Promise<void> {
  // better-sqlite3 doesn't create parent directories — make sure the
  // tree exists before opening the file (a fresh ~/Desk doesn't have
  // .database yet).
  await fs.mkdir(path.dirname(DESK_DB_PATH), { recursive: true });
  const pool = createPool({ path: DESK_DB_PATH });

  // Snapshot the DB before migrations run. Forward-only migrations
  // can leave the schema wedged if a partial run errors halfway; the
  // snapshot is the safety net documented in BACKUP.md. Skip on a
  // truly-empty file (first boot) to avoid surfacing a "VACUUM INTO
  // requires content" error during install. Retention is bounded by
  // DESK_PRE_MIGRATION_BACKUP_KEEP (default 10).
  await snapshotBeforeMigrations(pool, DESK_HOME, DESK_DB_PATH);

  // One-shot schema + seed. Idempotent — safe on every boot.
  await runMigrations(pool);
  await seedIfEmpty(pool);
  await pruneExpiredSessions(pool);

  // Boot-time visibility for the on-disk root. A silent split between this
  // value and the bind source the runtime computes once dropped every user
  // upload into a parallel tree.
  log.info(
    `desk-server DESK_HOME=${DESK_HOME} (source=${process.env.DESK_HOME ? "env" : process.env.HOME ? "$HOME" : "fallback"})`,
  );
  if (!process.env.DESK_HOME) {
    log.warn(
      "DESK_HOME is not set explicitly. Falling back to $HOME; " +
        "set DESK_HOME to pin the on-disk root.",
    );
  }
  await fs.mkdir(DESK_HOME, { recursive: true });
  // One-shot migration from the legacy `${DESK_HOME}/workspaces/{slug}/`
  // layout to the flat `${DESK_HOME}/{slug}/` layout. Idempotent — does
  // nothing once the legacy parent is gone.
  const wsMigration = await migrateLegacyWorkspaceLayout(DESK_HOME);
  if (wsMigration.migrated > 0 || wsMigration.conflicts.length > 0) {
    log.info(
      `workspace layout migration: migrated=${wsMigration.migrated} ` +
        `skipped=${wsMigration.skipped} conflicts=${JSON.stringify(wsMigration.conflicts)}`,
    );
  }
  await ensureLayout(DESK_HOME);
  await writeGoalSkillFiles(DESK_HOME);
  await writeBuiltinApps(DESK_HOME);
  // Per-user hub auto-create. Runs before the workspace layout backfill
  // so a fresh hub immediately has its on-disk tree. Idempotent — does
  // nothing for users that already have a hub.
  //
  // Opt-out via `DESK_HUB_AUTO_CREATE=off` for environments whose tests
  // still assume the seeded user has a single project workspace (e.g. the
  // Playwright e2e harness). Production deployments leave it on so the
  // hub is always available.
  const hubAutoCreateDisabled =
    (process.env.DESK_HUB_AUTO_CREATE ?? "on").toLowerCase() === "off";
  if (!hubAutoCreateDisabled) {
    await ensureHubsForAllUsers(pool, DESK_HOME);
  } else {
    log.info("hub auto-create: disabled via DESK_HUB_AUTO_CREATE=off");
  }

  // Ensure every existing workspace has its on-disk tree, so a server
  // started after migration 0010 backfill still has folders for rows
  // that were created before per-workspace dirs existed.
  for (const ws of await queries.workspaces.list(pool)) {
    await ensureWorkspaceLayout(DESK_HOME, ws.path);
  }

  // Kill `opencode serve` daemons that survived a previous desk-server
  // (tsx-watch reload, hard crash). The daemon keeps `~/.local/share/
  // opencode/opencode.db` exclusively open — a new desk-server's first
  // `opencode serve` spawn would fail to acquire it and the chat would
  // error out. Killing the orphan daemon lets the new server bring up a
  // fresh one on the next request. Per workspace, one shot, best-effort.
  const orphanRunRows = (await pool.query<{ run_id: string; workspace_id: string }>(
    `SELECT m.id AS run_id, c.workspace_id
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE m.state IN ('running', 'pending')
        AND json_valid(m.content)
        AND json_extract(m.content, '$.type') IN ('agent_turn', 'summary_request')`,
  )).rows;
  if (orphanRunRows.length > 0) {
    const workspaceIds = Array.from(new Set(orphanRunRows.map((r) => r.workspace_id)));
    const killResults = await killOpencodeDaemonsForOrphans(workspaceIds);
    const actuallyKilled = killResults.filter((r: { killed: boolean }) => r.killed).length;
    if (actuallyKilled > 0) {
      log.info(
        `killed orphaned opencode-serve daemon in ${actuallyKilled}/${workspaceIds.length} workspace(s) before requeue`,
      );
    }
  }

  // Re-queue agent_turn / summary_request messages that were interrupted
  // by the previous server process (crash, hot-reload, etc.) so they are
  // retried rather than silently dropped. task_run orphans are failed so
  // their parent cron tasks can reschedule normally.
  const orphaned = await queries.messages.recoverOrphanedRuns(pool);
  const totalOrphaned = orphaned.requeued.length + orphaned.failed;
  if (totalOrphaned > 0) {
    log.info(
      `recovered ${totalOrphaned} orphaned message(s): ` +
      `${orphaned.requeued.length} re-queued, ${orphaned.failed} failed`,
    );
  }

  // Repair/flag artifactRef messages whose target moved or vanished while
  // the server was down.
  const reconciled = await reconcileArtifactRefs(pool, DESK_HOME);
  if (reconciled.checked > 0) {
    log.info(
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
        log.info(`log retention: scanned=${res.scanned} evicted=${res.evicted}`);
      }
    } catch (err) {
      log.error({ err }, "log retention failed");
    }
  };
  await runRetention();
  const retentionTimer = setInterval(() => { void runRetention(); }, LOG_RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  // Provider-key audit log retention. The table records every read /
  // write / delete touching a user's provider keys (see SECURITY.md)
  // and grows unbounded otherwise. 90-day default rolling window;
  // operators can tune via DESK_KEY_ACCESS_LOG_RETENTION_DAYS.
  const KEY_LOG_RETENTION_DAYS = parseInt(
    process.env.DESK_KEY_ACCESS_LOG_RETENTION_DAYS ?? "90",
    10,
  );
  const KEY_LOG_REAPER_INTERVAL_MS = parseInt(
    process.env.DESK_KEY_ACCESS_LOG_REAPER_INTERVAL_MS ?? "86400000", // daily
    10,
  );
  const runKeyAccessLogReaper = async (): Promise<void> => {
    try {
      const removed = await queries.providerKeyAccessLog.pruneKeyAccessLog(
        pool,
        KEY_LOG_RETENTION_DAYS,
      );
      if (removed > 0) {
        log.info(`key-access-log reaper: pruned ${removed} entries older than ${KEY_LOG_RETENTION_DAYS} days`);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "key-access-log reaper failed");
    }
  };
  await runKeyAccessLogReaper();
  const keyAccessLogReaperTimer = setInterval(
    () => { void runKeyAccessLogReaper(); },
    KEY_LOG_REAPER_INTERVAL_MS,
  );
  keyAccessLogReaperTimer.unref();

  // Broadcast targets the single v1 user.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users LIMIT 1",
  );
  const broadcastUserId: string | undefined = rows[0]?.id;

  const vault = new VaultStore(path.join(DESK_HOME, "vaults"));

  // DESK_VAULT_PASSWORD is now opt-in (no longer auto-generated). When
  // set, boot auto-unlocks every existing vault with it and can
  // auto-create missing ones if DESK_VAULT_AUTO_SETUP=on. When unset,
  // boot doesn't touch vaults at all — users pick their own password
  // through the VaultDialog on first credential save.
  {
    const vaultPassword = await resolveVaultPasswordEnv({ deskHome: DESK_HOME });
    if (!vaultPassword) {
      log.info("vault: no DESK_VAULT_PASSWORD configured — boot auto-unlock skipped");
    } else {
    // `DESK_VAULT_AUTO_SETUP=on` (explicit opt-in) lets boot create
    // vaults for users who don't have one yet. Default is off: missing
    // vaults stay missing so the modal owns first-time setup. Auto-
    // unlock of *existing* vaults is unconditional whenever a password
    // is configured — it's just a cache refill for the in-memory
    // master, doesn't disclose anything new.
    const autoSetup = (process.env.DESK_VAULT_AUTO_SETUP ?? "off").toLowerCase() === "on";

    const { rows: allUsers } = await pool.query<{ id: string }>("SELECT id FROM users");
    let unlocked = 0;
    let setup = 0;
    let failed = 0;
    let skipped = 0;
    for (const user of allUsers) {
      const { exists } = await vault.status(user.id);
      try {
        if (!exists) {
          if (!autoSetup) {
            skipped += 1;
            continue;
          }
          await vault.setup(user.id, vaultPassword);
          setup += 1;
          log.info({ userId: user.id }, "vault: auto-setup via DESK_VAULT_PASSWORD");
        } else {
          await vault.unlock(user.id, vaultPassword);
          unlocked += 1;
        }
      } catch (err) {
        failed += 1;
        // Most likely cause: DESK_VAULT_PASSWORD drifted from the value
        // the vault was sealed with. The vault stays locked and the
        // user must unlock it through the VaultDialog. We surface this
        // loudly so it's not silently swallowed.
        log.warn(
          { userId: user.id, err: (err as Error).message },
          "vault: auto-unlock failed (password mismatch?) — user will need to unlock via UI",
        );
      }
    }
    log.info({ unlocked, setup, failed, skipped }, "vault: boot auto-unlock complete");
    }
  }

  const runManager = createRunManager({
    pool,
    home: DESK_HOME,
    reflectWorkspace: productionReflectWorkspace,
    resolveProviderKeys: (userId, workspaceId) => resolveProviderKeys(pool, vault, userId, workspaceId),
    emit: (event: WsEvent) => {
      if (broadcastUserId) broadcast(broadcastUserId, event);
    },
  });

  const POLL_INTERVAL_MS = parseInt(
    process.env.DESK_SCHEDULER_POLL_INTERVAL_MS ?? "60000",
    10,
  );
  const pollTimer = runManager.startPolling(POLL_INTERVAL_MS);
  // Fire any re-queued orphans immediately rather than waiting up to
  // POLL_INTERVAL_MS for the first scheduled tick.
  if (orphaned.requeued.length > 0) {
    void runManager.tickScheduled();
  }

  // Sandbox auto-scaling is event-driven inside the scheduler's
  // `fireMessage`: when a run fails with `spawn EAGAIN` / exit 137 /
  // ENOMEM, the scheduler grows the sandbox in place and re-fires the
  // same message. No timer-based pressure scanner here — we react to
  // actual failures instead of probing cgroups every minute.
  //
  // No stale-run watchdog either: a single task may legitimately run
  // for hours, and silently killing one to "tidy up" would hide
  // whatever real bug stranded its row in `running` state.
  //
  // Idle-sandbox sweeper: removes the container for any workspace
  // with no message activity for `DESK_SANDBOX_IDLE_MS` (default
  // 30 min). The next fire creates a fresh sandbox at the baseline
  // size, which also serves as the "reset grown sandbox back to
  // small" path. One SQL query + one `docker ps` per minute.
  const idleSweepTimer = runManager.startIdleSweeper(
    parseInt(process.env.DESK_SANDBOX_IDLE_SWEEP_INTERVAL_MS ?? "60000", 10),
  );

  // Soft-tier daemon sweeper: kills the in-container opencode-serve
  // daemon for workspaces quiet for `DESK_SANDBOX_SOFT_IDLE_MS` (default
  // 10 min) but leaves the container running. Saves ~400 MB of warm-
  // daemon RSS per sandbox; the next message pays only the ~2-5 s
  // daemon respawn cost. Runs on the same 60s cadence as the hard
  // sweeper — they coexist (hard reap takes precedence; once the
  // container is gone, the soft tier finds nothing to do).
  const softIdleSweepTimer = runManager.startSoftIdleDaemonSweeper(
    parseInt(process.env.DESK_SANDBOX_SOFT_IDLE_SWEEP_INTERVAL_MS ?? "60000", 10),
  );

  // Memory-system Phase 5 — daily reflection. Seed one internal recurring
  // scheduler task per workspace instead of owning a separate process-local
  // cron. Set DESK_DAILY_REFLECTION=off to skip seeding in dev / tests.
  const reflectionDisabled =
    (process.env.DESK_DAILY_REFLECTION ?? "on").toLowerCase() === "off";
  if (!reflectionDisabled) {
    await ensureDailyReflectionTasks({
      pool,
      cron: process.env.DESK_DAILY_REFLECTION_CRON ?? "0 3 * * *",
    });
  }
  if (reflectionDisabled) {
    log.info("daily reflection: disabled via DESK_DAILY_REFLECTION=off");
  }

  const server = createApp({
    pool,
    storage: { pool, home: DESK_HOME },
    runManager,
    vault,
    broadcastUserId,
    refreshSandboxConnections: async (userId, workspaceId) => {
      const result = await refreshSandboxConnections({
        pool,
        userId,
        workspaceId,
        // Compose the same env the scheduler uses at run-fire time, so
        // the digest the daemon is restarted with matches what the next
        // message would compute and we don't trip a redundant restart.
        buildSandboxEnv: async (uid, wsId) => {
          const providerKeys = await resolveProviderKeys(pool, vault, uid, wsId);
          const extraEnv = await resolveLocalSourceEnv(pool, uid);
          return buildDaemonEnv({ providerKeys, extraEnv });
        },
      });
      // Always log the summary — the silent path (no warm container,
      // nothing cleared) is exactly where bugs hide. We want to see one
      // log line per connection mutation so the operator can correlate
      // "I saved the GitHub key" with the refresh outcome.
      log.info(
        `connection refresh user=${userId} ws=${workspaceId ?? "*"}: ` +
        `restarted=${result.restarted.length} skippedActive=${result.skippedActive.length} ` +
        `skippedNoContainer=${result.skippedNoContainer.length} failed=${result.failed.length} ` +
        `clearedSessions=${result.clearedSessions.length}`,
      );
      for (const f of result.failed) {
        log.warn(`connection refresh: workspace ${f.workspaceId} failed: ${f.error}`);
      }
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, "0.0.0.0", resolve);
  });

  log.info(`desk-server listening on :${PORT}`);

  // Probe the container engine once at startup and log the choice so
  // operators don't have to re-read DESK_CONTAINER_ENGINE / docker info
  // to know which path is live. Best-effort: a host without an engine
  // can still serve the API; sandbox-launching routes will surface the
  // failure with the right error code at request time.
  try {
    const engine = await detectEngine();
    const override = process.env.DESK_CONTAINER_ENGINE
      ? ` (pinned via DESK_CONTAINER_ENGINE)`
      : ` (autodetected)`;
    log.info(`sandbox driver: ${engine.name}${override}`);
  } catch (err) {
    log.warn(`sandbox driver: unavailable — ${(err as Error).message}`);
  }

  void auditSandboxMounts(DESK_HOME).then(async (drift) => {
    for (const d of drift) {
      log.warn(
        `sandbox bind drift: ${d.containerName} mounts ${JSON.stringify(d.actualBinds)} ` +
          `but DESK_HOME=${DESK_HOME} would place workspaces under ${d.expectedPrefix}. ` +
          `Removing stale container.`,
      );
    }
    await pruneDriftedContainers(drift);
  });

  // Graceful shutdown: stop the accept queue, drain in-flight requests
  // within a bounded grace period, drop WS clients, close the DB pool.
  // If a request hangs past SHUTDOWN_GRACE_MS we force-exit so a stuck
  // upstream call can never block restart.
  const SHUTDOWN_GRACE_MS = parseInt(process.env.DESK_SHUTDOWN_GRACE_MS ?? "30000", 10);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down (grace ${SHUTDOWN_GRACE_MS}ms)`);
    clearInterval(pollTimer);
    clearInterval(idleSweepTimer);
    clearInterval(softIdleSweepTimer);
    clearInterval(retentionTimer);
    clearInterval(keyAccessLogReaperTimer);
    clearConnections();

    // Force-exit watchdog. We'd rather lose a few hung requests than
    // leave the process zombie-running and confuse process supervisors.
    const force = setTimeout(() => {
      log.error(`shutdown grace expired after ${SHUTDOWN_GRACE_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Node ≥18.2: hang up any still-open keep-alive connections so
      // server.close() actually fires its callback instead of waiting
      // forever on idle clients.
      server.closeIdleConnections?.();
    });
    try {
      await pool.end();
    } catch (err) {
      log.warn({ err }, "pool.end() during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err }, "desk-server fatal error");
  process.exit(1);
});
