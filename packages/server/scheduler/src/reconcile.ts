import pg from "pg";
import { queries } from "@desk/db";
import type { ScheduleAdapter } from "./scheduleAdapter.js";

/**
 * Reconciles scheduled_jobs with the system `at` and `crontab` state.
 * Called on server boot before accepting traffic.
 */
export async function reconcile(
  pool: pg.Pool,
  adapter: ScheduleAdapter,
): Promise<void> {
  const dbJobs = await queries.scheduledJobs.listActive(pool);
  const systemAtJobs = await adapter.listAt();
  const systemCronJobs = await adapter.listCron();

  const systemAtIds = new Set(systemAtJobs.map((j) => j.id));
  const systemCronIds = new Set(systemCronJobs.map((j) => j.jobId));

  for (const job of dbJobs) {
    if (job.kind === "once" || job.kind === "ai_note") {
      // Check at jobs
      if (job.atJobId && !systemAtIds.has(job.atJobId)) {
        // In DB but missing from system — try to reinstall or deactivate
        console.warn(`at job ${job.atJobId} for ${job.id} missing from system, deactivating`);
        await queries.scheduledJobs.cancel(pool, job.id);
      }
    }

    if (job.kind === "recurring") {
      // Check cron jobs
      if (job.crontabId && !systemCronIds.has(job.crontabId)) {
        console.warn(`cron job ${job.crontabId} for ${job.id} missing from system, deactivating`);
        await queries.scheduledJobs.cancel(pool, job.id);
      }
    }
  }

  // Clean up orphaned system jobs not in DB
  const dbAtIds = new Set(
    dbJobs.filter((j) => j.atJobId).map((j) => j.atJobId!),
  );
  for (const sysJob of systemAtJobs) {
    if (!dbAtIds.has(sysJob.id)) {
      try {
        await adapter.removeAt(sysJob.id);
      } catch { /* ok */ }
    }
  }

  const dbCronIds = new Set(
    dbJobs.filter((j) => j.crontabId).map((j) => j.crontabId!),
  );
  for (const sysJob of systemCronJobs) {
    if (!dbCronIds.has(sysJob.jobId)) {
      try {
        await adapter.removeCron(sysJob.jobId);
      } catch { /* ok */ }
    }
  }
}
