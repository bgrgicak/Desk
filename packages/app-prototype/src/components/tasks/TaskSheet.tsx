import { useState, useEffect, useRef } from 'react'
import {
  X,
  ChevronDown,
  Calendar,
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

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TaskCreateInput {
  name: string
  description?: string
  status: Task['status']
  scheduledFor?: Date
  scheduleEndDate?: Date
  scheduleRepeat?: boolean
}

interface TaskSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateTask: (input: TaskCreateInput) => Promise<void> | void
  defaultStatus?: Task['status']
}

type FormStatus   = Task['status']
type ScheduleType = 'once' | 'repeat'

interface FormState {
  name:            string
  description:     string
  status:          FormStatus
  scheduledFor:    Date | undefined
  scheduleEndDate: Date | undefined
  scheduleType:    ScheduleType
}

const DEFAULT_FORM: FormState = {
  name:            '',
  description:     '',
  status:          'todo',
  scheduledFor:    undefined,
  scheduleEndDate: undefined,
  scheduleType:    'once',
}

// ── Date dropdown field ────────────────────────────────────────────────────────

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

// ── Main component ─────────────────────────────────────────────────────────────

export function TaskSheet({ open, onOpenChange, onCreateTask, defaultStatus }: TaskSheetProps) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm({ ...DEFAULT_FORM, status: defaultStatus ?? 'todo' })
    }
    prevOpenRef.current = open
  }, [open, defaultStatus])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleCreate() {
    setSubmitting(true)
    try {
      await onCreateTask({
        name:            form.name.trim() || 'Untitled task',
        description:     form.description.trim() || undefined,
        status:          form.status,
        scheduledFor:    form.status === 'scheduled' ? form.scheduledFor : undefined,
        scheduleEndDate: form.status === 'scheduled' && form.scheduleType === 'repeat' ? form.scheduleEndDate : undefined,
        scheduleRepeat:  form.status === 'scheduled' && form.scheduleType === 'repeat',
      })
    } finally {
      setSubmitting(false)
    }
  }

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
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">

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
                {(['todo', 'active', 'complete', 'scheduled'] as FormStatus[]).map(s => (
                  <DropdownMenuItem key={s} onSelect={() => set('status', s)} className="gap-2">
                    <StatusBadge status={s} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {form.status === 'scheduled' && (
            <RadioGroup
              value={form.scheduleType}
              onValueChange={v => set('scheduleType', v as ScheduleType)}
              className="flex flex-col gap-2 mt-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="once" id="once" />
                <label htmlFor="once" className="text-sm cursor-pointer">Do it once</label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="repeat" id="repeat" />
                <label htmlFor="repeat" className="text-sm cursor-pointer">Repeat</label>
              </div>
            </RadioGroup>
          )}

          {form.status === 'scheduled' && form.scheduleType === 'once' && (
            <div className="flex gap-4">
              <DateField
                label="Execute on"
                value={form.scheduledFor}
                onChange={d => set('scheduledFor', d)}
              />
              <div className="flex-1" />
            </div>
          )}

          {form.status === 'scheduled' && form.scheduleType === 'repeat' && (
            <div className="flex gap-4">
              <DateField
                label="Begin on"
                value={form.scheduledFor}
                onChange={d => set('scheduledFor', d)}
              />
              <DateField
                label="End on"
                value={form.scheduleEndDate}
                onChange={d => set('scheduleEndDate', d)}
              />
            </div>
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
