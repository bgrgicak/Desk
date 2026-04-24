import { useState, useEffect, useRef } from 'react'
import {
  X,
  ChevronDown,
  Bot,
  User,
  FileText,
  StickyNote,
  Link2,
  Folder,
  Search,
  Paperclip,
  Calendar,
  Target,
  Zap,
  ImageIcon,
  Table,
  Globe,
  Play,
  type LucideIcon,
} from 'lucide-react'
import { format } from 'date-fns'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Calendar as CalendarPicker } from '@/components/ui/calendar'
import { MOCK_AGENTS, MOCK_CONTEXT, MOCK_FOLDERS } from '@/data/mock-data'
import type { Task, ContextItem } from '@/data/mock-data'
import { StatusBadge, PriorityIcon, STATUS_LABELS, PRIORITY_LABELS, PRIORITY_CONFIG } from './task-badges'
import type { Priority } from './task-badges'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TaskSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateTask: (task: Task) => void
  defaultStatus?: Task['status']
}

type FormStatus   = Task['status']
type ScheduleType = 'once' | 'repeat'
type GoalKey      = 'app' | 'document' | 'image' | 'data' | 'site' | 'run' | null

interface AttachedItem {
  id: string
  name: string
  kind: 'folder' | 'item'
  type?: ContextItem['type']
}

interface FormState {
  name:            string
  description:     string
  status:          FormStatus
  assigneeId:      string
  priority:        Priority
  goalKey:         GoalKey
  attachedItems:   AttachedItem[]
  scheduledFor:    Date | undefined
  scheduleEndDate: Date | undefined
  scheduleType:    ScheduleType
}

const DEFAULT_FORM: FormState = {
  name:            '',
  description:     '',
  status:          'todo',
  assigneeId:      'user',
  priority:        'medium',
  goalKey:         null,
  attachedItems:   [],
  scheduledFor:    undefined,
  scheduleEndDate: undefined,
  scheduleType:    'once',
}

// ── Goal config ────────────────────────────────────────────────────────────────

const GOALS: { key: GoalKey; label: string; Icon: LucideIcon | null }[] = [
  { key: 'app',      label: 'New app',   Icon: Zap       },
  { key: 'document', label: 'New doc',   Icon: FileText  },
  { key: 'image',    label: 'New image', Icon: ImageIcon },
  { key: 'data',     label: 'New data',  Icon: Table     },
  { key: 'site',     label: 'New site',  Icon: Globe     },
  { key: 'run',      label: 'New run',   Icon: Play      },
  { key: null,       label: 'No goal',   Icon: Target    },
]

// ── Context item icon map ──────────────────────────────────────────────────────

const ITEM_ICON: Record<ContextItem['type'], LucideIcon> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const pickerBtnClass = 'flex items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors px-2 h-6 text-xs font-medium shrink-0'

// ── Date dropdown field ────────────────────────────────────────────────────────

