import type { ChatMessage as ChatMessageType } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { Bot } from 'lucide-react'

interface ChatMessageProps {
  message: ChatMessageType
  agentModel?: string
  isFirstInGroup?: boolean
  isNew?: boolean
}

export function ChatMessage({ message, agentModel = 'Claude Sonnet 4', isFirstInGroup = true, isNew = false }: ChatMessageProps) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-secondary text-foreground text-sm leading-relaxed px-3.5 py-2.5 rounded-lg rounded-br-[2px] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className={isFirstInGroup ? 'space-y-1.5' : '-mt-4'}>
      {/* Only show header for the first message in a consecutive agent group */}
      {isFirstInGroup && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Bot className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <span className="text-xs text-muted-foreground">{agentModel}</span>
          </div>
          <span className="text-xs text-muted-foreground">{getRelativeTime(message.timestamp)}</span>
          {isNew && (
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
              <span className="text-xs text-blue-500">New</span>
            </div>
          )}
        </div>
      )}
      {/* Plain text — no bubble */}
      <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
        {message.content}
      </p>
    </div>
  )
}
