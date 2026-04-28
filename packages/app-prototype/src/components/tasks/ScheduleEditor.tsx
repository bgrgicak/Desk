import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDown } from 'lucide-react'

type Mode = 'once' | 'recurring'
type Cadence = 'daily' | 'weekdays' | 'weekly' | 'custom'

const CADENCE_LABELS: Record<Cadence, string> = {
  daily:    'Every day',
  weekdays: 'Weekdays (Mon–Fri)',
  weekly:   'Weekly',
  custom:   'Custom cron',
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function dateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function timeInputValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// Best-effort parse: "min hour dom month dow" — only handles the cron
// shapes this editor produces. Returns null for anything else.
function parseCron(cron: string): { cadence: Cadence; minute: number; hour: number; weekday: number } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, month, dow] = parts
  const minute = Number(m)
  const hour = Number(h)
  if (Number.isNaN(minute) || Number.isNaN(hour)) return null
  if (dom !== '*' || month !== '*') return null
  if (dow === '*') return { cadence: 'daily', minute, hour, weekday: 1 }
  if (dow === '1-5') return { cadence: 'weekdays', minute, hour, weekday: 1 }
  if (/^[0-6]$/.test(dow)) return { cadence: 'weekly', minute, hour, weekday: Number(dow) }
  return null
}

function buildCron(cadence: Cadence, minute: number, hour: number, weekday: number, customCron: string): string {
  if (cadence === 'custom') return customCron.trim()
  if (cadence === 'daily')    return `${minute} ${hour} * * *`
  if (cadence === 'weekdays') return `${minute} ${hour} * * 1-5`
  return `${minute} ${hour} * * ${weekday}`
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

  // Once-mode state — defaults to current executeAt or today at next round hour.
  const initialOnceDate = currentExecuteAt ?? (() => {
    const d = new Date()
    d.setHours(d.getHours() + 1, 0, 0, 0)
    return d
  })()
  const [onceDate, setOnceDate] = useState(dateInputValue(initialOnceDate))
  const [onceTime, setOnceTime] = useState(timeInputValue(initialOnceDate))

  // Recurring-mode state.
  const [cadence, setCadence]       = useState<Cadence>(initialParsed?.cadence ?? 'daily')
  const [recurMinute, setRecurMin]  = useState(initialParsed?.minute ?? 0)
  const [recurHour, setRecurHour]   = useState(initialParsed?.hour ?? 9)
  const [weekday, setWeekday]       = useState(initialParsed?.weekday ?? 1)
  const [customCron, setCustomCron] = useState(initialParsed ? '' : (currentCron ?? ''))
  const [beginDate, setBeginDate]   = useState(currentExecuteAt ? dateInputValue(currentExecuteAt) : '')
  const [endDate, setEndDate]       = useState('')

  const recurTime = `${pad2(recurHour)}:${pad2(recurMinute)}`

  function handleSave() {
    if (mode === 'once') {
      const [y, m, d] = onceDate.split('-').map(Number)
      const [hh, mm] = onceTime.split(':').map(Number)
      const when = new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0)
      void onSave({ executeAt: when.toISOString(), cron: null })
    } else {
      const cron = buildCron(cadence, recurMinute, recurHour, weekday, customCron)
      if (!cron) return
      let executeAt: string | null = null
      if (beginDate) {
        const [y, m, d] = beginDate.split('-').map(Number)
        executeAt = new Date(y, (m ?? 1) - 1, d ?? 1).toISOString()
      }
      void onSave({ executeAt, cron })
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3 w-72" data-testid="schedule-editor">
      {/* Mode toggle */}
      <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
        {(['once', 'recurring'] as Mode[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            data-testid={`schedule-mode-${m}`}
            className={`flex-1 rounded-full px-3 text-xs font-medium capitalize transition-colors h-full ${
              mode === m
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {m === 'once' ? 'Once' : 'Recurring'}
          </button>
        ))}
      </div>

      {mode === 'once' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <Input
              type="date"
              data-testid="schedule-once-date"
              value={onceDate}
              onChange={e => setOnceDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Time</label>
            <Input
              type="time"
              data-testid="schedule-once-time"
              value={onceTime}
              onChange={e => setOnceTime(e.target.value)}
            />
          </div>
        </div>
      )}

      {mode === 'recurring' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Cadence</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="schedule-cadence"
                  className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
                >
                  <span>{CADENCE_LABELS[cadence]}</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[260px]">
                {(Object.keys(CADENCE_LABELS) as Cadence[]).map(c => (
                  <DropdownMenuItem
                    key={c}
                    onSelect={() => setCadence(c)}
                    data-testid={`schedule-cadence-${c}`}
                  >
                    {CADENCE_LABELS[c]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {cadence === 'weekly' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Day of week</label>
              <div className="flex gap-1">
                {WEEKDAYS.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setWeekday(i)}
                    className={`flex-1 h-8 rounded-md border text-xs transition-colors ${
                      weekday === i
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

          {cadence !== 'custom' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Time</label>
              <Input
                type="time"
                data-testid="schedule-recur-time"
                value={recurTime}
                onChange={e => {
                  const [hh, mm] = e.target.value.split(':').map(Number)
                  setRecurHour(hh ?? 0)
                  setRecurMin(mm ?? 0)
                }}
              />
            </div>
          )}

          {cadence === 'custom' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Cron expression</label>
              <Input
                data-testid="schedule-custom-cron"
                placeholder="0 9 * * 1"
                value={customCron}
                onChange={e => setCustomCron(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Format: <code>min hour day month weekday</code>
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <div className="space-y-1 flex-1 min-w-0">
              <label className="text-xs font-medium text-muted-foreground">Begin on</label>
              <Input
                type="date"
                data-testid="schedule-begin-date"
                value={beginDate}
                onChange={e => setBeginDate(e.target.value)}
              />
            </div>
            <div className="space-y-1 flex-1 min-w-0">
              <label className="text-xs font-medium text-muted-foreground">End on (optional)</label>
              <Input
                type="date"
                data-testid="schedule-end-date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center pt-1">
        <Button
          variant="ghost"
          size="sm"
          data-testid="schedule-clear"
          disabled={busy || (!currentExecuteAt && !currentCron)}
          onClick={() => { void onClear(); onClose() }}
        >
          Clear
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" data-testid="schedule-save" onClick={() => { handleSave(); onClose() }} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
