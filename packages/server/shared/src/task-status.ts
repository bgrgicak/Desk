import type { MessageState } from "./entities.js";

/**
 * The single source of truth for user-facing task lifecycle, shared by
 * the API (which decorates every Message it ships with `taskStatus`)
 * and the SPA (which displays it). Add a new column on the Tasks board?
 * Map it here, not in the UI.
 */
export const TASK_STATUSES = [
  "todo",
  "active",
  "needs_input",
  "complete",
  "scheduled",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskStatusInputs {
  /** The parent task message's own lifecycle state. */
  state: MessageState | undefined;
  executeAt?: string | null;
  cron?: string | null;
  /** States of every child `task_run` row anchored on this task. Order
   *  doesn't matter — only "is any of them currently running" is read. */
  runStates?: ReadonlyArray<MessageState | undefined>;
  /** Signals from the chat that hosts the agent for this task. For a
   *  sub-task with a thread chat, this is the *thread* chat (that's
   *  where unread/running flip), not the anchor's chat. */
  chat?: {
    unread?: boolean;
    running?: boolean;
  } | null;
}

/**
 * Priority order matches the prior UI rule (`task-status.ts`):
 *
 *   1. Terminal completion → Done. Sticky.
 *   2. Any child task_run currently running → Active.
 *   3. Hosting chat has a running agent_turn → Active.
 *   4. Scheduled (executeAt / cron set) → Scheduled.
 *   5. Hosting chat is unread → Needs input.
 *   6. Parent state='running' → Active. (Sandbox auto-fire keeps the
 *      parent in running across the gap between task_run end and
 *      lifecycle mirror.)
 *   7. Idle → Open (`todo`).
 *
 * `state='failed'` deliberately falls through to Open so the user keeps
 * acting on the row from the same column; the failure surfaces in the
 * detail panel via statusText, not as a board status.
 */
export function computeTaskStatus(input: TaskStatusInputs): TaskStatus {
  const { state, executeAt, cron, runStates = [], chat } = input;
  if (state === "succeeded" || state === "cancelled") return "complete";
  for (const rs of runStates) {
    if (rs === "running") return "active";
  }
  if (chat?.running) return "active";
  if (executeAt || cron) return "scheduled";
  if (chat?.unread) return "needs_input";
  if (state === "running") return "active";
  return "todo";
}
