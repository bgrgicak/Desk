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
  killOpencodeDaemonsForOrphans,
  productionReflectWorkspace,
  pruneDriftedContainers,
  writeGoalSkillFiles,
} from "@agent-desk/runtime";
import { createApp } from "./app.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { broadcast, clearConnections } from "./ws/registry.js";
import { ensureHubsForAllUsers } from "./routes/workspaces.js";
import { VaultStore } from "./vault/store.js";
import { resolveProviderKeys } from "./providerKeys.js";
import type { WsEvent } from "@agent-desk/shared";

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const DESK_HOME = resolveDeskHome();
// Default to $DESK_HOME/.database/desk.sqlite3. Dotfile parent so the DB
// stays out of any in-app library listing; tests override
// DESK_DB_PATH to a per-run mkdtemp path.
const DESK_DB_PATH =
  process.env.DESK_DB_PATH
  ?? path.join(DESK_HOME, ".database", "desk.sqlite3");

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
  // One-shot migration from the legacy `${DESK_HOME}/workspaces/{slug}/`
  // layout to the flat `${DESK_HOME}/{slug}/` layout. Idempotent — does
  // nothing once the legacy parent is gone.
  const wsMigration = await migrateLegacyWorkspaceLayout(DESK_HOME);
  if (wsMigration.migrated > 0 || wsMigration.conflicts.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `workspace layout migration: migrated=${wsMigration.migrated} ` +
        `skipped=${wsMigration.skipped} conflicts=${JSON.stringify(wsMigration.conflicts)}`,
    );
  }
  await ensureLayout(DESK_HOME);
  await writeGoalSkillFiles(DESK_HOME);
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
    // eslint-disable-next-line no-console
    console.log("hub auto-create: disabled via DESK_HUB_AUTO_CREATE=off");
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
      // eslint-disable-next-line no-console
      console.log(
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
    // eslint-disable-next-line no-console
    console.log(
      `recovered ${totalOrphaned} orphaned message(s): ` +
      `${orphaned.requeued.length} re-queued, ${orphaned.failed} failed`,
    );
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

  const vault = new VaultStore(path.join(DESK_HOME, "vaults"));

  // If DESK_VAULT_PASSWORD is explicitly set in the environment, use it as
  // the vault master password so the vault is automatically unlocked on
  // every boot — no UI prompt needed. Users who prefer an explicit vault
  // master password leave DESK_VAULT_PASSWORD unset and unlock via the
  // browser UI. Note: this is intentionally a separate env var from
  // DESK_SECRET_KEY (the AES-256 key for SQLite at-rest encryption).
  if (process.env.DESK_VAULT_PASSWORD) {
    const vaultPassword = process.env.DESK_VAULT_PASSWORD;
    const { rows: allUsers } = await pool.query<{ id: string }>("SELECT id FROM users");
    for (const user of allUsers) {
      const { exists } = await vault.status(user.id);
      try {
        if (!exists) {
          await vault.setup(user.id, vaultPassword);
          // eslint-disable-next-line no-console
          console.log(`vault: auto-setup for user ${user.id} via DESK_SECRET_KEY`);
        } else {
          await vault.unlock(user.id, vaultPassword);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`vault: auto-unlock failed for user ${user.id}:`, err);
      }
    }
    // eslint-disable-next-line no-console
    console.log("vault: auto-unlocked via DESK_SECRET_KEY");
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
    // eslint-disable-next-line no-console
    console.log("daily reflection: disabled via DESK_DAILY_REFLECTION=off");
  }

  const server = createApp({
    pool,
    storage: { pool, home: DESK_HOME },
    runManager,
    vault,
    broadcastUserId,
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, "0.0.0.0", resolve);
  });

  // eslint-disable-next-line no-console
  console.log(`desk-server listening on :${PORT}`);

  void auditSandboxMounts(DESK_HOME).then(async (drift) => {
    for (const d of drift) {
      // eslint-disable-next-line no-console
      console.warn(
        `sandbox bind drift: ${d.containerName} mounts ${JSON.stringify(d.actualBinds)} ` +
          `but DESK_HOME=${DESK_HOME} would place workspaces under ${d.expectedPrefix}. ` +
          `Removing stale container.`,
      );
    }
    await pruneDriftedContainers(drift);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    clearInterval(pollTimer);
    clearInterval(idleSweepTimer);
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
