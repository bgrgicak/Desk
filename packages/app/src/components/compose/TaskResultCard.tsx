import { Link, useParams } from 'react-router-dom'
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
  useGetChatQuery,
  useGetWorkspacesQuery,
  usePatchMessageMutation,
  useRunMessageMutation,
  useDeleteMessageMutation,
} from '@/store/api'
import { toUiTask } from '@/store/selectors/tasks'
import { buildTaskStatusMove, buildTaskLifecycleMove } from '@/lib/task-status'
import { buildPath, resolveRouteView } from '@/router/nav'
import { StatusBadge, PRIORITY_LABELS } from '@/components/tasks/task-badges'
import { describeCron } from '@/components/tasks/schedule-utils'
import { ShowInHomeMenuItem } from '@/components/shared/ShowInHomeMenuItem'

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
 * kebab (Mark as done / Run now / Pause / Delete) — the same actions
 * as the Tasks-page card. The whole card is a router `<Link>` so
 * clicking opens the task's chat; on the Tasks view it docks the task
 * in the right-hand panel via `?task=<id>`, elsewhere it opens the
 * task's thread chat via `?chat=<threadChatId>`.
 */
export function TaskResultCard({
  message,
  workspaceId,
}: {
  message: ServerMessage
  workspaceId?: string
}) {
  const { data: workspaces } = useGetWorkspacesQuery()
  const { data: chat } = useGetChatQuery(message.chatId, { skip: !message.chatId })
  const [patchMessage] = usePatchMessageMutation()
  const [runMessage] = useRunMessageMutation()
  const [deleteMessage] = useDeleteMessageMutation()
  const { view: viewParam } = useParams<{ view: string }>()
  const activeView = resolveRouteView(viewParam) ?? 'tasks'

  const task = toUiTask(message, [], chat ? [chat] : [], workspaces ?? [], [])
  const isDone = task.status === 'complete'
  const canRunNow =
    task.status === 'scheduled' ||
    task.status === 'active' ||
    task.status === 'todo'
  const canPause =
    (task.status === 'active' || task.status === 'scheduled') &&
    task.messageState !== 'paused'

  const meta: string[] = [getRelativeTime(task.startedAt)]
  if (task.priority) meta.push(PRIORITY_LABELS[task.priority])
  if (task.schedule?.trim()) meta.push(describeCron(task.schedule.trim()))

  // Fall back to the owning chat's workspace when the caller didn't pass
  // one explicitly so the card can still link.
  const wsId = workspaceId ?? chat?.workspaceId
  // On the Tasks view, clicking the card docks the task in the right
  // sidebar via `?task=<id>` (mirrors how TasksPage cards open). On
  // every other view, open the task's dedicated thread chat via
  // `?chat=<threadChatId>` — falling back to the parent chat when the
  // task has no thread of its own.
  const taskChatId = task.threadChatId ?? task.chatId
  const viewHref = wsId
    ? activeView === 'tasks'
      ? buildPath(wsId, 'tasks', { task: message.id })
      : taskChatId
        ? buildPath(wsId, activeView, { chat: taskChatId })
        : undefined
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

  // Card-level click handlers must not let the kebab trigger navigate the
  // outer Link — the trigger sits inside the anchor, so stopPropagation
  // alone leaves the browser's default action intact. preventDefault
  // blocks the navigation; stopPropagation keeps neighbouring handlers
  // (Radix focus management) from re-triggering it.
  const stopNav = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    stopNav(e)
    fn()
  }

  // The whole card is the click target. Falls back to a plain div when
  // we couldn't compute an href (no workspace yet) so the kebab still
  // works. `Wrapper` is typed as the open element-type so the prop union
  // between `Link` (requires `to`) and `div` (forbids it) doesn't trip
  // the `to: To` check at the `<Wrapper {...wrapperProps}>` call site.
  const Wrapper: React.ElementType = viewHref ? Link : 'div'
  const wrapperProps: Record<string, unknown> = viewHref
    ? { to: viewHref, draggable: false }
    : {}

  return (
    // Mirror the artifact inline card exactly: one centred row, no
    // footer/separator, actions on the right. The card itself is the
    // link — clicking anywhere opens the task's chat.
    <Wrapper
      {...wrapperProps}
      className="mt-3 mb-5 flex w-full min-w-0 max-w-full items-center gap-3 rounded-xl border border-foreground/10 bg-background px-4 py-3 no-underline text-inherit transition-colors hover:bg-foreground/[0.02]"
      data-testid={`task-result-${message.id}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/[0.04]">
        <Zap className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Title row: on mobile the status pill drops below the title
            (`flex-wrap`) so it doesn't visually fuse with the kebab on
            the right — at 375 px the title truncates hard, leaving the
            pill butted right up against the menu trigger. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
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

      <div className="flex shrink-0 items-center gap-1 self-start sm:self-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Task actions"
              data-testid={`task-result-menu-${message.id}`}
              onClick={stopNav}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={stop(() => void markDone())} disabled={isDone}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {isDone ? 'Done' : 'Mark as done'}
            </DropdownMenuItem>
            {canRunNow && (
              <DropdownMenuItem onClick={stop(() => void runNow())}>
                <Play className="h-4 w-4 mr-2" />
                Run now
              </DropdownMenuItem>
            )}
            {canPause && (
              <DropdownMenuItem onClick={stop(() => void pause())}>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </DropdownMenuItem>
            )}
            {wsId && (
              <ShowInHomeMenuItem
                pin={{
                  kind: 'task',
                  id: message.id,
                  workspaceId: wsId,
                  label: task.title || task.name,
                }}
              />
            )}
            <DropdownMenuItem onClick={stop(() => void remove())}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Wrapper>
  )
}
