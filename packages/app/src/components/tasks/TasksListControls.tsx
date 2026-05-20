import { useState } from 'react'
import { motion } from 'framer-motion'
import { ListFilter, Search, X } from 'lucide-react'
import {
  cn,
  Button,
  Switch,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
} from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import type { ServerAgent } from '@/store/types'
import { STATUS_DOT } from './task-badges'

// ── Status tabs ───────────────────────────────────────────────────────────

export type TaskTab = 'all' | Task['status']

const TABS: { key: TaskTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'todo', label: 'Todo' },
  { key: 'needs_input', label: 'Needs input' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'complete', label: 'Done' },
]

// ── Filters (the funnel popover) ──────────────────────────────────────────

export type TaskSort = 'recent' | 'newest'

export interface TaskListFilters {
  /** null = all assignees; 'you' = tasks you created; else an agent id. */
  assigneeId: string | null
  /** Hide `complete` tasks unless true. Default false. */
  showDone: boolean
  /** `recent` (default) = most recent activity first. `newest` =
   *  creation date desc. */
  sort: TaskSort
}

export const DEFAULT_TASK_FILTERS: TaskListFilters = {
  assigneeId: null,
  showDone: false,
  sort: 'recent',
}

export function isTaskFiltersActive(f: TaskListFilters): boolean {
  return (
    f.assigneeId !== null ||
    f.showDone !== DEFAULT_TASK_FILTERS.showDone ||
    f.sort !== DEFAULT_TASK_FILTERS.sort
  )
}

interface TaskTabsProps {
  tab: TaskTab
  onTabChange: (tab: TaskTab) => void
  /** Task count per tab (for the inline counter). */
  counts: Record<TaskTab, number>
  className?: string
}

/**
 * The status-tab pill row (All / Todo / Needs input / …). Lives in
 * the global top bar (same row as the breadcrumb), pixel-aligned over
 * the task list column.
 */
export function TaskTabs({ tab, onTabChange, counts, className }: TaskTabsProps) {
  return (
    // Right-edge fade hints at off-screen tabs when the strip
    // overflows on narrow viewports (375 px doesn't fit all six
    // chips). The fade itself is the only affordance — there is no
    // scrollbar on mobile — so it must not be hidden by the chip
    // hover/active background, hence wrapping rather than masking the
    // scroll container directly.
    <div className={cn('relative min-w-0', className)}>
      <div
        className="flex items-center gap-1 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TABS.map(t => {
          const active = tab === t.key
          // Always render the count (including 0) so a tab never
          // silently drops its number — the prior `count > 0` gate
          // hid "Scheduled 0" / "Done 0", which made the strip
          // visually inconsistent.
          const count = counts[t.key] ?? 0
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              className={cn(
                // Every tab keeps its own padding + a subtle hover/
                // resting background so labels and counts read as
                // distinct chips when the strip overflows on narrow
                // viewports. The active tab gets a stronger pill via
                // the framer `layoutId` span below.
                'relative shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
              data-testid={`task-tab-${t.key}`}
            >
              {active && (
                <motion.span
                  layoutId="task-tab-active"
                  className="absolute inset-0 rounded-full bg-secondary"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <span className="relative z-10 inline-flex items-center gap-1.5">
                {/* Status dot — matches the status badge colour for
                    each state; "All" stays a neutral dark gray. */}
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    t.key === 'all' ? 'bg-foreground/40' : STATUS_DOT[t.key],
                  )}
                />
                {t.label}
                <span
                  className={cn(
                    'tabular-nums text-xs',
                    active ? 'text-secondary-foreground/70' : 'text-muted-foreground/70',
                  )}
                >
                  {count}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {/* Edge-fade indicator — bleeds the rightmost chip into the
          background so the user knows the strip scrolls. Sits above
          the scroll row, pointer-events-none so it doesn't block
          drag/tap. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
      />
    </div>
  )
}

interface TaskFilterSearchProps {
  filters: TaskListFilters
  onFiltersChange: (f: TaskListFilters) => void
  agents: ServerAgent[]
  /** Active room name — labels the agent assignee option. */
  roomName?: string
  search: string
  onSearchChange: (q: string) => void
}

/**
 * The filter (funnel) popover + search toggle. Stays at the top of
 * the list area (right-aligned) — the tab pills moved up into the top
 * bar, so this is all that remains of the old controls row.
 */
export function TaskFilterSearch({
  filters,
  onFiltersChange,
  agents,
  roomName,
  search,
  onSearchChange,
}: TaskFilterSearchProps) {
  const filtersActive = isTaskFiltersActive(filters)
  // Pending edits are only committed on Apply (mirrors the chat
  // filter popover); Cancel / dismiss reverts.
  const [filterOpen, setFilterOpen] = useState(false)
  const [pending, setPending] = useState<TaskListFilters>(filters)
  const openFilter = (open: boolean) => {
    if (open) setPending(filters)
    setFilterOpen(open)
  }
  const applyFilter = () => {
    onFiltersChange(pending)
    setFilterOpen(false)
  }
  return (
    // `gap-3` between filter and search so the two icon buttons don't
    // visually fuse on mobile (the previous `gap-2 = 8 px` looked
    // adjoined against the topbar's grey hover background).
    <div className="flex items-center gap-3">
      <Popover open={filterOpen} onOpenChange={openFilter}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8 shrink-0', filtersActive && 'text-primary')}
            aria-label="Filter tasks"
            data-testid="task-filter-button"
          >
            <ListFilter className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-3">
          <label className="mb-2 block text-xs font-medium text-muted-foreground">
            Assignee
          </label>
          <RadioGroup
            value={pending.assigneeId ?? '__all__'}
            onValueChange={(v) =>
              setPending({ ...pending, assigneeId: v === '__all__' ? null : v })
            }
            className="mb-4 flex flex-col gap-2"
          >
            {[
              { id: '__all__', name: 'Everyone' },
              { id: 'you', name: 'You' },
              ...agents.map(a => ({ id: a.id, name: roomName ?? a.name })),
            ].map(opt => (
              <label
                key={opt.id}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <RadioGroupItem value={opt.id} />
                {opt.name}
              </label>
            ))}
          </RadioGroup>

          <label className="mb-2 block text-xs font-medium text-muted-foreground">
            Sort
          </label>
          <RadioGroup
            value={pending.sort}
            onValueChange={(v) =>
              setPending({ ...pending, sort: v as TaskSort })
            }
            className="flex flex-col gap-2"
          >
            {([
              ['recent', 'Recent first'],
              ['newest', 'Newest first'],
            ] as [TaskSort, string][]).map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <RadioGroupItem value={key} />
                {label}
              </label>
            ))}
          </RadioGroup>

          <label className="mt-4 flex items-center justify-between gap-2 py-1 text-sm">
            <span>Show done</span>
            <Switch
              checked={pending.showDone}
              onCheckedChange={(v) => setPending({ ...pending, showDone: v })}
            />
          </label>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setFilterOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={applyFilter}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8 shrink-0', search && 'text-primary')}
            aria-label="Search tasks"
            data-testid="task-search-button"
          >
            <Search className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search tasks…"
              className="h-9 w-full rounded-md border bg-background pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring/40 focus:ring-2 focus:ring-ring/20"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
