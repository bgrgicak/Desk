import { ChevronsUp, ArrowUp, Minus, ArrowDown } from 'lucide-react'
import type { Task } from '@/data/ui-types'

export type Priority = NonNullable<Task['priority']>

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<Task['status'], { label: string; bg: string; text: string; dot: string }> = {
  todo:      { label: 'To do',     bg: 'bg-slate-100',    text: 'text-slate-600',    dot: 'bg-slate-400'    },
  active:    { label: 'Active',    bg: 'bg-blue-100',     text: 'text-blue-700',     dot: 'bg-blue-500'     },
  complete:  { label: 'Complete',  bg: 'bg-emerald-100',  text: 'text-emerald-700',  dot: 'bg-emerald-500'  },
  scheduled: { label: 'Scheduled', bg: 'bg-amber-100',    text: 'text-amber-700',    dot: 'bg-amber-500'    },
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
