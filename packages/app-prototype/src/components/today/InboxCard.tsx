import { motion } from 'framer-motion'
import { Bot, Zap, MoreHorizontal, CheckCircle2, Sparkles, Clock } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Artifact, InboxItem, Run } from '@/data/ui-types'
import { getRelativeTime, getArtifactIcon } from '@/data/ui-types'

interface InboxCardProps {
  item: InboxItem
  onClick: () => void
  onSomethingElse?: () => void
  index?: number
  isSelected?: boolean
  /** Optional artifact — looked up by parent from the library cache. */
  artifact?: Artifact | null
  /** Optional run — looked up by parent from the runs cache. */
  run?: Run | null
}

export function InboxCard({
  item,
  onClick,
  onSomethingElse,
  index = 0,
  isSelected = false,
  artifact = null,
  run = null,
}: InboxCardProps) {
  const contextName = artifact?.name ?? run?.name ?? 'Ask'
  const ContextIcon = artifact ? getArtifactIcon(artifact.type) : run ? Zap : Bot

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      className={`group w-full text-left bg-background p-4 border-b last:border-b-0 transition-all cursor-pointer ${
        isSelected ? 'bg-muted/40' : 'hover:bg-muted/40'
      }`}
    >
      {/* Meta row */}
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center gap-1 min-w-0">
          <Bot className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground">{item.agentName}</span>
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <ContextIcon className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{contextName}</span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{getRelativeTime(item.timestamp)}</span>
        {!item.read && (
          <div className="flex items-center gap-1 shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span className="text-xs text-blue-500">New</span>
          </div>
        )}

        {/* Kebab — right-aligned, only visible on hover / selected */}
        <div className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="More options"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                Mark as
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 cursor-pointer">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                Complete
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                Not relevant
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Move to later
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Message */}
      <p className="text-sm leading-relaxed text-foreground line-clamp-2">
        {item.message}
      </p>

      {/* Quick reply pills */}
      {item.quickReplies && item.quickReplies.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.quickReplies.map(reply => (
            <button
              key={reply}
              onClick={e => e.stopPropagation()}
              className="rounded-full border bg-background px-3.5 py-1 text-sm text-foreground hover:bg-muted transition-colors"
            >
              {reply}
            </button>
          ))}
          <button
            onClick={e => { e.stopPropagation(); onSomethingElse?.() }}
            className="rounded-full border bg-background px-3.5 py-1 text-sm text-foreground hover:bg-muted transition-colors"
          >
            Something else
          </button>
        </div>
      )}
    </motion.div>
  )
}
