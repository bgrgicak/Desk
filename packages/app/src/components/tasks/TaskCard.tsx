import { memo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  MessageSquare,
  CheckCircle2,
  ChevronDown,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  CalendarClock,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import {
  cn,
  Button,
  Avatar,
  AvatarImage,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@roomy-ai/ui'
import type { Task } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { initialsOf } from '@/lib/initials'
import { TaskPills, PRIORITY_LABELS } from './task-badges'
import { describeCron } from './schedule-utils'
import { SchedulePickerForm, type SchedulePickerValue } from './SchedulePicker'
import { EmbeddedFragmentPreview } from '@/components/shared/EmbeddedFragmentPreview'
import type { LatestAgentMessage } from '@/hooks/use-latest-agent-message'
import { MarkdownContent } from '@/components/MarkdownContent'
import {
  ACTIVITY_CARD_ACTIVE,
  ACTIVITY_CARD_BASE,
  ACTIVITY_CARD_FOOTER_BASE,
  ACTIVITY_CARD_FRAGMENT_FOOTER,
  ACTIVITY_CARD_IDLE,
  ACTIVITY_CARD_MARKDOWN,
  ACTIVITY_CARD_REGULAR_FOOTER,
} from '@/components/shared/activity-card-styles'

/** Fraction (0–1) of the way from the previous run (or the task's
 *  creation) to the next scheduled run. Kept out of the component so
 *  the `Date.now()` read isn't a render-purity violation. */
function nextRunProgressFor(task: Task): number {
  if (!task.nextRun) return 0
  const lastEnd = task.history
    .filter((o) => o.status !== 'scheduled')
    .reduce((max, o) => Math.max(max, o.endedAt.getTime()), 0)
  const start = lastEnd || task.startedAt.getTime()
  const total = task.nextRun.getTime() - start
  return total > 0 ? (Date.now() - start) / total : 0
}

/** Tiny circular progress ring — fraction of the way from the
 *  previous run to the next scheduled run. */
function NextRunRing({ value }: { value: number }) {
  const r = 5
  const circ = 2 * Math.PI * r
  const v = Math.min(1, Math.max(0, value))
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 -rotate-90" aria-hidden>
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="2" className="stroke-foreground/15" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-foreground/50"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - v)}
      />
    </svg>
  )
}

export interface TaskCardProps {
  task: Task
  /** Workspace context for rendering latest fragment previews on Home. */
  workspaceId?: string
  /** Latest supported agent output for this task's backing chat. */
  latestPreview?: LatestAgentMessage
  /** Total messages on the backing chat — the "N replies" button. */
  repliesCount?: number
  /** Display name for the author avatar. Defaults to "You". */
  authorName?: string
  /** Current user's avatar (data URL). Falls back to initials. */
  authorAvatarUrl?: string | null
  /** Selected → its chat is docked in the sidebar; styled like the
   *  chat view's active item card. */
  isActive?: boolean
  /** Destination for the card itself — the docked-chat URL. Rendering
   *  the card as a real anchor lets middle-click / cmd-click open the
   *  task in a new tab. */
  href: string
  /** Open this task's chat in the docked sidebar (the "replies"
   *  button; the card wrapper navigates via {@link href}). */
  onSelect: () => void
  /** Mark the task done / dismiss it. */
  onMarkDone: () => void
  /** Caret menu actions — omitted ones are hidden. */
  onRunNow?: () => void
  onPause?: () => void
  onDelete?: () => void
  /** Reopen a completed task — moves it back to "todo". When omitted,
   *  the menu hides the entry. */
  onReopen?: () => void
  /** Edit the task's schedule (executeAt + cron). Receives the new
   *  value, or `null` to clear the schedule entirely. */
  onSchedule?: (next: SchedulePickerValue | null) => void
  className?: string
}

/**
 * The bulletin-board task row. Store-agnostic (task + callbacks only)
 * so Home can reuse it. Plain cards are router links to the task's
 * docked-chat URL; fragment-preview cards leave the body interactive
 * and keep navigation in the footer Chat action. The footer keeps a
 * "N replies" button (same action) plus a "Mark as done" split (Run
 * now / Pause / Delete). A single status pill sits in the header
 * (Needs input subsumes "unread" — opening the task clears both); an
 * active card gets the chat-view item-card highlight.
 */
export const TaskCard = memo(function TaskCard({
  task,
  workspaceId,
  latestPreview,
  repliesCount = 0,
  authorName = 'You',
  authorAvatarUrl,
  isActive = false,
  href,
  onSelect,
  onMarkDone,
  onRunNow,
  onPause,
  onDelete,
  onReopen,
  onSchedule,
  className,
}: TaskCardProps) {
  const [scheduleOpen, setScheduleOpen] = useState(false)

  // Derive the picker's initial value from the task's current
  // executeAt/cron. The Task UI type carries a free-form `schedule`
  // string (the cron) plus `scheduledFor` (the next run / executeAt).
  const initialSchedule: SchedulePickerValue | null =
    task.schedule || task.scheduledFor
      ? {
          executeAt: task.scheduledFor ? task.scheduledFor.toISOString() : null,
          cron:      task.schedule ?? null,
          endDate:   task.scheduleEndDate
            ? `${task.scheduleEndDate.getFullYear()}-${String(task.scheduleEndDate.getMonth() + 1).padStart(2, '0')}-${String(task.scheduleEndDate.getDate()).padStart(2, '0')}`
            : null,
        }
      : null
  const isDone = task.status === 'complete'
  const isNeedsInput = task.status === 'needs_input'
  const isRunning = task.messageState === 'running'
  const isPaused = task.messageState === 'paused'
  const textPreview = latestPreview?.kind === 'text' ? latestPreview : undefined
  const fragmentPreview =
    isNeedsInput && latestPreview?.kind === 'fragment'
      ? latestPreview
      : undefined
  const isFragmentPreview = !!fragmentPreview
  const displayTime = fragmentPreview?.createdAt ?? textPreview?.createdAt ?? task.startedAt
  const bodyText = textPreview?.text ?? task.description ?? task.name
  // Humanize the raw cron (`describeCron` returns the input unchanged
  // for non-cron / free-form values, so this is safe either way).
  const scheduleText = task.schedule?.trim()
    ? describeCron(task.schedule.trim())
    : undefined
  const nextRunText =
    task.nextRun && !isPaused && task.status !== 'complete'
      ? `Next ${formatDistanceToNow(task.nextRun, { addSuffix: true })}`
      : undefined

  // Meta as plain text fragments, shown after the timestamp.
  const metaParts: string[] = []
  if (task.priority) metaParts.push(PRIORITY_LABELS[task.priority])
  if (isRunning) metaParts.push('Running')
  else if (isPaused) metaParts.push('Paused')
  if (scheduleText && !isRunning) metaParts.push(scheduleText)

  // Ring next to "Next …": how far from the previous run to the next
  // scheduled run we are.
  const showNextRun = !!nextRunText && !isRunning
  const nextRunProgress = showNextRun ? nextRunProgressFor(task) : 0

  const hasMenu = !!(onRunNow || onPause || onDelete || onSchedule || onReopen)
  // Don't let footer controls trigger the card-level open. The card is
  // an `<a>` (react-router Link), so we also preventDefault to stop the
  // anchor's native navigation — stopPropagation alone leaves the
  // browser's default action intact and the task view opens anyway.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    fn()
  }
  const targetIsInteractive = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest('[data-task-card-interactive="true"]')
  const openInNewTab = () => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  const handleFragmentCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.button !== 0) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      openInNewTab()
      return
    }
    onSelect()
  }
  const handleFragmentCardAuxClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.button === 1) openInNewTab()
  }
  const handleFragmentCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (targetIsInteractive(e.target)) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect()
  }

  const cardClassName = cn(
    ACTIVITY_CARD_BASE,
    isFragmentPreview ? 'cursor-default' : 'cursor-pointer',
    isActive
      ? ACTIVITY_CARD_ACTIVE
      : cn(
          ACTIVITY_CARD_IDLE,
          // Needs-input cards get an amber border so they stand
          // out in the list.
          isNeedsInput
            ? 'border-[var(--color-amber-400)]'
            : 'border-border',
        ),
    isDone && !isActive && 'opacity-60',
    className,
  )
  const cardContent = (
    <>
      {/* Header — author + time, unread/status pills right */}
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 shrink-0 select-none">
          {authorAvatarUrl ? (
            <AvatarImage src={authorAvatarUrl} alt={authorName} />
          ) : null}
          <AvatarFallback className="bg-accent text-sm font-semibold text-foreground">
            {initialsOf(authorName)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">{authorName}</span>
          {/* Meta wraps on narrow widths so the schedule/next-run text
              flows below the timestamp instead of running under the
              status pills on the right. Items are spaced with gap-x
              rather than interpunct prefixes — a leading "·" reads as
              a list bullet once items wrap onto their own line. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="truncate">{getRelativeTime(displayTime)}</span>
            {metaParts.map((part) => (
              <span key={part} className="truncate">
                {part}
              </span>
            ))}
            {showNextRun && (
              <span className="flex shrink-0 items-center gap-1">
                <NextRunRing value={nextRunProgress} />
                <span className="truncate">{nextRunText}</span>
              </span>
            )}
          </span>
        </div>
        <div className="shrink-0">
          <TaskPills status={task.status} />
        </div>
      </div>

      {/* Title (AI-generated, like a chat title) + the body message */}
      <div className="flex flex-col gap-3">
        {task.title && (
          <h3 className="text-base font-semibold leading-6 text-foreground break-words">
            {task.title}
          </h3>
        )}
        {fragmentPreview ? (
          <EmbeddedFragmentPreview
            workspaceId={fragmentPreview.artifact.workspaceId ?? workspaceId}
            chatId={task.threadChatId ?? task.chatId}
            path={fragmentPreview.artifact.path}
            name={fragmentPreview.artifact.name}
            mime={fragmentPreview.artifact.mime}
            params={fragmentPreview.artifact.params}
            testId="home-task-fragment-preview"
            interactiveAttribute="data-task-card-interactive"
          />
        ) : (
          <MarkdownContent
            text={bodyText}
            renderLinks={false}
            className={ACTIVITY_CARD_MARKDOWN}
          />
        )}
      </div>

      {/* Footer */}
      <div
        className={cn(
          ACTIVITY_CARD_FOOTER_BASE,
          isFragmentPreview
            ? ACTIVITY_CARD_FRAGMENT_FOOTER
            : ACTIVITY_CARD_REGULAR_FOOTER,
        )}
        data-task-card-interactive="true"
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={stop(onSelect)}
          data-testid={`task-replies-${task.id}`}
        >
          <MessageSquare className="h-4 w-4" />
          {repliesCount > 0 ? `Chat (${repliesCount})` : 'Chat'}
        </Button>

        {/* Mark as done split button */}
        <div className="flex items-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 rounded-r-none"
            onClick={stop(onMarkDone)}
            disabled={isDone}
            data-testid={`task-done-${task.id}`}
          >
            <CheckCircle2 className="h-4 w-4" />
            {isDone ? 'Done' : 'Mark as done'}
          </Button>
          {hasMenu && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 -ml-px rounded-l-none"
                    aria-label="More task actions"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    data-testid={`task-menu-${task.id}`}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-44"
                  onClick={(e) => e.stopPropagation()}
                >
                  {onReopen && (
                    <DropdownMenuItem
                      onClick={stop(onReopen)}
                      data-testid={`task-reopen-${task.id}`}
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Reopen
                    </DropdownMenuItem>
                  )}
                  {onRunNow && (
                    <DropdownMenuItem onClick={stop(onRunNow)}>
                      <Play className="h-4 w-4 mr-2" />
                      Run now
                    </DropdownMenuItem>
                  )}
                  {onPause && (
                    <DropdownMenuItem onClick={stop(onPause)}>
                      <Pause className="h-4 w-4 mr-2" />
                      Pause
                    </DropdownMenuItem>
                  )}
                  {onSchedule && (
                    <DropdownMenuItem
                      // Defer the dialog open by a tick so Radix can
                      // tear down the dropdown's focus scope first.
                      // Without the gap the menu's focus-return briefly
                      // re-trips the dialog's "outside interaction"
                      // detector and the dialog closes as fast as it
                      // mounts.
                      onClick={(e) => {
                        e.stopPropagation()
                        setTimeout(() => setScheduleOpen(true), 0)
                      }}
                      data-testid={`task-schedule-${task.id}`}
                    >
                      <CalendarClock className="h-4 w-4 mr-2" />
                      {initialSchedule ? 'Edit schedule' : 'Schedule'}
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem onClick={stop(onDelete)}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Schedule editor — Dialog (modal). Earlier iterations
                  used a Popover anchored to the caret button, but the
                  dropdown-menu → popover handoff lost the popover to
                  focus competition: Radix DropdownMenu returns focus to
                  its trigger as it unmounts, which fires immediately
                  after the popover mounts and closes it. Dialog runs
                  its own focus trap so the bounce no longer dismisses
                  the editor. */}
              {onSchedule && (
                <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
                  <DialogContent
                    className="sm:max-w-md p-4"
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`task-schedule-dialog-${task.id}`}
                  >
                    <DialogTitle className="text-sm font-semibold">
                      {initialSchedule ? 'Edit schedule' : 'Schedule task'}
                    </DialogTitle>
                    <SchedulePickerForm
                      initial={initialSchedule}
                      onSave={(next) => {
                        onSchedule?.(next)
                        setScheduleOpen(false)
                      }}
                      onCancel={() => setScheduleOpen(false)}
                    />
                  </DialogContent>
                </Dialog>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )

  if (isFragmentPreview) {
    return (
      <div
        role="link"
        tabIndex={0}
        className={cardClassName}
        data-testid={`task-card-${task.id}`}
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
      to={href}
      draggable={false}
      className={cardClassName}
      data-testid={`task-card-${task.id}`}
    >
      {cardContent}
    </Link>
  )
})
