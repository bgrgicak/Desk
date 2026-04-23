import pg from "pg";
import { queries } from "@desk/db";
import type { ScheduleAdapter } from "./scheduleAdapter.js";

/**
 * Reconciles pending scheduled messages with the system `at` / `crontab`
 * state. Called on server boot before accepting traffic.
 *
 * For every pending message that carries a scheduler_ref:
 *   - If the system has the at/cron entry, nothing to do.
 *   - If the system doesn't, mark the message cancelled — the at-daemon
 *     lost its record (e.g. the VM was rebuilt), and we don't
 *     re-schedule automatically because the original trigger time may
 *     have passed.
 *
 * Any at/cron entry not referenced by a pending message is an orphan
 * and gets cancelled.
 */
export async function reconcile(
  pool: pg.Pool,
  adapter: ScheduleAdapter,
): Promise<void> {
  const pending = await queries.messages.listPendingScheduled(pool);

  const systemAtJobs = await adapter.listAt();
  const systemCronJobs = await adapter.listCron();
  const systemAtIds = new Set(systemAtJobs.map((j) => j.id));
  const systemCronIds = new Set(systemCronJobs.map((j) => j.jobId));

  for (const msg of pending) {
    const ref = msg.schedulerRef;
    if (!ref) continue;
    if (ref.kind === "at" && !systemAtIds.has(ref.id)) {
      // eslint-disable-next-line no-console
      console.warn(`at job ${ref.id} for message ${msg.id} missing; cancelling`);
      await queries.messages.updateMessage(pool, msg.id, { state: "cancelled" });
    } else if (ref.kind === "cron" && !systemCronIds.has(ref.id)) {
      // eslint-disable-next-line no-console
      console.warn(`cron job ${ref.id} for message ${msg.id} missing; cancelling`);
      await queries.messages.updateMessage(pool, msg.id, { state: "cancelled" });
    }
  }

  // Garbage-collect orphan at/cron entries — system has them, no
  // pending message references them.
  const dbAtIds = new Set(
    pending
      .filter((m) => m.schedulerRef?.kind === "at")
      .map((m) => m.schedulerRef!.id),
  );
  for (const sysJob of systemAtJobs) {
    if (!dbAtIds.has(sysJob.id)) {
      try { await adapter.removeAt(sysJob.id); } catch { /* ok */ }
    }
  }

  const dbCronIds = new Set(
    pending
      .filter((m) => m.schedulerRef?.kind === "cron")
      .map((m) => m.schedulerRef!.id),
  );
  for (const sysJob of systemCronJobs) {
    if (!dbCronIds.has(sysJob.jobId)) {
      try { await adapter.removeCron(sysJob.jobId); } catch { /* ok */ }
    }
  }
}
