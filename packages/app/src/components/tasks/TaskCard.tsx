import { Link } from 'react-router-dom'
import {
  MessageSquare,
  CheckCircle2,
  ChevronDown,
  Play,
  Pause,
  RotateCcw,
  Trash2,
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
} from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { initialsOf } from '@/lib/initials'
import { ShowInHomeMenuItem } from '@/components/shared/ShowInHomeMenuItem'
import type { HomePinRef } from '@/hooks/use-home-pins'
import { TaskPills, PRIORITY_LABELS } from './task-badges'
import { describeCron } from './schedule-utils'

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
  /** Owning room name — shown in the meta line (used on Home where
   *  cards are aggregated across rooms). */
  roomName?: string
  /** Owning room accent color — when paired with `roomName` AND no
   *  `roomIconUrl`, renders a small colored ring before the room name
   *  (matches the sidebar's "no custom icon" fallback). */
  roomColor?: string
  /** Owning room icon — when set, renders as a small circular image
   *  before the room name (preferred over the color ring; same rule
   *  the sidebar uses for room rows). */
  roomIconUrl?: string | null
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
  /** Reopen a completed task — moves it back to "todo". When the task
   *  is already in `complete` status, the primary footer button flips
   *  to "Reopen" and calls this. Optional so legacy callers stay
   *  compatible (the button stays disabled if this isn't wired). */
  onReopen?: () => void
  /** Caret menu actions — omitted ones are hidden. */
  onRunNow?: () => void
  onPause?: () => void
  onDelete?: () => void
  /** When provided, adds a "Show in Home" toggle to the kebab. */
  homePinRef?: HomePinRef
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
export function TaskCard({
  task,
  repliesCount = 0,
  authorName = 'You',
  roomName,
  roomColor,
  roomIconUrl,
  authorAvatarUrl,
  isActive = false,
  href,
  onSelect,
  onMarkDone,
  onReopen,
  onRunNow,
  onPause,
  onDelete,
  homePinRef,
  className,
}: TaskCardProps) {
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

  const hasMenu = !!(onRunNow || onPause || onDelete || homePinRef)
  // Don't let footer controls trigger the card-level open.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  return (
    <Link
      to={href}
      draggable={false}
      className={cn(
        'relative flex cursor-pointer flex-col gap-4 rounded-2xl border p-6 no-underline text-inherit transition-colors',
        // Hover state — a `:before` overlay layered ABOVE bg-background
        // and BELOW the card's children (children are made `relative`
        // via `[&>*]:relative` so their stacking context paints on
        // top of the absolute pseudo-element). Replacing `bg-background`
        // on hover instead would let the BackgroundBlobs show through,
        // which read as the card going darker.
        '[&>*]:relative before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:bg-foreground/[0.03] before:opacity-0 before:transition-opacity hover:before:opacity-100',
        isActive
          ? 'border-foreground/40 bg-secondary shadow-sm'
          : cn(
              'bg-background',
              // Needs-input cards get an amber border so they stand
              // out in the list.
              isNeedsInput
                ? 'border-[var(--color-amber-400)]'
                : 'border-border',
            ),
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
            {roomName && (
              <span className="flex shrink-0 items-center gap-1">
                {roomIconUrl ? (
                  <img
                    src={roomIconUrl}
                    alt=""
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full object-cover"
                  />
                ) : roomColor ? (
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full border-2"
                    style={{ borderColor: roomColor }}
                  />
                ) : null}
                <span className="truncate max-w-[10rem]">{roomName}</span>
              </span>
            )}
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
        <p className="text-sm leading-6 text-foreground whitespace-pre-wrap break-words line-clamp-4">
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

        {/* Mark as done / Reopen split button. Done tasks flip the
            primary button to "Reopen" so the action stays one click
            away (moves the task back to "todo"). When the parent
            hasn't wired `onReopen`, the button stays disabled — same
            behaviour as before. */}
        <div className="flex items-center">
          {isDone ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 rounded-r-none"
              onClick={onReopen ? stop(onReopen) : undefined}
              disabled={!onReopen}
              data-testid={`task-reopen-${task.id}`}
            >
              <RotateCcw className="h-4 w-4" />
              Reopen
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 rounded-r-none"
              onClick={stop(onMarkDone)}
              data-testid={`task-done-${task.id}`}
            >
              <CheckCircle2 className="h-4 w-4" />
              Mark as done
            </Button>
          )}
          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 -ml-px rounded-l-none"
                  aria-label="More task actions"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`task-menu-${task.id}`}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
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
                {homePinRef && <ShowInHomeMenuItem pin={homePinRef} />}
                {onDelete && (
                  <DropdownMenuItem onClick={stop(onDelete)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </Link>
  )
}
