import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Zap, MoreVertical, CheckCircle2, Play, Pause, Trash2 } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import type { ServerMessage } from '@/store/types'
import { getRelativeTime } from '@/data/ui-types'
import {
  useGetWorkspacesQuery,
  usePatchMessageMutation,
  useRunMessageMutation,
  useDeleteMessageMutation,
} from '@/store/api'
import { toUiTask } from '@/store/selectors/tasks'
import { buildTaskStatusMove, buildTaskLifecycleMove } from '@/lib/task-status'
import { buildPath } from '@/router/nav'
import { StatusBadge, PRIORITY_LABELS } from '@/components/tasks/task-badges'
import { describeCron } from '@/components/tasks/schedule-utils'

function errMsg(err: unknown): string | undefined {
  if (typeof err === 'object' && err && 'data' in err) {
    const data = (err as { data?: unknown }).data
    if (typeof data === 'string') return data
    if (typeof data === 'object' && data && 'message' in data) {
      const m = (data as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  return undefined
}

/**
 * Inline task card shown in the chat thread for any `kind:'task'`
 * message (the AI creating a task, or a task brought up in chat).
 * Built on the artifact inline-card shell but task-flavoured: a Zap
 * icon, the task title, a status badge, a subtle meta line, and a
 * View button + kebab (Mark as done / Run now / Pause / Delete) — the
 * same actions as the Tasks-page card. The card itself is not
 * clickable.
 */
export function TaskResultCard({
  message,
  workspaceId,
}: {
  message: ServerMessage
  workspaceId?: string
}) {
  const { data: workspaces } = useGetWorkspacesQuery()
  const [patchMessage] = usePatchMessageMutation()
  const [runMessage] = useRunMessageMutation()
  const [deleteMessage] = useDeleteMessageMutation()

  const task = toUiTask(message, [], [], workspaces ?? [], [])
  const isDone = task.status === 'complete'
  const canRunNow = task.status === 'scheduled'
  const canPause =
    (task.status === 'active' || task.status === 'scheduled') &&
    task.messageState !== 'paused'

  const meta: string[] = [getRelativeTime(task.startedAt)]
  if (task.priority) meta.push(PRIORITY_LABELS[task.priority])
  if (task.schedule?.trim()) meta.push(describeCron(task.schedule.trim()))

  const viewHref = workspaceId
    ? buildPath(workspaceId, 'tasks', { task: message.id })
    : undefined

  const markDone = async () => {
    if (!task.chatId || !task.messageId) return
    const move = buildTaskStatusMove(task, 'complete', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessage({ chatId: task.chatId, messageId: task.messageId, patch: move.patch }).unwrap()
    } catch (err) {
      toast.error('Failed to mark done', { description: errMsg(err) })
    }
  }
  const runNow = async () => {
    if (!task.chatId || !task.messageId) return
    try {
      await runMessage({ chatId: task.chatId, messageId: task.messageId }).unwrap()
    } catch (err) {
      toast.error('Run failed', { description: errMsg(err) })
    }
  }
  const pause = async () => {
    if (!task.chatId || !task.messageId) return
    const move = buildTaskLifecycleMove(task, 'pause', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessage({ chatId: task.chatId, messageId: task.messageId, patch: move.patch }).unwrap()
    } catch (err) {
      toast.error('Pause failed', { description: errMsg(err) })
    }
  }
  const remove = async () => {
    if (!task.chatId || !task.messageId) return
    try {
      await deleteMessage({ chatId: task.chatId, messageId: task.messageId }).unwrap()
    } catch (err) {
      toast.error('Delete failed', { description: errMsg(err) })
    }
  }

  return (
    // Mirror the artifact inline card exactly: one centred row, no
    // footer/separator, actions on the right. Not clickable.
    <div
      className="mt-3 mb-5 flex w-full min-w-0 max-w-full items-center gap-3 rounded-xl border border-foreground/10 bg-background px-4 py-3"
      data-testid={`task-result-${message.id}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/[0.04]">
        <Zap className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">
            {task.title || task.name}
          </span>
          <span className="flex shrink-0 items-center leading-5">
            <StatusBadge status={task.status} small />
          </span>
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {meta.join(' · ')}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {viewHref ? (
          <Button asChild variant="outline" size="sm" className="h-7 px-2.5 text-xs">
            <Link to={viewHref}>View</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled>
            View
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Task actions"
              data-testid={`task-result-menu-${message.id}`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => void markDone()} disabled={isDone}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {isDone ? 'Done' : 'Mark as done'}
            </DropdownMenuItem>
            {canRunNow && (
              <DropdownMenuItem onClick={() => void runNow()}>
                <Play className="h-4 w-4 mr-2" />
                Run now
              </DropdownMenuItem>
            )}
            {canPause && (
              <DropdownMenuItem onClick={() => void pause()}>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void remove()}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
