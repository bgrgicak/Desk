import {
  Zap, FileText, ImageIcon, Table, Globe, Play, ListTodo,
  CalendarClock, ChevronDown, Bot, Shapes, type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
  Button,
} from '@agent-desk/ui'
import type { ChatGoalKind } from '@/data/ui-types'
import type { ServerAgent } from '@/store/types'

export interface ChatFilterValues {
  goal: ChatGoalKind | null
  agentId: string | null
  updatesOnly: boolean
  artifactsOnly: boolean
}

interface ChatFilterPopoverProps {
  agents: ServerAgent[]
  values: ChatFilterValues
  onChange: (values: ChatFilterValues) => void
  onApply: () => void
  onCancel: () => void
}

const GOAL_ICONS: Record<ChatGoalKind, LucideIcon> = {
  app:       Zap,
  document:  FileText,
  image:     ImageIcon,
  data:      Table,
  site:      Globe,
  run:       Play,
  task:      ListTodo,
  scheduled: CalendarClock,
}

const GOAL_LABELS: Record<ChatGoalKind, string> = {
  app:       'App',
  document:  'Document',
  image:     'Image',
  data:      'Data',
  site:      'Site',
  run:       'Run',
  task:      'Task',
  scheduled: 'Scheduled',
}

const GOAL_KINDS = Object.keys(GOAL_LABELS) as ChatGoalKind[]

export function ChatFilterPopover({
  agents,
  values,
  onChange,
  onApply,
  onCancel,
}: ChatFilterPopoverProps) {
  const selectedGoalLabel = values.goal ? GOAL_LABELS[values.goal] : 'All goals'
  const SelectedGoalIcon = values.goal ? GOAL_ICONS[values.goal] : Shapes
  const selectedAgentLabel = values.agentId
    ? (agents.find(a => a.id === values.agentId)?.name ?? 'Unknown')
    : 'All agents'

  return (
    <div className="flex flex-col p-3 w-72">
      {/* Dropdowns */}
      <div className="flex flex-col gap-2">
        {/* Goal */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Goal</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <SelectedGoalIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                  {selectedGoalLabel}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px]">
              <DropdownMenuItem onSelect={() => onChange({ ...values, goal: null })}>
                <Shapes className="h-4 w-4 text-muted-foreground" />
                All goals
              </DropdownMenuItem>
              {GOAL_KINDS.map(kind => {
                const Icon = GOAL_ICONS[kind]
                return (
                  <DropdownMenuItem
                    key={kind}
                    onSelect={() => onChange({ ...values, goal: kind })}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {GOAL_LABELS[kind]}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Agent */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Agent</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/30 transition-colors"
              >
                <span>{selectedAgentLabel}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px]">
              <DropdownMenuItem onSelect={() => onChange({ ...values, agentId: null })}>
                <Shapes className="h-4 w-4 text-muted-foreground" />
                All agents
              </DropdownMenuItem>
              {agents.map(agent => (
                <DropdownMenuItem
                  key={agent.id}
                  onSelect={() => onChange({ ...values, agentId: agent.id })}
                >
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  {agent.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-3 mt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm">Updates only</span>
          <Switch
            checked={values.updatesOnly}
            onCheckedChange={checked => onChange({ ...values, updatesOnly: checked })}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm">With artifacts</span>
          <Switch
            checked={values.artifactsOnly}
            onCheckedChange={checked => onChange({ ...values, artifactsOnly: checked })}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={onApply}>Apply</Button>
      </div>
    </div>
  )
}
