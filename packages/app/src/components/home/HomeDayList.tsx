import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronDown, CircleDot, MessageSquare, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@roomy-ai/ui'
import type { HomeDayChatItem, HomeDayItem, HomeDayTaskItem } from '@/store/types'
import { getRelativeTime } from '@/data/ui-types'
import { roomColor } from '@/components/rooms/roomColor'
import { useLatestAgentMessage } from '@/hooks/use-latest-agent-message'
import { EmbeddedFragmentPreview } from '@/components/shared/EmbeddedFragmentPreview'
import { MarkdownContent } from '@/components/MarkdownContent'
import { TaskCard } from '@/components/tasks/TaskCard'
import { TaskPills } from '@/components/tasks/task-badges'
import { useTaskActions } from '@/components/tasks/useTaskActions'
import { toUiTask } from '@/store/selectors/tasks'
import {
  useDeleteChatMutation,
  usePatchChatMutation,
  useRunMessageMutation,
} from '@/store/api'
import { extractApiError } from '@/lib/api-error'
import {
  ACTIVITY_CARD_BASE,
  ACTIVITY_CARD_FOOTER_BASE,
  ACTIVITY_CARD_FRAGMENT_FOOTER,
  ACTIVITY_CARD_IDLE,
  ACTIVITY_CARD_MARKDOWN,
  ACTIVITY_CARD_REGULAR_FOOTER,
} from '@/components/shared/activity-card-styles'

interface HomeDayListProps {
  items: HomeDayItem[]
}

const COLLAPSED_LIMIT = 5

function HomeTaskDayCard({ item }: { item: HomeDayTaskItem }) {
  const navigate = useNavigate()
  const taskActions = useTaskActions()
  const task = toUiTask(item.task, [], [], [], [])
  const latestPreview = useLatestAgentMessage(task.threadChatId ?? task.chatId)
  const canRunNow =
    task.status === 'scheduled' ||
    task.status === 'todo' ||
    task.status === 'complete' ||
    task.status === 'failed'
  const canPause =
    (task.status === 'active' || task.status === 'scheduled') &&
    task.messageState !== 'paused'

  return (
    <TaskCard
      task={task}
      workspaceId={item.room.id}
      latestPreview={latestPreview}
      authorName={item.room.name}
      href={item.href}
      onSelect={() => navigate(item.href)}
      onMarkDone={() => void taskActions.onMarkDone(task)}
      onRunNow={canRunNow ? () => void taskActions.onRunNow(task) : undefined}
      onPause={canPause ? () => void taskActions.onPause(task) : undefined}
      onSchedule={(next) => void taskActions.onSchedule(task, next)}
      onReopen={task.status === 'complete' ? () => void taskActions.onReopen(task) : undefined}
      onDelete={() => void taskActions.onDelete(task)}
    />
  )
}

function chatPillStatus(status: HomeDayChatItem['status']) {
  return status === 'done' ? 'complete' : status
}

