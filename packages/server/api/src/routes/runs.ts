import pg from "pg";
import { queries } from "@desk/db";
import { NotFoundError } from "@desk/shared";
import type { createRunManager } from "@desk/scheduler";

type RunManager = ReturnType<typeof createRunManager>;

export async function listRuns(pool: pg.Pool) {
  return queries.runs.listRecent(pool);
}

export async function getRun(pool: pg.Pool, id: string) {
  const run = await queries.runs.findById(pool, id);
  if (!run) throw new NotFoundError(`Run not found: ${id}`);
  return run;
}

export async function getRunLogs(pool: pg.Pool, runId: string, opts?: { cursor?: number }) {
  return queries.runEvents.listByRun(pool, runId, opts);
}

export async function cancelRun(runManager: RunManager, runId: string) {
  await runManager.cancelRun(runId);
  return { ok: true };
}

export async function listScheduledJobs(pool: pg.Pool) {
  return queries.scheduledJobs.listActive(pool);
}

export async function createScheduledJob(
  runManager: RunManager,
  data: { chatId?: string; prompt: string; mode: "scheduled" | "recurring"; spec: string },
) {
  return runManager.enqueueRun({
    chatId: data.chatId,
    prompt: data.prompt,
    mode: data.mode,
    spec: data.spec,
  });
}

export async function deleteScheduledJob(runManager: RunManager, jobId: string) {
  await runManager.cancelJob(jobId);
  return { ok: true };
}
