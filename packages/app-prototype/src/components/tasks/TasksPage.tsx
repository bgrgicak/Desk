import { useState, useMemo, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarRange,
  List,
  LayoutGrid,
  Search,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageHeader } from '@/components/layout/PageHeader'
import { BoardView } from './BoardView'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskSheet } from './TaskSheet'
import type { Task, TaskOccurrence } from '@/data/ui-types'

// ── Types ──────────────────────────────────────────────────────────────────────

type ViewMode     = 'board' | 'month' | 'week' | 'list'
type StatusFilter = 'all' | 'todo' | 'active' | 'complete' | 'scheduled'

interface TasksPageProps {
  tasks: Task[]
  /** Called when a board drop moves a task to a different column. Wires
   * through to PATCH /chats/:id/messages/:id in App.tsx. Intra-column
   * reorders don't fire this hook — the server has no ordering field. */
  onTaskMove?: (task: Task, newStatus: Task['status']) => Promise<void> | void
  onCreateTask?: (input: { name: string; description?: string; status: Task['status']; scheduledFor?: Date; scheduleRepeat?: boolean }) => Promise<void> | void
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',       label: 'All'       },
  { value: 'todo',      label: 'To do'     },
  { value: 'active',    label: 'Active'    },
  { value: 'complete',  label: 'Complete'  },
  { value: 'scheduled', label: 'Scheduled' },
]

// ── Calendar helpers ──────────────────────────────────────────────────────────

