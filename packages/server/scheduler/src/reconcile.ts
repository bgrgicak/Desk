import pg from "pg";

type Tickable = { tickScheduled: () => Promise<void> };

/**
 * Boot-time reconcile: fires any overdue pending messages immediately.
 * In the DB-poll world this is a single tick of the scheduler.
 */
export async function reconcile(
  _pool: pg.Pool,
  runManager: Tickable,
): Promise<void> {
  await runManager.tickScheduled();
}

/**
 * Fires any currently-due pending messages. Called periodically
 * via the sweep timer in main.ts.
 */
export async function sweepStaleRuns(
  _pool: pg.Pool,
  runManager: Tickable,
): Promise<void> {
  await runManager.tickScheduled();
}
