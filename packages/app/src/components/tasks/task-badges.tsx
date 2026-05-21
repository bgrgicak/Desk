import { ChevronsUp, ArrowUp, Minus, ArrowDown, MessageCircleQuestion, CircleDot, CheckCircle2, CalendarClock } from 'lucide-react'
import type { Task } from '@/data/ui-types'

export type Priority = NonNullable<Task['priority']>

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<Task['status'], { label: string; bg: string; text: string; dot: string }> = {
  todo:        { label: 'Open',        bg: 'bg-slate-100',   text: 'text-slate-600',   dot: 'bg-slate-400'   },
  active:      { label: 'Active',      bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-500'    },
  needs_input: { label: 'Needs input', bg: 'bg-amber-100',   text: 'text-amber-700',   dot: 'bg-amber-500'   },
  complete:    { label: 'Done',        bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  scheduled:   { label: 'Scheduled',   bg: 'bg-violet-100',  text: 'text-violet-700',  dot: 'bg-violet-500'  },
  failed:      { label: 'Failed',      bg: 'bg-red-100',     text: 'text-red-700',     dot: 'bg-red-500'     },
}

export const STATUS_LABELS: Record<Task['status'], string> = {
  todo: 'Open', active: 'Active', needs_input: 'Needs input', complete: 'Done', scheduled: 'Scheduled', failed: 'Failed',
}

/** The per-status dot colour (Tailwind bg-* class), shared with the
 *  Tasks tab pills so a tab's dot matches its status badge. */
export const STATUS_DOT: Record<Task['status'], string> = {
  todo: STATUS_CONFIG.todo.dot,
  active: STATUS_CONFIG.active.dot,
  needs_input: STATUS_CONFIG.needs_input.dot,
  complete: STATUS_CONFIG.complete.dot,
  scheduled: STATUS_CONFIG.scheduled.dot,
  failed: STATUS_CONFIG.failed.dot,
}

export function StatusBadge({ status, small }: { status: Task['status']; small?: boolean }) {
  const { label, bg, text, dot } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${bg} ${text} ${
      small
        ? 'gap-1 px-2 py-px text-[11px]'
        : 'gap-1.5 px-2.5 py-0.5 text-xs'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
      {label}
    </span>
  )
}

// ── Redesigned task-card pills (Figma 568-7586 / 580-9462) ────────────────────
// The card shows a single status pill on the right. "Needs input" used
// to coexist with a separate "N unread" pill, but with the tightened
// `unread` semantics they are the same signal — `chat.unread` only
// flips on agent activity, and that's exactly what drives `needs_input`.
// Showing both was redundant. Opening the task clears `unread`, which
// drops the card back to "To do" on the next render.

function Pill({
  icon: Icon,
  label,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className: string
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${className}`}>
      <Icon className="h-3 w-3 shrink-0" />
      {label}
    </span>
  )
}

export function TaskPills({ status }: { status: Task['status'] }) {
  if (status === 'complete') {
    return <Pill icon={CheckCircle2} label="Done" className="bg-emerald-100 text-emerald-700" />
  }
  if (status === 'needs_input') {
    return <Pill icon={MessageCircleQuestion} label="Needs input" className="bg-amber-100 text-amber-700" />
  }
  if (status === 'scheduled') {
    return <Pill icon={CalendarClock} label="Scheduled" className="bg-violet-100 text-violet-700" />
  }
  if (status === 'active') {
    return <Pill icon={CircleDot} label="Active" className="bg-blue-500 text-white" />
  }
  return <Pill icon={CircleDot} label="Open" className="bg-blue-500 text-white" />
}

// ── Priority badge ─────────────────────────────────────────────────────────────

export const PRIORITY_CONFIG: Record<Priority, {
  label: string
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
}> = {
  highest: { label: 'Highest', icon: ChevronsUp, iconClass: 'text-red-500'          },
  high:    { label: 'High',    icon: ArrowUp,    iconClass: 'text-orange-400'        },
  medium:  { label: 'Medium',  icon: Minus,      iconClass: 'text-muted-foreground'  },
  low:     { label: 'Low',     icon: ArrowDown,  iconClass: 'text-muted-foreground/60' },
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low',
}

export function PriorityIcon({ priority, className }: { priority?: Priority; className?: string }) {
  if (!priority) return null
  const { icon: Icon, iconClass } = PRIORITY_CONFIG[priority]
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass} ${className ?? ''}`} />
}
