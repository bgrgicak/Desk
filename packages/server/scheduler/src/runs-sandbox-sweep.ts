import { type Pool } from "@agent-desk/db";
import { reapIdleSandboxes, softReapIdleDaemons } from "@agent-desk/runtime";
import { withModule } from "@agent-desk/shared/logger";

const log = withModule("scheduler/sandbox-sweep");

/**
 * Returns the set of workspace ids that should keep their sandbox
 * alive: any workspace with a `state='running'` row, or any message
 * whose `updated_at` is within `idleMs` of now. Exposed separately
 * from `sweepIdleSandboxes` so tests can pin down the SQL-side
 * decision directly without needing a real container engine.
 */
export async function getActiveWorkspaceIds(pool: Pool, idleMs: number): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  // Workspaces with *any* recent activity — running rows, just-fired
  // pending rows, or just-edited rows — count as active and keep their
  // sandbox. Joining through chats so we get workspace_id directly.
  const { rows } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT c.workspace_id
     FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.state = 'running'
        OR m.updated_at >= ?`,
    [cutoff],
  );
  return new Set(rows.map((r) => r.workspace_id));
}

/**
 * Removes sandbox containers for workspaces that have had no
 * `state='running'` rows and no message activity in the last
 * `idleMs`. Next fire for that workspace builds a fresh container
 * at the baseline 512 / 512 MB — so this also serves as the
 * "scale back to baseline" mechanism, free of charge.
 *
 * One SQL query, one `docker ps`, then one `docker rm -f` per
 * idle workspace. Cheap enough to live alongside the existing
 * 60 s `pollTimer` without measurable cost.
 */
export async function sweepIdleSandboxes(
  pool: Pool,
  idleMs: number = parseInt(process.env.DESK_SANDBOX_IDLE_MS ?? `${30 * 60 * 1000}`, 10),
): Promise<string[]> {
  const active = await getActiveWorkspaceIds(pool, idleMs);
  // Pass `idleMs` as the per-container minimum age so a brand-new
  // container created in the window between the SQL query and the
  // `docker ps` can't be reaped — the very next sweep will see its
  // first message row and treat the workspace as active.
  return reapIdleSandboxes(active, idleMs);
}

export function startIdleSweeper(pool: Pool, intervalMs: number = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepIdleSandboxes(pool).catch((err) => {
      log.warn({ err }, "idle sandbox sweep failed");
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Soft-tier idle sweep: kill the pi runtime inside
 * sandbox containers whose workspace has been quiet for
 * `softIdleMs` (default 10 min), but keep the container running.
 * Saves ~400 MB of warm-daemon RSS per sandbox; the next message
 * pays only the ~2-5 s daemon respawn cost, not a full container
 * cold-start.
 *
 * Distinct from `sweepIdleSandboxes`: that one nukes the container
 * after a longer quiet window (default 30 min) and is the
 * scale-back-to-baseline mechanism.
 */
export async function sweepIdleDaemons(
  pool: Pool,
  softIdleMs: number = parseInt(
    process.env.DESK_SANDBOX_SOFT_IDLE_MS ?? `${10 * 60 * 1000}`,
    10,
  ),
): Promise<string[]> {
  const active = await getActiveWorkspaceIds(pool, softIdleMs);
  return softReapIdleDaemons(active, softIdleMs);
}

export function startSoftIdleDaemonSweeper(pool: Pool, intervalMs: number = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepIdleDaemons(pool).catch((err) => {
      log.warn({ err }, "soft daemon sweep failed");
    });
  }, intervalMs);
  timer.unref();
  return timer;
}