function getCalendarWeeks(year: number, month: number): Date[][] {
  const firstDay  = new Date(year, month, 1)
  const lastDay   = new Date(year, month + 1, 0)
  const startDate = new Date(firstDay)
  startDate.setDate(firstDay.getDate() - firstDay.getDay())
  const endDate = new Date(lastDay)
  endDate.setDate(lastDay.getDate() + (6 - lastDay.getDay()))
  const weeks: Date[][] = []
  const current = new Date(startDate)
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

function getOccurrencesForDay(day: Date, tasks: Task[]): { task: Task; occ: TaskOccurrence }[] {
  const d = dateOnly(day)
  const result: { task: Task; occ: TaskOccurrence }[] = []
  for (const task of tasks) {
    for (const occ of task.history ?? []) {
      if (dateOnly(occ.startedAt) <= d && dateOnly(occ.endedAt) >= d) {
        result.push({ task, occ })
      }
    }
  }
  result.sort((a, b) => a.occ.startedAt.getTime() - b.occ.startedAt.getTime())
  return result
}

// ── Status icon (small) ───────────────────────────────────────────────────────

function TaskStatusIconSmall({ status }: { status: Task['status'] | TaskOccurrence['status'] }) {
  switch (status) {
    case 'active':    return <Loader2     className="h-3 w-3 shrink-0 animate-spin text-blue-500" />
    case 'complete':
    case 'completed': return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
    case 'failed':    return <AlertCircle  className="h-3 w-3 shrink-0 text-red-500" />
    case 'todo':
    case 'scheduled': return <Clock        className="h-3 w-3 shrink-0 text-amber-500" />
    default:          return null
  }
}

// ── Event bar ─────────────────────────────────────────────────────────────────

function EventBar({ task, occurrence, isSelected, onClick }: {
  task: Task; occurrence: TaskOccurrence
  isSelected: boolean; onClick: () => void
}) {
  const isFailed = occurrence.status === 'failed'
  return (
    <button
      onClick={onClick}
      data-testid={`task-row-${task.id}`}
      className={`
        h-5 w-full px-1.5 text-xs flex items-center gap-1 cursor-pointer truncate
        bg-background border rounded-sm
        ${isFailed ? 'border-red-300' : 'border-border'}
        ${isSelected ? 'ring-1 ring-offset-1 ring-foreground/30' : ''}
      `}
    >
      <TaskStatusIconSmall status={occurrence.status} />
      <span className="truncate text-foreground">{task.name}</span>
    </button>
  )
}

// ── Month view ────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 3

function MonthView({ year, month, tasks, selectedTaskId, onSelectTask }: {
  year: number; month: number; tasks: Task[]
  selectedTaskId: string | null; onSelectTask: (task: Task) => void
}) {
  const today = useMemo(() => new Date(), [])
  const weeks = useMemo(() => getCalendarWeeks(year, month), [year, month])
  const DOW   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="grid grid-cols-7 border-b shrink-0">
        {DOW.map(d => (
          <div key={d} className="text-center py-2 text-xs font-medium text-muted-foreground">{d}</div>
        ))}
      </div>
      <div className="flex flex-col flex-1 min-h-0">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-1 border-b last:border-b-0 min-h-0">
            {week.map((day, di) => {
              const isCurrentMonth = day.getMonth() === month
              const isToday        = isSameDay(day, today)
              const dayOccs        = getOccurrencesForDay(day, tasks)
              const visible        = dayOccs.slice(0, MAX_VISIBLE)
              const overflow       = dayOccs.slice(MAX_VISIBLE)
              return (
                <div key={di} className="flex-1 border-r last:border-r-0 flex flex-col min-w-0">
                  <div className={`px-2 pt-2 pb-0 shrink-0 ${isCurrentMonth ? '' : 'opacity-40'}`}>
                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium ${
                      isToday ? 'bg-foreground text-background' : 'text-foreground'
                    }`}>
                      {day.getDate()}
                    </span>
                  </div>
                  <div className={`flex flex-col gap-0.5 px-2 pt-2 pb-2 ${isCurrentMonth ? '' : 'opacity-40'}`}>
                    {visible.map(({ task, occ }) => (
                      <EventBar key={`${task.id}-${occ.id}`}
                        task={task} occurrence={occ}
                        isSelected={selectedTaskId === task.id}
                        onClick={() => onSelectTask(task)}
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
                            {overflow.map(({ task, occ }) => (
                              <button key={`${task.id}-${occ.id}`}
                                onClick={() => onSelectTask(task)}
                                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-sm hover:bg-muted text-xs text-left w-full transition-colors ${selectedTaskId === task.id ? 'bg-muted' : ''}`}
                              >
                                <TaskStatusIconSmall status={occ.status} />
                                <span className={`truncate ${occ.status === 'failed' ? 'text-red-600' : 'text-foreground'}`}>{task.name}</span>
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

// ── Week view ─────────────────────────────────────────────────────────────────

function WeekView({ weekStart, tasks, selectedTaskId, onSelectTask }: {
  weekStart: Date; tasks: Task[]
  selectedTaskId: string | null; onSelectTask: (task: Task) => void
}) {
  const today = useMemo(() => new Date(), [])
  const week: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d
  })
  return (
    <div className="flex flex-1 min-h-0 border-b">
      {week.map((day, di) => {
        const isToday = isSameDay(day, today)
        const dayOccs: { task: Task; occ: TaskOccurrence }[] = []
        for (const task of tasks) {
          for (const occ of task.history ?? []) {
            if (dateOnly(occ.startedAt) <= day && dateOnly(occ.endedAt) >= day)
              dayOccs.push({ task, occ })
          }
        }
        dayOccs.sort((a, b) => a.occ.startedAt.getTime() - b.occ.startedAt.getTime())
        return (
          <div key={di} className="flex-1 border-r last:border-r-0 flex flex-col">
            <div className={`flex flex-col items-center py-2 border-b shrink-0 ${isToday ? 'bg-muted/30' : ''}`}>
              <span className="text-xs text-muted-foreground">{day.toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className={`text-sm font-medium inline-flex h-7 w-7 items-center justify-center rounded-full mt-0.5 ${isToday ? 'bg-foreground text-background' : 'text-foreground'}`}>
                {day.getDate()}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-1 overflow-y-auto flex-1">
              {dayOccs.map(({ task, occ }) => {
                const isFailed = occ.status === 'failed'
                return (
                  <button
                    key={`${task.id}-${occ.id}`}
                    data-testid={`task-row-${task.id}`}
                    onClick={() => onSelectTask(task)}
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm text-xs border text-left w-full bg-background truncate ${
                      isFailed ? 'border-red-300' : 'border-border'
                    } ${selectedTaskId === task.id ? 'ring-1 ring-offset-1 ring-foreground/30' : ''}`}
                  >
                    <TaskStatusIconSmall status={occ.status} />
                    <span className="truncate text-foreground">{task.name}</span>
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

// ── List view ─────────────────────────────────────────────────────────────────

function ListView({ tasks, selectedTaskId, onSelectTask }: {
  tasks: Task[]; selectedTaskId: string | null; onSelectTask: (task: Task) => void
}) {
  const today     = useMemo(() => new Date(), [])
  const todayDate = useMemo(() => dateOnly(today), [today])

  const allOccs = tasks.flatMap(task =>
    (task.history ?? []).map(occ => ({ task, occ, date: dateOnly(occ.startedAt), ts: occ.startedAt.getTime() }))
  ).sort((a, b) => a.ts - b.ts)

  const getSection = (date: Date): string => {
    const diff = Math.round((todayDate.getTime() - date.getTime()) / 86400000)
    if (isSameDay(date, today)) return 'Today'
    if (diff < 0) return 'Upcoming'
    if (diff <= 6) return 'This week'
    return 'Earlier this month'
  }

  const sectionOrder = ['Earlier this month', 'This week', 'Today', 'Upcoming']
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
                {items.map(({ task, occ }) => {
                  const isFailed = occ.status === 'failed'
                  return (
                    <button
                      key={`${task.id}-${occ.id}`}
                      data-testid={`task-row-${task.id}`}
                      onClick={() => onSelectTask(task)}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors text-left ${selectedTaskId === task.id ? 'bg-muted/50' : ''}`}
                    >
                      <TaskStatusIconSmall status={occ.status} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${isFailed ? 'text-red-600' : 'text-foreground'}`}>{task.name}</p>
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

// ── Main TasksPage ────────────────────────────────────────────────────────────

export function TasksPage({ tasks, onTaskMove, onCreateTask }: TasksPageProps) {
  const today = useMemo(() => new Date(), [])
  const [viewMode, setViewMode]         = useState<ViewMode>('board')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [defaultCreateStatus, setDefaultCreateStatus] = useState<Task['status']>('todo')
  const [currentYear, setCurrentYear]   = useState(today.getFullYear())
  const [currentMonth, setCurrentMonth] = useState(today.getMonth())
  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => {
    const d = new Date(today); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); return d
  })
  const [selectedTask, setSelectedTask]   = useState<Task | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [searchQuery, setSearchQuery]     = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Keep the selected task in sync with the underlying list: after a
  // lifecycle PATCH (pause/resume/cancel) invalidates the messages
  // query, the incoming `tasks` array carries the updated row.
  useEffect(() => {
    if (!selectedTask) return
    const fresh = tasks.find(t => t.id === selectedTask.id)
    if (!fresh) return
    if (fresh !== selectedTask) setSelectedTask(fresh)
  }, [tasks, selectedTask])

  const filteredTasks = useMemo(() => {
    let result = tasks
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(t => t.name.toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      result = result.filter(t => t.status === statusFilter)
    }
    return result
  }, [tasks, searchQuery, statusFilter])

  function handleSelectTask(task: Task) {
    setSelectedTask(task)
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

  const showPanel = selectedTask && !panelCollapsed

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <PageHeader
        breadcrumb={<span className="text-sm font-semibold">Tasks</span>}
        actions={<div className="flex items-center gap-2">
          {viewMode !== 'board' && (
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
          )}

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

          <div className="flex items-center rounded-lg border p-0.5" data-testid="tasks-view-switcher">
            {([
              { mode: 'board' as ViewMode, icon: LayoutGrid,   title: 'Board' },
              { mode: 'month' as ViewMode, icon: CalendarDays, title: 'Month' },
              { mode: 'week'  as ViewMode, icon: CalendarRange, title: 'Week'  },
              { mode: 'list'  as ViewMode, icon: List,          title: 'List'  },
            ] as const).map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={title}
                data-testid={`tasks-view-${mode}`}
                className={`rounded-md p-1.5 transition-colors ${viewMode === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>

          <Button size="sm" data-testid="tasks-create" onClick={() => { setDefaultCreateStatus('todo'); setCreateSheetOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create
          </Button>
        </div>}
      />

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
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

          {viewMode === 'board' && (
            <BoardView
              tasks={filteredTasks}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={handleSelectTask}
              onTaskMove={(task, newStatus) => onTaskMove?.(task, newStatus)}
              onAddTask={status => {
                setDefaultCreateStatus(status)
                setCreateSheetOpen(true)
              }}
            />
          )}
          {viewMode === 'month' && (
            <MonthView
              year={currentYear} month={currentMonth}
              tasks={filteredTasks} selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={handleSelectTask}
            />
          )}
          {viewMode === 'week' && (
            <WeekView
              weekStart={currentWeekStart}
              tasks={filteredTasks} selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={handleSelectTask}
            />
          )}
          {viewMode === 'list' && (
            <ListView
              tasks={filteredTasks} selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={handleSelectTask}
            />
          )}
        </div>

        <AnimatePresence>
          {showPanel && (
            <motion.div
              key={selectedTask.id}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 360, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 flex flex-col border-l overflow-hidden"
              style={{ minWidth: 0 }}
            >
              <TaskDetailPanel
                task={selectedTask}
                onCollapse={() => { setPanelCollapsed(true); setSelectedTask(null) }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <TaskSheet
        open={createSheetOpen}
        onOpenChange={open => setCreateSheetOpen(open)}
        defaultStatus={defaultCreateStatus}
        onCreateTask={async (input) => {
          await onCreateTask?.(input)
          setCreateSheetOpen(false)
        }}
      />
    </div>
  )
}
