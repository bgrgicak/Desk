import { type Pool, queries } from "@agent-desk/db";
import type { Message } from "@agent-desk/shared";

/**
 * Returns true when the supplied run id belongs to a `task_run` whose
 * parent task is on a real schedule (executeAt or cron). Used by the
 * sandbox-side dispatcher to decide whether to surface "this is part
 * of a scheduled task" affordances.
 */
export async function sandboxSessionRunsScheduledTask(pool: Pool, runId: string | undefined): Promise<boolean> {
  if (!runId) return false;
  const run = await queries.messages.findById(pool, runId);
  if (run?.kind !== "task_run" || !run.parentId) return false;
  const parent = await queries.messages.findById(pool, run.parentId);
  return parent?.kind === "task" && (!!parent.executeAt || !!parent.cron);
}

/**
 * The sandbox can re-schedule itself by emitting the same task body twice
 * (e.g. a cron task whose run produces a new one-shot "do it again at
 * 09:00 tomorrow"). Treat an identical title + body as the same task so
 * the sandbox doesn't multiply parent tasks on every run.
 */
export async function findDuplicateScheduledSandboxTask(
  pool: Pool,
  args: { userId: string; chatId: string; title?: string; content: string; executeAt?: string; cron?: string },
): Promise<Message | null> {
  const existing = await queries.messages.listCrossChat(pool, {
    userId: args.userId,
    chatId: args.chatId,
    kinds: ["task"],
    scheduled: true,
    limit: 200,
  });
  const sameTask = existing.items.find((message) => {
    const sameTitle = (message.title ?? undefined) === args.title;
    const sameContent = message.content.type === "text" && message.content.text === args.content;
    const sameSchedule = args.cron
      ? message.cron === args.cron
      : (message.executeAt ?? undefined) === args.executeAt;
    return sameTitle && sameContent && sameSchedule;
  });
  if (sameTask) return sameTask;

  // Scheduled-task runs sometimes respond to their own cadence by scheduling the
  // same task body again with a newly computed one-shot timestamp (for example,
  // "tomorrow at 09:00" after today's test run). In that context the existing
  // parent task is still the schedule owner, so treat an identical title/body as
  // the same task even when the freshly supplied fire time differs.
  return existing.items.find((message) => {
    const sameTitle = (message.title ?? undefined) === args.title;
    const sameContent = message.content.type === "text" && message.content.text === args.content;
    return sameTitle && sameContent;
  }) ?? null;
}