function DateField({
  label,
  value,
  onChange,
}: {
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
  const [fileSearch, setFileSearch] = useState('')
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm({ ...DEFAULT_FORM, status: defaultStatus ?? 'todo' })
      setFileSearch('')
    }
    prevOpenRef.current = open
  }, [open, defaultStatus])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function toggleAttachment(item: AttachedItem) {
    setForm(prev => ({
      ...prev,
      attachedItems: prev.attachedItems.some(a => a.id === item.id)
        ? prev.attachedItems.filter(a => a.id !== item.id)
        : [...prev.attachedItems, item],
    }))
  }

  function removeAttachment(id: string) {
    setForm(prev => ({ ...prev, attachedItems: prev.attachedItems.filter(a => a.id !== id) }))
  }

  function handleCreate() {
    const now = new Date()
    const agentName = form.assigneeId === 'user' ? 'User' : form.assigneeId
    const newTask: Task = {
      id:              `task-${Date.now()}`,
      name:            form.name.trim() || 'Untitled task',
      description:     form.description.trim() || undefined,
      agentName,
      status:          form.status,
      statusText:      '',
      priority:        form.priority,
      assigneeId:      form.assigneeId,
      startedAt:       now,
      artifactIds:     [],
      scheduledFor:    form.status === 'scheduled' ? form.scheduledFor : undefined,
      scheduleEndDate: form.status === 'scheduled' && form.scheduleType === 'repeat' ? form.scheduleEndDate : undefined,
      scheduleRepeat:  form.status === 'scheduled' && form.scheduleType === 'repeat',
      color:           'blue',
      history:         [],
    }
    onCreateTask(newTask)
    onOpenChange(false)
  }

  const assigneeLabel = form.assigneeId === 'user' ? 'You' : form.assigneeId
  const activeGoal    = GOALS.find(g => g.key === form.goalKey) ?? GOALS[GOALS.length - 1]

  const allAttachments: AttachedItem[] = [
    ...MOCK_FOLDERS.map(f => ({ id: f.id, name: f.name, kind: 'folder' as const })),
    ...MOCK_CONTEXT.map(i => ({ id: i.id, name: i.name, kind: 'item' as const, type: i.type })),
  ]
  const filteredFiles = allAttachments.filter(
    a => !fileSearch || a.name.toLowerCase().includes(fileSearch.toLowerCase())
  )

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
              placeholder="Task name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          {/* Assignee + Priority — 2-col */}
          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Assignee</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
                  >
                    {form.assigneeId === 'user'
                      ? <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      : <Bot  className="h-4 w-4 text-muted-foreground shrink-0" />
                    }
                    <span className="flex-1 text-left text-sm truncate">{assigneeLabel}</span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onSelect={() => set('assigneeId', 'user')}>
                    <User className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    You
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {MOCK_AGENTS.map(agent => (
                    <DropdownMenuItem key={agent.name} onSelect={() => set('assigneeId', agent.name)}>
                      <Bot className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                      {agent.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Priority</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
                  >
                    <PriorityIcon priority={form.priority} />
                    <span className="flex-1 text-left text-sm truncate">{PRIORITY_LABELS[form.priority]}</span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  {(['highest', 'high', 'medium', 'low'] as Priority[]).map(p => {
                    const { icon: Icon, iconClass } = PRIORITY_CONFIG[p]
                    return (
                      <DropdownMenuItem key={p} onSelect={() => set('priority', p)} className="gap-2">
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                        {PRIORITY_LABELS[p]}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Instructions — ChatInput-style with goal + file pills */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Instructions</label>

            {/* Input card */}
            <div className="rounded-lg border bg-background shadow-xs">
              {/* Attached file chips */}
              {form.attachedItems.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                  {form.attachedItems.map(item => {
                    const Icon = item.kind === 'folder'
                      ? Folder
                      : ITEM_ICON[item.type ?? 'file'] ?? FileText
                    return (
                      <span
                        key={item.id}
                        className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
                      >
                        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.name}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(item.id)}
                          className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}

              {/* Textarea */}
              <div className="px-3 py-2">
                <textarea
                  rows={4}
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Add a description or instructions for the AI agent..."
                  className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-h-[72px]"
                />
              </div>
            </div>

            {/* Picker pills row */}
            <div className="flex items-center gap-1.5">
              {/* Goal picker */}
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className={`${pickerBtnClass} ${form.goalKey !== null ? 'text-foreground' : ''}`}>
                    {activeGoal.Icon
                      ? <activeGoal.Icon className="h-3 w-3" />
                      : <Target className="h-3 w-3" />
                    }
                    {activeGoal.label}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-52 p-0">
                  <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Output
                  </p>
                  <div className="pb-1.5">
                    {GOALS.map(goal => (
                      <button
                        key={String(goal.key)}
                        type="button"
                        onClick={() => set('goalKey', goal.key)}
                        className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${form.goalKey === goal.key ? 'bg-muted/30' : ''}`}
                      >
                        {goal.Icon
                          ? <goal.Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          : <span className="h-3.5 w-3.5 shrink-0" />
                        }
                        {goal.label}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Add files */}
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className={pickerBtnClass}>
                    <Paperclip className="h-3 w-3" />
                    Add files
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="flex items-center gap-2 px-3 py-2 border-b">
                    <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <input
                      autoFocus
                      value={fileSearch}
                      onChange={e => setFileSearch(e.target.value)}
                      placeholder="Search files and folders…"
                      className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
                    />
                  </div>
                  <div className="overflow-y-auto max-h-52">
                    {filteredFiles.length === 0 && (
                      <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
                    )}
                    {filteredFiles.some(a => a.kind === 'folder') && (
                      <>
                        <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                          Folders
                        </p>
                        {filteredFiles.filter(a => a.kind === 'folder').map(a => (
                          <button key={a.id} type="button" onClick={() => toggleAttachment(a)}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                          >
                            <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate flex-1">{a.name}</span>
                            {form.attachedItems.some(i => i.id === a.id) && (
                              <span className="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
                            )}
                          </button>
                        ))}
                      </>
                    )}
                    {filteredFiles.some(a => a.kind === 'item') && (
                      <>
                        <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                          Files
                        </p>
                        {filteredFiles.filter(a => a.kind === 'item').map(a => {
                          const Icon = ITEM_ICON[a.type ?? 'file'] ?? FileText
                          return (
                            <button key={a.id} type="button" onClick={() => toggleAttachment(a)}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                            >
                              <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="truncate flex-1">{a.name}</span>
                              {form.attachedItems.some(i => i.id === a.id) && (
                                <span className="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
                              )}
                            </button>
                          )
                        })}
                      </>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
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

          {/* Scheduled: radio buttons */}
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

          {/* "Do it once" — single date picker, half width */}
          {form.status === 'scheduled' && form.scheduleType === 'once' && (
            <div className="flex gap-4">
              <DateField
                label="Execute on"
                value={form.scheduledFor}
                onChange={d => set('scheduledFor', d)}
              />
              {/* spacer to keep it half-width */}
              <div className="flex-1" />
            </div>
          )}

          {/* "Repeat" — two pickers side by side */}
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

        {/* Footer — no border separator */}
        <div className="p-4 flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate}>Create task</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
