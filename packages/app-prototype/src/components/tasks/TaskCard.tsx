import { motion } from 'framer-motion'
import { Bot } from 'lucide-react'
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
    <motion.div
      ref={setNodeRef as ((node: HTMLDivElement | null) => void) | undefined}
      style={style}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isDragging ? 0.4 : 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.2 }}
      {...(attributes as Record<string, unknown>)}
      {...(listeners as Record<string, unknown>)}
      onClick={onClick}
      className={[
        'w-full text-left rounded-xl border bg-background overflow-hidden',
        'hover:shadow-md hover:border-foreground/10 transition-all duration-200',
        'cursor-pointer select-none',
        isSelected ? 'ring-2 ring-ring/30 border-foreground/10' : 'border-border',
        isDragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      <div className="p-4 space-y-2">
        {/* Name */}
        <p className="text-sm font-medium text-foreground truncate">{task.name}</p>

        {/* Description */}
        {task.description && (
          <p className="text-xs text-muted-foreground line-clamp-1">{task.description}</p>
        )}

        {/* Footer: bot + priority */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground flex-1 truncate">{task.agentName}</span>
          <PriorityIcon priority={task.priority} />
        </div>
      </div>
    </motion.div>
  )
}
