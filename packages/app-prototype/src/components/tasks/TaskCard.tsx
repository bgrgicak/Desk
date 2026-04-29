import { Bot } from 'lucide-react'
import { AppCard } from '@/components/ui/app-card'
import type { Task } from '@/data/ui-types'
import { PriorityIcon } from './task-badges'

interface TaskCardProps {
  task: Task
  index?: number
  isSelected?: boolean
  onClick: () => void
  // dnd-kit forwarded refs/props
  setNodeRef?: (node: HTMLElement | null) => void
  style?: React.CSSProperties
  attributes?: Record<string, unknown>
  listeners?: Record<string, unknown>
  isDragging?: boolean
}

export function TaskCard({
  task,
  index = 0,
  isSelected = false,
  onClick,
  setNodeRef,
  style,
  attributes,
  listeners,
  isDragging = false,
}: TaskCardProps) {
  return (
    <AppCard
      onClick={onClick}
      index={index}
      isSelected={isSelected}
      isDragging={isDragging}
      setNodeRef={setNodeRef}
      dragStyle={style}
      dragAttributes={attributes}
      dragListeners={listeners}
    >
      <div className="p-4 space-y-2" data-testid={`task-row-${task.id}`}>
        <p className="text-sm font-medium text-foreground truncate">{task.name}</p>
        {task.description && (
          <p className="text-xs text-muted-foreground line-clamp-1">{task.description}</p>
        )}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground flex-1 truncate">{task.agentName}</span>
          <PriorityIcon priority={task.priority} />
        </div>
      </div>
    </AppCard>
  )
}
