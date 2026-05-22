import { type Pool, queries } from "@roomy-ai/db";
import type { Message, WsEvent } from "@roomy-ai/shared";
import { computeNextRun } from "./runs-helpers.js";

/**
 * Message lifecycle transitions that change `state` (and sometimes the
 * cron-derived `executeAt`) without touching the agent runtime. Kept in
 * a sibling file so the run manager's closure stays focused on the
 * fire-and-run machinery.
 */

/** Pauses a pending scheduled message: transitions state to 'paused'. */
export async function pauseMessage(
  pool: Pool,
  emit: (event: WsEvent) => void,
  messageId: string,
): Promise<Message | null> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg) return null;
  if (msg.state !== "pending") return msg;
  const updated = await queries.messages.updateMessage(pool, messageId, { state: "paused" });
  if (updated) emit({ type: "message.updated", payload: updated });
  return updated;
}

/**
 * Resumes a non-running message back to 'pending'. For cron tasks without
 * an execute_at, computes the next run time. Source state can be paused,
 * cancelled, succeeded, or failed; no-op only if already running or pending.
 */
export async function resumeMessage(
  pool: Pool,
  emit: (event: WsEvent) => void,
  messageId: string,
): Promise<Message | null> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg) return null;
  if (msg.state === "pending") return msg;
  const patch: Parameters<typeof queries.messages.updateMessage>[2] = { state: "pending" };
  if (msg.cron && !msg.executeAt) {
    patch.executeAt = computeNextRun(msg.cron);
  }
  const updated = await queries.messages.updateMessage(pool, messageId, patch);
  if (updated) emit({ type: "message.updated", payload: updated });
  return updated;
}

/**
 * Reconciles the execute_at/cron after a PATCH that mutates schedule without
 * crossing a state boundary. For cron tasks, recomputes the next run time.
 */
export async function rescheduleMessage(
  pool: Pool,
  emit: (event: WsEvent) => void,
  messageId: string,
): Promise<Message | null> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg) return null;
  if (msg.state !== "pending") return msg;
  if (msg.cron) {
    const nextRun = computeNextRun(msg.cron);
    const updated = await queries.messages.updateMessage(pool, messageId, { executeAt: nextRun });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }
  const updated = await queries.messages.findById(pool, messageId);
  if (updated) emit({ type: "message.updated", payload: updated });
  return updated;
}

/**
 * Cancels a pending scheduled message without deleting it: transitions state
 * to 'cancelled' so the row stays visible in the chat timeline.
 */
export async function cancelScheduledMessage(
  pool: Pool,
  emit: (event: WsEvent) => void,
  messageId: string,
): Promise<Message | null> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg) return null;
  const updated = await queries.messages.updateMessage(pool, messageId, { state: "cancelled" });
  if (updated) emit({ type: "message.updated", payload: updated });
  return updated;
}
