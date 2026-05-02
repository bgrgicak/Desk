import { useState, useEffect, useRef } from 'react'
import {
  X,
  ChevronDown,
  Calendar,
  Clock,
} from 'lucide-react'
import { format } from 'date-fns'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Calendar as CalendarPicker } from '@/components/ui/calendar'
import type { Task } from '@/data/ui-types'
import { StatusBadge } from './task-badges'
import { buildCron, type Unit, type ScheduleParams } from './schedule-utils'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TaskCreateInput {
  name: string
  description?: string
  status: Task['status']
  scheduledFor?: Date
  scheduleEndDate?: Date
  scheduleRepeat?: boolean
  cron?: string
}

interface TaskSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateTask: (input: TaskCreateInput) => Promise<void> | void
  defaultStatus?: Task['status']
}

type FormStatus   = Task['status']
type ScheduleMode = 'once' | 'recurring'

const UNITS: { value: Unit; singular: string; plural: string }[] = [
  { value: 'minutes', singular: 'minute', plural: 'minutes' },
  { value: 'hours',   singular: 'hour',   plural: 'hours'   },
  { value: 'days',    singular: 'day',    plural: 'days'    },
  { value: 'weeks',   singular: 'week',   plural: 'weeks'   },
  { value: 'months',  singular: 'month',  plural: 'months'  },
]

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const DEFAULT_SCHEDULE: ScheduleParams = {
  n: 1, unit: 'days', weekdays: [1], day: 1, hour: 9, minute: 0,
}

interface FormState {
  name:            string
  description:     string
  status:          FormStatus
  scheduleMode:    ScheduleMode
  onceDate:        string   // YYYY-MM-DD
  onceTime:        string   // HH:MM
  schedule:        ScheduleParams
  beginDate:       string   // YYYY-MM-DD
  endDate:         string   // YYYY-MM-DD
}

function pad2(n: number) { return n.toString().padStart(2, '0') }

function defaultOnceDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function defaultOnceTime(): string {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const DEFAULT_FORM: FormState = {
  name:         '',
  description:  '',
  status:       'todo',
  scheduleMode: 'once',
  onceDate:     defaultOnceDate(),
  onceTime:     defaultOnceTime(),
  schedule:     DEFAULT_SCHEDULE,
  beginDate:    defaultOnceDate(),
  endDate:      '',
}

// ── Date calendar field ────────────────────────────────────────────────────────

function DateField({ label, value, onChange }: {
  label: string
  value: Date | undefined
  onChange: (date: Date | undefined) => void
}) {
  return (
    <div className="space-y-1.5 flex-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
          >
            <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
            {value
              ? <span className="flex-1 text-left">{format(value, 'MMM d, yyyy')}</span>
              : <span className="flex-1 text-left text-muted-foreground">Pick a date</span>
            }
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <CalendarPicker mode="single" selected={value} onSelect={onChange} initialFocus />
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ── Time field ─────────────────────────────────────────────────────────────────

function TimeField({ label, value, onChange }: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 shadow-xs">
        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          type="time"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="flex-1 text-sm bg-transparent outline-none"
        />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TaskSheet({ open, onOpenChange, onCreateTask, defaultStatus }: TaskSheetProps) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm({
        ...DEFAULT_FORM,
        status:   defaultStatus ?? 'todo',
        onceDate: defaultOnceDate(),
        onceTime: defaultOnceTime(),
      })
    }
    prevOpenRef.current = open
  }, [open, defaultStatus])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function patchSchedule(delta: Partial<ScheduleParams>) {
    setForm(prev => {
      const next = { ...prev.schedule, ...delta }
      if (delta.unit === 'weeks' && next.weekdays.length === 0) next.weekdays = [1]
      return { ...prev, schedule: next }
    })
  }

  function toggleWeekday(i: number) {
    setForm(prev => {
      const has  = prev.schedule.weekdays.includes(i)
      const days = has ? prev.schedule.weekdays.filter(d => d !== i) : [...prev.schedule.weekdays, i]
      return { ...prev, schedule: { ...prev.schedule, weekdays: days.length === 0 ? [i] : days } }
    })
  }

  function parseDateStr(s: string): Date | undefined {
    if (!s) return undefined
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, (m ?? 1) - 1, d ?? 1)
  }

  async function handleCreate() {
    setSubmitting(true)
    try {
      let scheduledFor: Date | undefined
      let cron: string | undefined

      if (form.status === 'scheduled') {
        if (form.scheduleMode === 'once') {
          const [y, mo, d] = form.onceDate.split('-').map(Number)
          const [hh, mm]   = form.onceTime.split(':').map(Number)
          scheduledFor = new Date(y, (mo ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0)
        } else {
          cron = buildCron(form.schedule) || undefined
          scheduledFor = parseDateStr(form.beginDate)
        }
      }

      await onCreateTask({
        name:            form.name.trim() || 'Untitled task',
        description:     form.description.trim() || undefined,
        status:          form.status,
        scheduledFor,
        scheduleEndDate: form.status === 'scheduled' && form.scheduleMode === 'recurring'
          ? parseDateStr(form.endDate)
          : undefined,
        scheduleRepeat: form.status === 'scheduled' && form.scheduleMode === 'recurring',
        cron,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const s = form.schedule
  const timeValue = `${pad2(s.hour)}:${pad2(s.minute)}`
  const needsTime = s.unit === 'days' || s.unit === 'weeks' || s.unit === 'months'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex flex-col p-0 gap-0 sm:max-w-none w-[480px]"
      >
        {/* Header */}
        <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
          <span className="text-sm font-semibold truncate flex-1 min-w-0 mr-2">
            {form.name.trim() || 'New task'}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              data-testid="task-sheet-name"
              placeholder="Task name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <div className="rounded-lg border bg-background shadow-xs">
              <div className="px-3 py-2">
                <textarea
                  rows={4}
                  data-testid="task-sheet-description"
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Add a description or instructions for the AI agent..."
                  className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-h-[72px]"
                />
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="task-sheet-status"
                  className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 shadow-xs hover:bg-accent/30 transition-colors"
                >
                  <StatusBadge status={form.status} />
                  <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {(['todo', 'active', 'complete', 'scheduled'] as FormStatus[]).map(st => (
                  <DropdownMenuItem key={st} onSelect={() => set('status', st)} className="gap-2">
                    <StatusBadge status={st} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Schedule section — only when status = scheduled */}
          {form.status === 'scheduled' && (
            <>
              {/* Mode radio group */}
              <RadioGroup
                value={form.scheduleMode}
                onValueChange={v => set('scheduleMode', v as ScheduleMode)}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="once" id="sched-once" />
                  <label htmlFor="sched-once" className="text-sm cursor-pointer">Once</label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="recurring" id="sched-recurring" />
                  <label htmlFor="sched-recurring" className="text-sm cursor-pointer">Recurring</label>
                </div>
              </RadioGroup>

              {/* ── Once ── */}
              {form.scheduleMode === 'once' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Date</label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
                        >
                          <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="flex-1 text-left">
                            {form.onceDate
                              ? format(new Date(form.onceDate + 'T00:00'), 'MMM d, yyyy')
                              : <span className="text-muted-foreground">Pick a date</span>
                            }
                          </span>
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarPicker
                          mode="single"
                          selected={form.onceDate ? new Date(form.onceDate + 'T00:00') : undefined}
                          onSelect={d => d && set('onceDate', `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <TimeField label="Time" value={form.onceTime} onChange={v => set('onceTime', v)} />
                </div>
              )}

              {/* ── Recurring — sentence builder ── */}
              {form.scheduleMode === 'recurring' && (
                <div className="space-y-3">

                  {/* Every [N] [unit] */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Repeat</label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground shrink-0">Every</span>
                      <Input
                        type="number"
                        min={1}
                        max={s.unit === 'minutes' ? 59 : s.unit === 'hours' ? 23 : 99}
                        value={s.n}
                        onChange={e => patchSchedule({ n: Math.max(1, Number(e.target.value)) })}
                        className="w-16 text-center"
                      />
                      <select
                        value={s.unit}
                        onChange={e => patchSchedule({ unit: e.target.value as Unit })}
                        className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {UNITS.map(u => (
                          <option key={u.value} value={u.value}>
                            {s.n === 1 ? u.singular : u.plural}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Day-of-week chips */}
                  {s.unit === 'weeks' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">On</label>
                      <div className="flex gap-1">
                        {WEEKDAY_LABELS.map((label, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => toggleWeekday(i)}
                            className={`flex-1 h-9 rounded-md border text-xs font-medium transition-colors ${
                              s.weekdays.includes(i)
                                ? 'bg-foreground text-background border-foreground'
                                : 'bg-background text-foreground hover:bg-muted'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Day of month */}
                  {s.unit === 'months' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">On day</label>
                      <Input
                        type="number"
                        min={1}
                        max={28}
                        value={s.day}
                        onChange={e => patchSchedule({ day: Math.min(28, Math.max(1, Number(e.target.value))) })}
                        className="w-24"
                      />
                    </div>
                  )}

                  {/* Time */}
                  {needsTime && (
                    <TimeField
                      label="At"
                      value={timeValue}
                      onChange={v => {
                        const [hh, mm] = v.split(':').map(Number)
                        patchSchedule({ hour: hh ?? 0, minute: mm ?? 0 })
                      }}
                    />
                  )}

                  {/* Begin on + End on */}
                  <div className="flex gap-3">
                    <DateField
                      label="Begin on"
                      value={parseDateStr(form.beginDate)}
                      onChange={d => set('beginDate', d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '')}
                    />
                    <DateField
                      label="End on (optional)"
                      value={parseDateStr(form.endDate)}
                      onChange={d => set('endDate', d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '')}
                    />
                  </div>

                </div>
              )}
            </>
          )}

        </div>

        <div className="p-4 flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button data-testid="task-sheet-submit" onClick={handleCreate} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create task'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