function HomeChatDayCard({ item }: { item: HomeDayChatItem }) {
  const navigate = useNavigate()
  const [patchChat] = usePatchChatMutation()
  const [deleteChat] = useDeleteChatMutation()
  const [runMessage] = useRunMessageMutation()
  const latestPreview = useLatestAgentMessage(item.id)
  const textPreview = latestPreview?.kind === 'text' ? latestPreview : undefined
  const fragmentPreview =
    item.status === 'needs_input' && latestPreview?.kind === 'fragment'
      ? latestPreview
      : undefined
  const previewText = textPreview?.text ?? item.preview
  const isFragmentPreview = !!fragmentPreview
  const displayTime = fragmentPreview?.createdAt ?? textPreview?.createdAt ?? new Date(item.updatedAt)
  const canRetry = !!item.chat.latestFailedMessageId
  const targetIsInteractive = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest('[data-home-day-card-interactive="true"]')
  const openInNewTab = () => {
    window.open(item.href, '_blank', 'noopener,noreferrer')
  }
  const handleFragmentCardClick = (e: MouseEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.button !== 0) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      openInNewTab()
      return
    }
    navigate(item.href)
  }
  const handleFragmentCardAuxClick = (e: MouseEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.button === 1) openInNewTab()
  }
  const handleFragmentCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    navigate(item.href)
  }
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    fn()
  }
  const openChat = () => navigate(item.href)
  const markRead = async () => {
    try {
      await patchChat({ id: item.chat.id, patch: { unread: false } }).unwrap()
    } catch (err) {
      toast.error('Failed to mark read', { description: extractApiError(err) })
    }
  }
  const retryFailedTurn = async () => {
    const messageId = item.chat.latestFailedMessageId
    if (!messageId) return
    try {
      await runMessage({ chatId: item.chat.id, messageId }).unwrap()
    } catch (err) {
      toast.error('Retry failed', { description: extractApiError(err) })
    }
  }
  const removeChat = async () => {
    try {
      await deleteChat(item.chat.id).unwrap()
    } catch (err) {
      toast.error('Delete failed', { description: extractApiError(err) })
    }
  }
  const cardClassName = cn(
    ACTIVITY_CARD_BASE,
    isFragmentPreview ? 'cursor-default' : 'cursor-pointer',
    ACTIVITY_CARD_IDLE,
    item.status === 'needs_input'
      ? 'border-[var(--color-amber-400)]'
      : 'border-border',
    item.status === 'done' && 'opacity-60',
  )

  const cardContent = (
    <>
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 h-10 w-10 shrink-0 rounded-full border-2 bg-background"
          style={{ borderColor: roomColor(item.room.color) }}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{item.room.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {getRelativeTime(displayTime)}
          </span>
        </div>
        <div className="shrink-0">
          <TaskPills status={chatPillStatus(item.status)} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold leading-6 text-foreground break-words">
          {item.title}
        </h3>
        {fragmentPreview ? (
          <EmbeddedFragmentPreview
            workspaceId={fragmentPreview.artifact.workspaceId ?? item.room.id}
            chatId={item.id}
            path={fragmentPreview.artifact.path}
            name={fragmentPreview.artifact.name}
            mime={fragmentPreview.artifact.mime}
            params={fragmentPreview.artifact.params}
            testId="home-day-fragment-preview"
            interactiveAttribute="data-home-day-card-interactive"
          />
        ) : previewText && previewText !== item.title ? (
          <MarkdownContent
            text={previewText}
            renderLinks={false}
            className={ACTIVITY_CARD_MARKDOWN}
          />
        ) : null}
      </div>

      <div
        className={cn(
          ACTIVITY_CARD_FOOTER_BASE,
          isFragmentPreview
            ? ACTIVITY_CARD_FRAGMENT_FOOTER
            : ACTIVITY_CARD_REGULAR_FOOTER,
        )}
        data-home-day-card-interactive="true"
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={stop(openChat)}
          data-testid={`home-day-open-chat-${item.id}`}
        >
          <MessageSquare className="h-4 w-4" />
          Chat
        </Button>

        {item.chat.unread ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={stop(() => void markRead())}
            data-testid={`home-day-mark-read-${item.id}`}
          >
            <CheckCircle2 className="h-4 w-4" />
            Mark read
          </Button>
        ) : canRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={stop(() => void retryFailedTurn())}
            data-testid={`home-day-retry-chat-${item.id}`}
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled
          >
            {item.status === 'active' ? (
              <CircleDot className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {item.status === 'active' ? 'Running' : 'Done'}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label="More chat actions"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              data-testid={`home-day-chat-menu-${item.id}`}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-44"
            onClick={(e) => e.stopPropagation()}
          >
            {item.chat.unread && canRetry && (
              <DropdownMenuItem onClick={stop(() => void retryFailedTurn())}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Try again
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={stop(() => void removeChat())}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )

  if (isFragmentPreview) {
    return (
      <div
        role="link"
        tabIndex={0}
        className={cardClassName}
        data-testid={`home-day-item-${item.id}`}
        onClick={handleFragmentCardClick}
        onAuxClick={handleFragmentCardAuxClick}
        onKeyDown={handleFragmentCardKeyDown}
      >
        {cardContent}
      </div>
    )
  }

  return (
    <Link
      to={item.href}
      draggable={false}
      className={cardClassName}
      data-testid={`home-day-item-${item.id}`}
    >
      {cardContent}
    </Link>
  )
}

export function HomeDayList({ items }: HomeDayListProps) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, COLLAPSED_LIMIT)
  const hidden = items.length - visible.length

  return (
    <div className="flex flex-col gap-3">
      {visible.map(item => (
        item.kind === 'task'
          ? <HomeTaskDayCard key={item.id} item={item} />
          : <HomeChatDayCard key={item.id} item={item} />
      ))}
      {hidden > 0 && (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setExpanded(true)}
            data-testid="home-day-list-show-more"
          >
            Show {hidden} more
          </Button>
        </div>
      )}
    </div>
  )
}
