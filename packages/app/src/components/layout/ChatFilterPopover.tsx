import {
  Zap, FileText, ImageIcon, Table, Globe, Play, ListTodo,
  CalendarClock, ChevronDown, Search, Shapes, type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
  Button,
} from '@roomy-ai/ui'
import type { ChatGoalKind } from '@/data/ui-types'

export interface ChatFilterValues {
  /** Renamed from `goal` — the picker labels the field "Tool" in the
   *  UI but the underlying ChatGoalKind taxonomy is unchanged. The
   *  shape stays `goal` here so consumers' equality checks against
   *  the kind enum keep working. */
  goal: ChatGoalKind | null
  updatesOnly: boolean
}

interface ChatFilterPopoverProps {
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
  search:    Search,
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
  search:    'Search',
  task:      'Task',
  scheduled: 'Scheduled',
}

const GOAL_KINDS = Object.keys(GOAL_LABELS) as ChatGoalKind[]

export function ChatFilterPopover({
  values,
  onChange,
  onApply,
  onCancel,
}: ChatFilterPopoverProps) {
  const selectedGoalLabel = values.goal ? GOAL_LABELS[values.goal] : 'All tools'
  const SelectedGoalIcon = values.goal ? GOAL_ICONS[values.goal] : Shapes

  return (
    <div className="flex flex-col p-3 w-72">
      {/* Tool picker (was "Goal" — renamed to match the composer's
          tool selector; the `goal` field name underneath stays
          unchanged because it's the ChatGoalKind enum identity). */}
      <div className="flex flex-col gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Tool</label>
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
                All tools
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
      </div>

      {/* Toggles — the Agent picker and "With artifacts" switch were
          removed: the workspace's single agent makes Agent a no-op,
          and the artifact filter overlapped with the Library view. */}
      <div className="flex flex-col gap-3 mt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm">Updates only</span>
          <Switch
            checked={values.updatesOnly}
            onCheckedChange={checked => onChange({ ...values, updatesOnly: checked })}
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
