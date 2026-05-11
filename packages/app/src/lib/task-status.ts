import type { Task } from '@/data/ui-types'

export type MessageState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'paused'

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

/**
 * The board column is a user-facing task status. Agent execution creates
 * task_run rows; it should not be the only place that decides where the parent
 * task appears. Keep that policy centralized so drag/drop, selectors and tests
 * do not re-invent slightly different lifecycle rules.
 */
export function taskStatusFromMessage(input: {
  state: MessageState
  executeAt?: string | null
  cron?: string | null
}): Task['status'] {
  if (input.state === 'running') return 'active'
  if (input.state === 'succeeded' || input.state === 'cancelled') return 'complete'
  if (input.executeAt || input.cron) return 'scheduled'
  return 'todo'
}

/**
 * Parent task rows are user-owned: only an explicit user gesture should move
 * the stored task definition between To do / Scheduled / Complete. Agent work
 * is represented as task_run children. The one display exception is Active:
 * while a task_run child is running, the board should show the parent card in
 * Active without rewriting the parent row. That keeps agent lifecycle signals
 * visible without giving agents ownership of the parent task's durable status.
 */
export function taskStatusFromTaskAndRuns(
  task: { state: MessageState; executeAt?: string | null; cron?: string | null },
  runs: Array<{ state?: MessageState }> = [],
): Task['status'] {
  if (runs.some(run => run.state === 'running')) return 'active'
  return taskStatusFromMessage(task)
}

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
