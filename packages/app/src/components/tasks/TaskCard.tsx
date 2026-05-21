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
import {
  cn,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { ShowInHomeMenuItem } from '@/components/shared/ShowInHomeMenuItem'
import { useLatestAgentMessage } from '@/hooks/use-latest-agent-message'
import type { HomePinRef } from '@/hooks/use-home-pins'
import { TaskPills } from './task-badges'

export interface TaskCardProps {
  task: Task
  /** Total messages on the backing chat — the "N replies" button. */
  repliesCount?: number
  /** Accepted for backward compatibility (legacy callers still pass
   *  the requester's display name and avatar). The redesigned card
   *  shows the *room* avatar at the bottom instead, so these are
   *  currently unused — kept on the prop surface so removing them
   *  doesn't ripple through every call site. */
  authorName?: string
  authorAvatarUrl?: string | null
  /** Owning room name — shown next to the room avatar at the bottom
   *  of the card. */
  roomName?: string
  /** Owning room accent color — backs the room-avatar swatch when no
   *  `roomIconUrl` is set; falls back to a neutral background if also
   *  no name is provided. */
  roomColor?: string
  /** Owning room icon — when set, renders as the small rounded
   *  thumbnail at the bottom of the card. Falls back to initials on a
   *  colored swatch when absent. */
  roomIconUrl?: string | null
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
   *  is already in `complete` status, the primary action button flips
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

/** Small round room icon shown at the bottom of the card — identical
 *  affordance to the rooms list in the Home sidebar: the uploaded
 *  workspace icon when present, otherwise a colored ring (not a
 *  filled swatch with initials, so the bottom meta line stays light
 *  and the ring colour reads as a room marker). */
function RoomAvatar({
  roomColor,
  roomIconUrl,
}: {
  roomColor?: string
  roomIconUrl?: string | null
}) {
  if (roomIconUrl) {
    return (
      <img
        src={roomIconUrl}
        alt=""
        aria-hidden
        className="h-4 w-4 shrink-0 rounded-full object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="h-4 w-4 shrink-0 rounded-full border-2"
      style={{ borderColor: roomColor ?? 'var(--color-slate-400)' }}
    />
  )
}

/**
 * The task card used on Home and the Tasks list (Figma 742-8340).
 *
 * Layout — top to bottom:
 *   1. Status pill (left) + Replies / Mark-as-done split (right).
 *   2. Task title (bold) + body preview (`line-clamp-4`). The body
 *      shows the latest agent message in the task's chat when one
 *      exists, otherwise the user's original task body — see
 *      `useLatestAgentMessage`.
 *   3. Room avatar + room name · last-update time.
 *
 * The whole card is a router `<Link>` to its docked-chat URL so
 * middle-click / cmd-click opens the task in a new tab.
 *
 * The card uses `px-6 pt-6` matching the standard p-6 padding, but a
 * custom `pb-[20px]` (intentionally off the Tailwind scale) — the
 * bottom meta line reads heavier than a single-line of body so the
 * visual balance wants slightly less padding underneath than above.
 */
export function TaskCard({
  task,
  repliesCount = 0,
  roomName,
  roomColor,
  roomIconUrl,
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

  const hasMenu = !!(onRunNow || onPause || onDelete || homePinRef)
  // Don't let action-row controls trigger the card-level link.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }

  // Latest agent reply in the task's chat — preferred body content +
  // last-update timestamp. Falls back to the user's original task body
  // and creation date when the agent hasn't responded yet (or for
  // mock-data cards with no real chat).
  const latest = useLatestAgentMessage(task.chatId)
  const bodyPreview = latest?.text ?? task.description ?? task.name
  const lastUpdateAt = latest?.createdAt ?? task.startedAt

  return (
    <Link
      to={href}
      draggable={false}
      className={cn(
        'relative flex cursor-pointer flex-col rounded-2xl border px-6 pt-6 pb-[20px] no-underline text-inherit transition-colors',
        // Hover state — a `:before` overlay layered ABOVE bg-background
        // and BELOW the card's children (children are made `relative`
        // via `[&>*]:relative` so their stacking context paints on
        // top of the absolute pseudo-element). Replacing `bg-background`
        // on hover instead would let the BackgroundBlobs show through,
        // which read as the card going darker.
        '[&>*]:relative before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:bg-foreground/[0.03] before:opacity-0 before:transition-opacity hover:before:opacity-100',
        isActive
          ? 'border-foreground/40 bg-secondary shadow-sm'
          : 'bg-background border-border',
        className,
      )}
      data-testid={`task-card-${task.id}`}
    >
      {/* Top row — status pill (left) + Replies + Mark-as-done /
          Reopen split (right). */}
      <div className="flex items-center justify-between gap-2">
        <TaskPills status={task.status} />
        <div className="flex items-center gap-2">
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
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
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
      </div>

      {/* Title + body preview. `mt-3` = 12 px between the action
          row and the title; `flex-1` absorbs extra height when the
          card is stretched to a row's common height so the bottom
          meta line stays anchored. */}
      <div className="mt-3 flex flex-1 flex-col gap-1.5">
        <h3 className="text-base font-semibold leading-6 text-foreground break-words">
          {task.title || task.name}
        </h3>
        <p className="text-sm leading-6 text-foreground whitespace-pre-wrap break-words line-clamp-4">
          {bodyPreview}
        </p>
      </div>

      {/* Bottom meta — room avatar + name · last update time.
          `mt-3` = 12 px between the body and the meta line. The
          outer wrapper handles the 8 px avatar→text gap; the inner
          wrapper uses a tighter `gap-1` (4 px) so the `·` separator
          hugs the text on either side. */}
      <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <RoomAvatar roomColor={roomColor} roomIconUrl={roomIconUrl} />
        <div className="flex min-w-0 items-center gap-1">
          {roomName && (
            <>
              <span className="truncate max-w-[12rem]">{roomName}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="truncate">{getRelativeTime(lastUpdateAt)}</span>
        </div>
      </div>
    </Link>
  )
}
