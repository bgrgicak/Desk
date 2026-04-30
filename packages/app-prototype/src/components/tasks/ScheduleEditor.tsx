import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildCron, parseCron, describeCron, type Unit, type ScheduleParams } from './schedule-utils'

type Mode = 'once' | 'recurring'

const UNITS: { value: Unit; singular: string; plural: string }[] = [
  { value: 'minutes', singular: 'minute', plural: 'minutes' },
  { value: 'hours',   singular: 'hour',   plural: 'hours'   },
  { value: 'days',    singular: 'day',    plural: 'days'    },
  { value: 'weeks',   singular: 'week',   plural: 'weeks'   },
  { value: 'months',  singular: 'month',  plural: 'months'  },
]

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const DEFAULT_PARAMS: ScheduleParams = {
  n: 1, unit: 'days', weekdays: [1], day: 1, hour: 9, minute: 0,
}

export interface SchedulePatch {
  executeAt: string | null
  cron: string | null
}

interface ScheduleEditorProps {
  currentExecuteAt?: Date
  currentCron?: string
  busy?: boolean
  onSave: (patch: SchedulePatch) => Promise<void> | void
  onClear: () => Promise<void> | void
  onClose: () => void
}

function pad2(n: number): string { return n.toString().padStart(2, '0') }
function dateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function timeInputValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function ScheduleEditor({
  currentExecuteAt,
  currentCron,
  busy = false,
  onSave,
  onClear,
  onClose,
}: ScheduleEditorProps) {
  const initialParsed = useMemo(() => currentCron ? parseCron(currentCron) : null, [currentCron])
  const initialMode: Mode = currentCron ? 'recurring' : 'once'

  const [mode, setMode] = useState<Mode>(initialMode)

  // Once-mode
  const initialOnceDate = currentExecuteAt ?? (() => {
    const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d
  })()
  const [onceDate, setOnceDate] = useState(dateInputValue(initialOnceDate))
  const [onceTime, setOnceTime] = useState(timeInputValue(initialOnceDate))

  // Recurring — flat state, all fields always present
  const [p, setP] = useState<ScheduleParams>(initialParsed ?? DEFAULT_PARAMS)

  const [beginDate, setBeginDate] = useState(currentExecuteAt ? dateInputValue(currentExecuteAt) : '')
  const [endDate,   setEndDate]   = useState('')

  function patch(delta: Partial<ScheduleParams>) {
    setP(prev => {
      const next = { ...prev, ...delta }
      // when switching to weeks ensure at least one weekday is selected
      if (delta.unit === 'weeks' && next.weekdays.length === 0) next.weekdays = [1]
      return next
    })
  }

  function toggleWeekday(i: number) {
    setP(prev => {
      const has = prev.weekdays.includes(i)
      const next = has ? prev.weekdays.filter(d => d !== i) : [...prev.weekdays, i]
      return { ...prev, weekdays: next.length === 0 ? [i] : next }
    })
  }

  function handleSave() {
    if (mode === 'once') {
      const [y, m, d] = onceDate.split('-').map(Number)
      const [hh, mm]  = onceTime.split(':').map(Number)
      void onSave({ executeAt: new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0).toISOString(), cron: null })
    } else {
      const cron = buildCron(p)
      let executeAt: string | null = null
      if (beginDate) {
        const [y, m, d] = beginDate.split('-').map(Number)
        executeAt = new Date(y, (m ?? 1) - 1, d ?? 1).toISOString()
      }
      void onSave({ executeAt, cron })
    }
  }

  const timeValue = `${pad2(p.hour)}:${pad2(p.minute)}`
  const needsTime = p.unit === 'days' || p.unit === 'weeks' || p.unit === 'months'

  return (
    <div className="flex flex-col gap-3 p-3 w-72" data-testid="schedule-editor">

      {/* Mode toggle */}
      <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
        {(['once', 'recurring'] as Mode[]).map(m => (
          <button key={m} type="button" onClick={() => setMode(m)}
            data-testid={`schedule-mode-${m}`}
            className={`flex-1 rounded-full px-3 text-xs font-medium capitalize transition-colors h-full ${
              mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {m === 'once' ? 'Once' : 'Recurring'}
          </button>
        ))}
      </div>

      {/* Once */}
      {mode === 'once' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <Input type="date" data-testid="schedule-once-date" value={onceDate} onChange={e => setOnceDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Time</label>
            <Input type="time" data-testid="schedule-once-time" value={onceTime} onChange={e => setOnceTime(e.target.value)} />
          </div>
        </div>
      )}

      {/* Recurring — sentence builder */}
      {mode === 'recurring' && (
        <div className="space-y-3">

          {/* "Every [N] [unit]" row */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Repeat</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground shrink-0">Every</span>
              <Input
                type="number"
                min={1}
                max={p.unit === 'minutes' ? 59 : p.unit === 'hours' ? 23 : 99}
                value={p.n}
                onChange={e => patch({ n: Math.max(1, Number(e.target.value)) })}
                className="w-16 text-center"
                data-testid="schedule-n"
              />
              <select
                value={p.unit}
                onChange={e => patch({ unit: e.target.value as Unit })}
                data-testid="schedule-unit"
                className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {UNITS.map(u => (
                  <option key={u.value} value={u.value}>
                    {p.n === 1 ? u.singular : u.plural}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Day-of-week chips */}
          {p.unit === 'weeks' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">On</label>
              <div className="flex gap-1">
                {WEEKDAY_LABELS.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    data-testid={`schedule-weekday-${i}`}
                    onClick={() => toggleWeekday(i)}
                    className={`flex-1 h-8 rounded-md border text-xs font-medium transition-colors ${
                      p.weekdays.includes(i)
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
          {p.unit === 'months' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">On day</label>
              <Input
                type="number"
                min={1}
                max={28}
                data-testid="schedule-month-day"
                value={p.day}
                onChange={e => patch({ day: Math.min(28, Math.max(1, Number(e.target.value))) })}
              />
            </div>
          )}

          {/* Time picker */}
          {needsTime && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">At</label>
              <Input
                type="time"
                data-testid="schedule-recur-time"
                value={timeValue}
                onChange={e => {
                  const [hh, mm] = e.target.value.split(':').map(Number)
                  patch({ hour: hh ?? 0, minute: mm ?? 0 })
                }}
              />
            </div>
          )}

          {/* Start / end */}
          <div className="flex gap-2">
            <div className="space-y-1 flex-1 min-w-0">
              <label className="text-xs font-medium text-muted-foreground">Begin on</label>
              <Input type="date" data-testid="schedule-begin-date" value={beginDate} onChange={e => setBeginDate(e.target.value)} />
            </div>
            <div className="space-y-1 flex-1 min-w-0">
              <label className="text-xs font-medium text-muted-foreground">End on</label>
              <Input type="date" data-testid="schedule-end-date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {/* Live summary */}
          <p className="text-[11px] text-muted-foreground italic">
            {describeCron(buildCron(p))}
          </p>
        </div>
      )}

      <div className="flex justify-between items-center pt-1">
        <Button variant="ghost" size="sm" data-testid="schedule-clear"
          disabled={busy || (!currentExecuteAt && !currentCron)}
          onClick={() => { void onClear(); onClose() }}>
          Clear
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" data-testid="schedule-save" disabled={busy}
            onClick={() => { handleSave(); onClose() }}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
