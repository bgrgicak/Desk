import { useState, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarRange,
  List,
  Search,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RunDetailPanel } from './RunDetailPanel'
import type { Run, RunOccurrence } from '@/data/ui-types'

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode   = 'month' | 'week' | 'list'
type StatusFilter = 'all' | 'active' | 'completed' | 'cancelled' | 'failed'

interface RunsPageProps {
  runs: Run[]
  onCompose: () => void
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',       label: 'All'       },
  { value: 'active',    label: 'Active'    },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed',    label: 'Failed'    },
]

// ─── Calendar helpers ─────────────────────────────────────────────────────────

function getCalendarWeeks(year: number, month: number): Date[][] {
  const firstDay  = new Date(year, month, 1)
  const lastDay   = new Date(year, month + 1, 0)
  const startDate = new Date(firstDay)
  startDate.setDate(firstDay.getDate() - firstDay.getDay())
  const endDate = new Date(lastDay)
  endDate.setDate(lastDay.getDate() + (6 - lastDay.getDay()))
  const weeks: Date[][] = []
  let current = new Date(startDate)
  while (current <= endDate) {
    const week: Date[] = []
    for (let i = 0; i < 7; i++) { week.push(new Date(current)); current.setDate(current.getDate() + 1) }
    weeks.push(week)
  }
  return weeks
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// ─── Per-day occurrences helper ───────────────────────────────────────────────

function getOccurrencesForDay(day: Date, runs: Run[]): { run: Run; occ: RunOccurrence }[] {
  const d = dateOnly(day)
  const result: { run: Run; occ: RunOccurrence }[] = []
  for (const run of runs) {
    for (const occ of run.history ?? []) {
      if (dateOnly(occ.startedAt) <= d && dateOnly(occ.endedAt) >= d) {
        result.push({ run, occ })
      }
    }
  }
  return result
}

// ─── Status icon (small) ──────────────────────────────────────────────────────

function RunStatusIconSmall({ status, isFailed }: { status: Run['status'] | RunOccurrence['status']; isFailed?: boolean }) {
  const cls = isFailed ? 'text-red-500' : ''
  switch (status) {
    case 'active':    return <Loader2    className={`h-3 w-3 shrink-0 animate-spin text-blue-500`} />
    case 'completed': return <CheckCircle2 className={`h-3 w-3 shrink-0 text-emerald-500`} />
    case 'failed':    return <AlertCircle  className={`h-3 w-3 shrink-0 text-red-500`} />
    case 'paused':    return <PauseCircle  className={`h-3 w-3 shrink-0 text-amber-500 ${cls}`} />
    default:          return null
  }
}

// ─── Event bar ────────────────────────────────────────────────────────────────

function EventBar({ run, occurrence, isSelected, onClick }: {
  run: Run; occurrence: RunOccurrence
  isSelected: boolean; onClick: () => void
}) {
  const isFailed = occurrence.status === 'failed'
  return (
    <button
      onClick={onClick}
      className={`
        h-5 w-full px-1.5 text-xs flex items-center gap-1 cursor-pointer truncate
        bg-background border rounded-sm
        ${isFailed ? 'border-red-300' : 'border-border'}
        ${isSelected ? 'ring-1 ring-offset-1 ring-foreground/30' : ''}
      `}
    >
      <RunStatusIconSmall status={occurrence.status} />
      <span className="truncate text-foreground">{run.name}</span>
    </button>
  )
}

// ─── Month view ───────────────────────────────────────────────────────────────

const MAX_VISIBLE = 3

function MonthView({ year, month, runs, selectedRunId, onSelectRun }: {
  year: number; month: number; runs: Run[]
  selectedRunId: string | null; onSelectRun: (run: Run) => void
}) {
  const today = new Date('2026-04-16T10:00:00')
  const weeks = useMemo(() => getCalendarWeeks(year, month), [year, month])
  const DOW   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 border-b shrink-0">
        {DOW.map(d => (
          <div key={d} className="text-center py-2 text-xs font-medium text-muted-foreground">{d}</div>
        ))}
      </div>

      {/* Week rows — flex-1 on each row so they share the remaining height equally */}
      <div className="flex flex-col flex-1 min-h-0">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-1 border-b last:border-b-0 min-h-0">
            {week.map((day, di) => {
              const isCurrentMonth = day.getMonth() === month
              const isToday        = isSameDay(day, today)
              const dayOccs        = getOccurrencesForDay(day, runs)
              const visible        = dayOccs.slice(0, MAX_VISIBLE)
              const overflow       = dayOccs.slice(MAX_VISIBLE)

              return (
                <div key={di}
                  className="flex-1 border-r last:border-r-0 flex flex-col min-w-0"
                >
                  <div className={`px-2 pt-2 pb-0 shrink-0 ${isCurrentMonth ? '' : 'opacity-40'}`}>
                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium ${
                      isToday ? 'bg-foreground text-background' : 'text-foreground'
                    }`}>
                      {day.getDate()}
                    </span>
                  </div>

                  <div className={`flex flex-col gap-0.5 px-2 pt-2 pb-2 ${isCurrentMonth ? '' : 'opacity-40'}`}>
                    {visible.map(({ run, occ }) => (
                      <EventBar key={`${run.id}-${occ.id}`}
                        run={run} occurrence={occ}
                        isSelected={selectedRunId === run.id}
                        onClick={() => onSelectRun(run)}
                      />
                    ))}
                    {overflow.length > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button className="text-[10px] text-muted-foreground font-medium hover:text-foreground text-left px-1 py-0.5 rounded transition-colors">
                            +{overflow.length} more
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-52 p-2" align="start">
                          <div className="flex flex-col gap-0.5">
                            {overflow.map(({ run, occ }) => (
                              <button key={`${run.id}-${occ.id}`}
                                onClick={() => onSelectRun(run)}
                                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-sm hover:bg-muted text-xs text-left w-full transition-colors ${selectedRunId === run.id ? 'bg-muted' : ''}`}
                              >
                                <RunStatusIconSmall status={occ.status} />
                                <span className={`truncate ${occ.status === 'failed' ? 'text-red-600' : 'text-foreground'}`}>{run.name}</span>
                              </button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Week view ────────────────────────────────────────────────────────────────

function WeekView({ weekStart, runs, selectedRunId, onSelectRun }: {
  weekStart: Date; runs: Run[]
  selectedRunId: string | null; onSelectRun: (run: Run) => void
}) {
  const today = new Date('2026-04-16T10:00:00')
  const week: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d
  })

  return (
    <div className="flex flex-1 min-h-0 border-b">
      {week.map((day, di) => {
        const isToday = isSameDay(day, today)
        const dayOccs: { run: Run; occ: RunOccurrence }[] = []
        for (const run of runs) {
          for (const occ of run.history ?? []) {
            if (dateOnly(occ.startedAt) <= day && dateOnly(occ.endedAt) >= day)
              dayOccs.push({ run, occ })
          }
        }
        return (
          <div key={di} className="flex-1 border-r last:border-r-0 flex flex-col">
            <div className={`flex flex-col items-center py-2 border-b shrink-0 ${isToday ? 'bg-muted/30' : ''}`}>
              <span className="text-xs text-muted-foreground">{day.toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className={`text-sm font-medium inline-flex h-7 w-7 items-center justify-center rounded-full mt-0.5 ${isToday ? 'bg-foreground text-background' : 'text-foreground'}`}>
                {day.getDate()}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-1 overflow-y-auto flex-1">
              {dayOccs.map(({ run, occ }) => {
                const isFailed = occ.status === 'failed'
                return (
                  <button
                    key={`${run.id}-${occ.id}`}
                    onClick={() => onSelectRun(run)}
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm text-xs border text-left w-full bg-background truncate ${
                      isFailed ? 'border-red-300' : 'border-border'
                    } ${selectedRunId === run.id ? 'ring-1 ring-offset-1 ring-foreground/30' : ''}`}
                  >
                    <RunStatusIconSmall status={occ.status} />
                    <span className="truncate text-foreground">{run.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── List view ────────────────────────────────────────────────────────────────

function ListView({ runs, selectedRunId, onSelectRun }: {
  runs: Run[]; selectedRunId: string | null; onSelectRun: (run: Run) => void
}) {
  const today     = new Date('2026-04-16T10:00:00')
  const todayDate = dateOnly(today)

  const allOccs = runs.flatMap(run =>
    (run.history ?? []).map(occ => ({ run, occ, date: dateOnly(occ.startedAt) }))
  ).sort((a, b) => b.date.getTime() - a.date.getTime())

  const getSection = (date: Date): string => {
    const diff = Math.round((todayDate.getTime() - date.getTime()) / 86400000)
    if (isSameDay(date, today)) return 'Today'
    if (diff < 0) return 'Upcoming'
    if (diff <= 6) return 'This week'
    return 'Earlier this month'
  }

  const sectionOrder = ['Today', 'This week', 'Earlier this month', 'Upcoming']
  const grouped = new Map<string, typeof allOccs>()
  for (const item of allOccs) {
    const s = getSection(item.date)
    if (!grouped.has(s)) grouped.set(s, [])
    grouped.get(s)!.push(item)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="space-y-6">
        {sectionOrder.map(section => {
          const items = grouped.get(section)
          if (!items?.length) return null
          return (
            <div key={section}>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{section}</h3>
              <div className="space-y-px">
                {items.map(({ run, occ }) => {
                  const isFailed = occ.status === 'failed'
                  return (
                    <button
                      key={`${run.id}-${occ.id}`}
                      onClick={() => onSelectRun(run)}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors text-left ${selectedRunId === run.id ? 'bg-muted/50' : ''}`}
                    >
                      <RunStatusIconSmall status={occ.status} isFailed={isFailed} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${isFailed ? 'text-red-600' : 'text-foreground'}`}>{run.name}</p>
                        {occ.statusText && <p className="text-xs text-muted-foreground truncate">{occ.statusText}</p>}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {occ.startedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main RunsPage ────────────────────────────────────────────────────────────

export function RunsPage({ runs, onCompose }: RunsPageProps) {
  const today = new Date('2026-04-16T10:00:00')
  const [viewMode, setViewMode]         = useState<ViewMode>('month')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [currentYear, setCurrentYear]   = useState(today.getFullYear())
  const [currentMonth, setCurrentMonth] = useState(today.getMonth())
  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => {
    const d = new Date(today); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d
  })
  const [selectedRun, setSelectedRun]     = useState<Run | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [searchQuery, setSearchQuery]     = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const filteredRuns = useMemo(() => {
    let result = runs
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(r => r.name.toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      result = result.filter(r => {
        if (statusFilter === 'active')    return r.status === 'active'
        if (statusFilter === 'completed') return r.status === 'completed'
        if (statusFilter === 'cancelled') return r.status === 'paused'
        if (statusFilter === 'failed')    return r.status === 'failed'
        return true
      })
    }
    return result
  }, [runs, searchQuery, statusFilter])

  function handleSelectRun(run: Run) {
    setSelectedRun(run)
    setPanelCollapsed(false)
  }

  function prevPeriod() {
    if (viewMode === 'month') {
      currentMonth === 0 ? (setCurrentMonth(11), setCurrentYear(y => y - 1)) : setCurrentMonth(m => m - 1)
    } else if (viewMode === 'week') {
      setCurrentWeekStart(d => { const nd = new Date(d); nd.setDate(nd.getDate() - 7); return nd })
    }
  }

  function nextPeriod() {
    if (viewMode === 'month') {
      currentMonth === 11 ? (setCurrentMonth(0), setCurrentYear(y => y + 1)) : setCurrentMonth(m => m + 1)
    } else if (viewMode === 'week') {
      setCurrentWeekStart(d => { const nd = new Date(d); nd.setDate(nd.getDate() + 7); return nd })
    }
  }

  function getPeriodLabel(): string {
    if (viewMode === 'month') {
      return new Date(currentYear, currentMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }
    if (viewMode === 'week') {
      const weekEnd = new Date(currentWeekStart); weekEnd.setDate(weekEnd.getDate() + 6)
      if (currentWeekStart.getMonth() === weekEnd.getMonth()) {
        return `${currentWeekStart.toLocaleDateString('en-US', { month: 'long' })} ${currentWeekStart.getDate()}–${weekEnd.getDate()}, ${currentWeekStart.getFullYear()}`
      }
      return `${currentWeekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    }
    return ''
  }

  const showPanel = selectedRun && !panelCollapsed

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
        <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />
        <span className="text-sm font-semibold shrink-0">Runs</span>

        <div className="ml-auto flex items-center gap-2">
          {/* Status filter pills */}
          <div className="flex items-center rounded-lg border p-0.5">
            {STATUS_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  statusFilter === f.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="h-8 w-40 rounded-md border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 transition-all"
            />
          </div>

          {/* View switcher */}
          <div className="flex items-center rounded-lg border p-0.5">
            {([
              { mode: 'month' as ViewMode, icon: CalendarDays,  title: 'Month' },
              { mode: 'week'  as ViewMode, icon: CalendarRange, title: 'Week'  },
              { mode: 'list'  as ViewMode, icon: List,          title: 'List'  },
            ] as const).map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={title}
                className={`rounded-md p-1.5 transition-colors ${viewMode === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>

          <Button size="sm" onClick={onCompose}>
            Create
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Calendar / list pane */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Calendar nav sub-header */}
          {(viewMode === 'month' || viewMode === 'week') && (
            <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={prevPeriod}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium min-w-[160px] text-center">{getPeriodLabel()}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={nextPeriod}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground h-7"
                onClick={() => { setCurrentYear(today.getFullYear()); setCurrentMonth(today.getMonth()) }}
              >
                Today
              </Button>
            </div>
          )}

          {viewMode === 'month' && (
            <MonthView
              year={currentYear} month={currentMonth}
              runs={filteredRuns} selectedRunId={selectedRun?.id ?? null}
              onSelectRun={handleSelectRun}
              onMonthChange={(y, m) => { setCurrentYear(y); setCurrentMonth(m) }}
            />
          )}
          {viewMode === 'week' && (
            <WeekView
              weekStart={currentWeekStart}
              runs={filteredRuns} selectedRunId={selectedRun?.id ?? null}
              onSelectRun={handleSelectRun}
            />
          )}
          {viewMode === 'list' && (
            <ListView
              runs={filteredRuns} selectedRunId={selectedRun?.id ?? null}
              onSelectRun={handleSelectRun}
            />
          )}
        </div>

        {/* Detail panel — Framer Motion slide-in */}
        <AnimatePresence>
          {selectedRun && !panelCollapsed && (
            <motion.div
              key={selectedRun.id}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 360, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 flex flex-col border-l overflow-hidden"
              style={{ minWidth: 0 }}
            >
              <RunDetailPanel
                run={selectedRun}
                onCollapse={() => { setPanelCollapsed(true); setSelectedRun(null) }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
