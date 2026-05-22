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
} from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { initialsOf } from '@/lib/initials'
import { TaskPills, PRIORITY_LABELS } from './task-badges'
import { describeCron } from './schedule-utils'
import { SchedulePickerForm, type SchedulePickerValue } from './SchedulePicker'

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
 * so Home can reuse it. The whole card is a router `<Link>` to the
 * task's docked-chat URL so middle-click / cmd-click opens it in a
 * new tab; the footer keeps a "N replies" button (same action) plus a
 * "Mark as done" split (Run now / Pause / Delete). A single status pill
 * sits in the header (Needs input subsumes "unread" — opening the task
 * clears both); an active card gets the chat-view item-card highlight.
 */
export const TaskCard = memo(function TaskCard({
  task,
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

  return (
    <Link
      to={href}
      draggable={false}
      className={cn(
        'flex cursor-pointer flex-col gap-4 rounded-2xl border p-6 no-underline text-inherit transition-colors',
        isActive
          ? 'border-foreground/40 bg-secondary shadow-sm'
          : cn(
              'bg-background hover:bg-foreground/[0.02]',
              // Needs-input cards get an amber border so they stand
              // out in the list.
              isNeedsInput
                ? 'border-[var(--color-amber-400)]'
                : 'border-border',
            ),
        isDone && !isActive && 'opacity-60',
        className,
      )}
      data-testid={`task-card-${task.id}`}
    >
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
            <span className="truncate">{getRelativeTime(task.startedAt)}</span>
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
      <div className="flex flex-col gap-1.5">
        {task.title && (
          <h3 className="text-base font-semibold leading-6 text-foreground break-words">
            {task.title}
          </h3>
        )}
        <p className="line-clamp-2 text-sm leading-6 text-foreground break-words">
          {task.description ?? task.name}
        </p>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={stop(onSelect)}
          data-testid={`task-replies-${task.id}`}
        >
          <MessageSquare className="h-4 w-4" />
          {repliesCount > 0 ? `${repliesCount} replies` : 'Replies'}
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
    </Link>
  )
})
