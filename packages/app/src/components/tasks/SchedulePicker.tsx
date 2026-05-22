import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  Button,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@roomy-ai/ui'
import { buildCron, describeCron, parseCron, type ScheduleParams, type Unit } from './schedule-utils'

// ── Value & helpers ────────────────────────────────────────────────────────────

/**
 * Wire-format the picker emits. Mirrors the message fields the server
 * persists today plus an optional UI-only end date (the server doesn't
 * yet enforce it — see `endDate` below).
 */
export interface SchedulePickerValue {
  /** ISO. One-shot: the time to run. Recurring: the begin boundary. */
  executeAt: string | null
  /** Cron expression for recurring tasks; `null` for one-shot. */
  cron: string | null
  /** YYYY-MM-DD. UI-only — backend has no end-date column yet. */
  endDate: string | null
}

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

type Mode = 'once' | 'recurring'

interface InternalForm {
  mode:      Mode
  onceDate:  string  // YYYY-MM-DD
  onceTime:  string  // HH:MM
  params:    ScheduleParams
  beginDate: string  // YYYY-MM-DD
  endDate:   string  // YYYY-MM-DD
}

function pad2(n: number) { return n.toString().padStart(2, '0') }

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function nextHourTime(): string {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function ymdFromDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Build an ISO timestamp from a local YYYY-MM-DD + HH:MM. */
function localToIso(ymd: string, hm: string): string | null {
  const [y, mo, d]  = ymd.split('-').map(Number)
  const [hh, mm]    = hm.split(':').map(Number)
  if (!y || !mo || !d) return null
  return new Date(y, mo - 1, d, hh ?? 0, mm ?? 0, 0, 0).toISOString()
}

/** Seed the internal form from an existing value (or sensible defaults). */
function formFromValue(value: SchedulePickerValue | null): InternalForm {
  // Recurring → seed from cron + begin/end.
  if (value?.cron) {
    const params = parseCron(value.cron) ?? DEFAULT_SCHEDULE
    const beginIso = value.executeAt ? new Date(value.executeAt) : null
    return {
      mode:      'recurring',
      onceDate:  todayYmd(),
      onceTime:  nextHourTime(),
      params,
      beginDate: beginIso ? ymdFromDate(beginIso) : todayYmd(),
      endDate:   value.endDate ?? '',
    }
  }
  // One-shot → seed from executeAt.
  if (value?.executeAt) {
    const d = new Date(value.executeAt)
    return {
      mode:      'once',
      onceDate:  ymdFromDate(d),
      onceTime:  `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
      params:    DEFAULT_SCHEDULE,
      beginDate: todayYmd(),
      endDate:   '',
    }
  }
  return {
    mode:      'once',
    onceDate:  todayYmd(),
    onceTime:  nextHourTime(),
    params:    DEFAULT_SCHEDULE,
    beginDate: todayYmd(),
    endDate:   '',
  }
}

function valueFromForm(form: InternalForm): SchedulePickerValue | null {
  if (form.mode === 'once') {
    const executeAt = localToIso(form.onceDate, form.onceTime)
    if (!executeAt) return null
    return { executeAt, cron: null, endDate: null }
  }
  const cron = buildCron(form.params)
  if (!cron) return null
  // Send the begin date as `executeAt` so the scheduler doesn't fire
  // before that boundary; the server reconciles to the next cron tick
  // at-or-after this time. Mirrors the existing TaskSheet contract.
  const executeAt = form.beginDate
    ? new Date(`${form.beginDate}T00:00:00`).toISOString()
    : null
  return {
    executeAt,
    cron,
    endDate: form.endDate || null,
  }
}

// ── Subfields ──────────────────────────────────────────────────────────────────
//
// Both date and time use native HTML inputs. The browser-native pickers
// avoid the nested-popover focus-trap issue that closes the outer
// schedule popover as soon as a Radix Calendar would render its own
// portal — and they're already what the spec mocks show
// (`mm/dd/yyyy`, `03:00 AM`).

function DateField({ value, onChange, ariaLabel, testId }: {
  value: string  // YYYY-MM-DD or ''
  onChange: (v: string) => void
  ariaLabel: string
  testId?: string
}) {
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

function TimeField({ value, onChange, ariaLabel, testId }: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  testId?: string
}) {
  return (
    <input
      type="time"
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

// ── Main form ──────────────────────────────────────────────────────────────────

interface SchedulePickerFormProps {
  initial: SchedulePickerValue | null
  /** Save the new value (or `null` to clear the schedule entirely). */
  onSave: (next: SchedulePickerValue | null) => void
  /** Dismiss without saving. */
  onCancel: () => void
}

/**
 * The Once / Recurring schedule card. Self-contained: takes an
 * initial value, emits a new value (or `null` to clear) only when the
 * user presses Save. Designed to live inside a Popover (composer
 * toolbar, task ... menu) or a Sheet (mobile).
 */
export function SchedulePickerForm({ initial, onSave, onCancel }: SchedulePickerFormProps) {
  // Seed once on mount. We deliberately do NOT re-seed from `initial`
  // on every render — the parent (TaskCard / ComposerPickers) rebuilds
  // its `initial` object on every render, and the Tasks view re-renders
  // constantly off WS message events. A naive `useEffect([initial])`
  // would fire between the user's clicks and snap the form back to the
  // initial seed, wiping each edit as soon as it lands.
  //
  // The Dialog that hosts this form unmounts on close (Radix default),
  // so the next open will re-run this initializer with the latest
  // `initial` anyway.
  const [form, setForm] = useState<InternalForm>(() => formFromValue(initial))

  function set<K extends keyof InternalForm>(key: K, value: InternalForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function patchParams(delta: Partial<ScheduleParams>) {
    setForm(prev => {
      const next = { ...prev.params, ...delta }
      if (delta.unit === 'weeks' && next.weekdays.length === 0) next.weekdays = [1]
      return { ...prev, params: next }
    })
  }

  function toggleWeekday(i: number) {
    setForm(prev => {
      const has  = prev.params.weekdays.includes(i)
      const days = has
        ? prev.params.weekdays.filter(d => d !== i)
        : [...prev.params.weekdays, i]
      return { ...prev, params: { ...prev.params, weekdays: days.length === 0 ? [i] : days } }
    })
  }

  const params      = form.params
  const timeValue   = `${pad2(params.hour)}:${pad2(params.minute)}`
  const needsTime   = params.unit === 'days' || params.unit === 'weeks' || params.unit === 'months'
  const cronPreview = useMemo(() => describeCron(buildCron(params)), [params])

  return (
    <div className="flex flex-col gap-4" data-testid="schedule-picker">
      {/* Once / Recurring tabs */}
      <Tabs value={form.mode} onValueChange={v => set('mode', v as Mode)}>
        <TabsList className="w-full">
          <TabsTrigger value="once" data-testid="schedule-tab-once">Once</TabsTrigger>
          <TabsTrigger value="recurring" data-testid="schedule-tab-recurring">Recurring</TabsTrigger>
        </TabsList>
      </Tabs>

      {form.mode === 'once' ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <DateField
              ariaLabel="Date"
              testId="schedule-once-date"
              value={form.onceDate}
              onChange={v => set('onceDate', v)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Time</label>
            <TimeField
              ariaLabel="Time"
              testId="schedule-once-time"
              value={form.onceTime}
              onChange={v => set('onceTime', v)}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Every [N] [unit] */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Repeat</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground shrink-0">Every</span>
              <Input
                type="number"
                min={1}
                max={params.unit === 'minutes' ? 59 : params.unit === 'hours' ? 23 : 99}
                value={params.n}
                onChange={e => patchParams({ n: Math.max(1, Number(e.target.value)) })}
                className="w-16 text-center"
              />
              <select
                value={params.unit}
                onChange={e => patchParams({ unit: e.target.value as Unit })}
                className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {UNITS.map(u => (
                  <option key={u.value} value={u.value}>
                    {params.n === 1 ? u.singular : u.plural}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Day-of-week chips */}
          {params.unit === 'weeks' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">On</label>
              <div className="flex gap-1">
                {WEEKDAY_LABELS.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleWeekday(i)}
                    className={`flex-1 h-9 rounded-md border text-xs font-medium transition-colors ${
                      params.weekdays.includes(i)
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
          {params.unit === 'months' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">On day</label>
              <Input
                type="number"
                min={1}
                max={28}
                value={params.day}
                onChange={e => patchParams({ day: Math.min(28, Math.max(1, Number(e.target.value))) })}
                className="w-24"
              />
            </div>
          )}

          {/* Time */}
          {needsTime && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">At</label>
              <TimeField
                ariaLabel="At"
                testId="schedule-recurring-time"
                value={timeValue}
                onChange={v => {
                  const [hh, mm] = v.split(':').map(Number)
                  patchParams({ hour: hh ?? 0, minute: mm ?? 0 })
                }}
              />
            </div>
          )}

          {/* Begin / End */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Begin on</label>
              <DateField
                ariaLabel="Begin on"
                testId="schedule-recurring-begin"
                value={form.beginDate}
                onChange={v => set('beginDate', v)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">End on</label>
              <DateField
                ariaLabel="End on"
                testId="schedule-recurring-end"
                value={form.endDate}
                onChange={v => set('endDate', v)}
              />
            </div>
          </div>

          {/* Cron preview */}
          <p className="text-xs italic text-muted-foreground">{cronPreview}</p>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="schedule-clear"
          onClick={() => onSave(null)}
          className="text-muted-foreground hover:text-foreground"
        >
          Clear
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" data-testid="schedule-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="schedule-save"
            onClick={() => {
              const next = valueFromForm(form)
              if (next) onSave(next)
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Human-readable label for a value, suitable for a trigger button. */
export function describeScheduleValue(value: SchedulePickerValue | null): string {
  if (!value) return 'Schedule'
  if (value.cron) return describeCron(value.cron)
  if (value.executeAt) {
    return format(new Date(value.executeAt), 'MMM d, h:mm a')
  }
  return 'Schedule'
}
