import type { Task } from '@/data/ui-types'

type TaskStatusPatch = {
  state?: 'pending' | 'cancelled' | 'paused'
  executeAt?: string | null
  cron?: string | null
}

export type TaskStatusMove =
  | { kind: 'run'; optimisticStatus: Task['status'] }
  | { kind: 'patch'; optimisticStatus: Task['status']; patch: TaskStatusPatch }
  | { kind: 'none' }

type TaskStatusActor = 'user' | 'agent'

export function canUserChangeTaskStatus(task: Pick<Task, 'messageKind'>): boolean {
  return task.messageKind === 'task'
}

function isPausedTask(task: Pick<Task, 'messageState'>): boolean {
  return task.messageState === 'paused'
}

/**
 * Convert a user-facing task status change into the single API operation that
 * should persist it. This is intentionally shared by the board and detail
 * sidebar so drag/drop and button/dropdown actions cannot drift apart.
 */
export function buildTaskStatusMove(
  task: Pick<Task, 'status' | 'scheduledFor' | 'schedule' | 'messageKind' | 'messageRole' | 'messageState'>,
  newStatus: Task['status'],
  actor: TaskStatusActor = 'user',
  now: () => Date = () => new Date(),
): TaskStatusMove {
  // Only explicit user gestures may reposition or run a task from the board.
  // Agent execution writes task_run history and may update parent state only
  // through the scheduler's lifecycle policy; it must not reuse this UI
  // transition path. User gestures are allowed for every task row, including
  // agent-authored tasks; messageRole controls whether scheduler completion may
  // later close the parent automatically, not whether the user can act on it.
  if (actor !== 'user') return { kind: 'none' }
  if (!canUserChangeTaskStatus(task)) return { kind: 'none' }
  if (newStatus === task.status && !isPausedTask(task)) return { kind: 'none' }
  // `needs_input` is server-driven (an unread agent reply), never a
  // kanban target. Refuse to translate it — there is no valid state
  // mutation that would land the card there, and silently falling
  // through to the scheduled branch would surprise the caller.
  if (newStatus === 'needs_input') return { kind: 'none' }
  if (newStatus === 'active') return { kind: 'run', optimisticStatus: 'active' }
  if (newStatus === 'complete') return { kind: 'patch', optimisticStatus: 'complete', patch: { state: 'cancelled' } }
  if (newStatus === 'todo') return { kind: 'patch', optimisticStatus: 'todo', patch: { executeAt: null, cron: null, state: 'pending' } }

  const patch: { state: 'pending'; executeAt?: string | null; cron?: string | null } = { state: 'pending' }
  if (!task.scheduledFor && !task.schedule) {
    patch.executeAt = new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString()
  }
  return { kind: 'patch', optimisticStatus: 'scheduled', patch }
}

export type TaskLifecycleAction = 'pause' | 'resume'

/**
 * Lifecycle controls are still explicit user gestures against the parent task.
 * Keep them beside column moves so the sidebar does not infer policy from
 * status labels or hand-roll different patch payloads.
 */
export function buildTaskLifecycleMove(
  task: Pick<Task, 'status' | 'messageKind' | 'messageRole' | 'messageState'>,
  action: TaskLifecycleAction,
  actor: TaskStatusActor = 'user',
): TaskStatusMove {
  if (actor !== 'user') return { kind: 'none' }
  if (!canUserChangeTaskStatus(task)) return { kind: 'none' }
  if (action === 'pause') {
    if (task.messageState === 'paused') return { kind: 'none' }
    return { kind: 'patch', optimisticStatus: task.status, patch: { state: 'paused' } }
  }
  if (task.messageState !== 'paused') return { kind: 'none' }
  return { kind: 'patch', optimisticStatus: task.status, patch: { state: 'pending' } }
}
