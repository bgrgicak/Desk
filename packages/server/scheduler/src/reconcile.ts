import { type Pool } from "@desk/db";
import { queries } from "@desk/db";
import type { ScheduleAdapter } from "./scheduleAdapter.js";
import { buildMessageFireCmd } from "./runs.js";

/**
 * Sweeps pending scheduled messages and repairs drift between the DB and
 * the system `at` / `crontab` state. Safe to call both at boot and on a
 * periodic timer.
 *
 * For each pending message:
 *   - at-job, overdue (executeAt <= now): reinstall with "now" so the
 *     daemon fires on the next tick. The old entry, if any, is removed
 *     first. This covers the case where the daemon missed the trigger
 *     (server was down) or the entry was lost but fireMessage still hasn't
 *     run. fireMessage is idempotent via claimPending, so a racing fire
 *     from a stale entry is harmless.
 *   - at-job, future but entry missing: reinstall at the original executeAt.
 *   - cron-job, entry missing: reinstall with the stored cron expression.
 *
 * Cron jobs that exist are left alone — they'll fire at their next tick,
 * and there is no catch-up of missed occurrences.
 */
export async function sweepStaleRuns(
  pool: Pool,
  adapter: ScheduleAdapter,
): Promise<void> {
  const pending = await queries.messages.listPendingScheduled(pool);

  const systemAtJobs = await adapter.listAt();
  const systemCronJobs = await adapter.listCron();
  const systemAtIds = new Set(systemAtJobs.map((j) => j.id));
  const systemCronIds = new Set(systemCronJobs.map((j) => j.jobId));

  const now = Date.now();

  for (const msg of pending) {
    const ref = msg.schedulerRef;

    if (msg.cron) {
      // Canonical cron jobId is the message id — same choice resumeMessage
      // makes — so re-sweeps don't leak stray crontab lines.
      const jobId = msg.id;
      const refMatchesCanonical = ref?.kind === "cron" && ref.id === jobId;
      if (!refMatchesCanonical || !systemCronIds.has(jobId)) {
        if (ref?.kind === "cron" && ref.id !== jobId) {
          try { await adapter.removeCron(ref.id); } catch { /* ok */ }
        }
        await adapter.installCron(jobId, msg.cron, buildMessageFireCmd(msg.id));
        await queries.messages.updateMessage(pool, msg.id, {
          schedulerRef: { kind: "cron", id: jobId },
        });
      }
      continue;
    }

    if (!msg.executeAt) continue;
    const whenMs = new Date(msg.executeAt).getTime();
    const overdue = whenMs <= now;
    const entryMissing = ref?.kind === "at" && !systemAtIds.has(ref.id);

    if (!overdue && !entryMissing) continue;

    if (ref?.kind === "at") {
      try { await adapter.removeAt(ref.id); } catch { /* ok */ }
    }
    const atTime = overdue ? "now" : new Date(whenMs).toISOString();
    const atJobId = await adapter.scheduleAt(buildMessageFireCmd(msg.id), atTime);
    await queries.messages.updateMessage(pool, msg.id, {
      schedulerRef: { kind: "at", id: atJobId },
    });
  }
}

/**
 * Boot-time reconcile: sweeps stale pending messages, then garbage-collects
 * orphan at/cron entries — system has them, no pending message references
 * them. The orphan GC is boot-only because during normal operation a fired
 * at-job briefly exists after its message moves off `pending`.
 */
export async function reconcile(
  pool: Pool,
  adapter: ScheduleAdapter,
): Promise<void> {
  await sweepStaleRuns(pool, adapter);

  const pending = await queries.messages.listPendingScheduled(pool);
  const systemAtJobs = await adapter.listAt();
  const systemCronJobs = await adapter.listCron();

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
