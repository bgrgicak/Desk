import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { MessageBubble } from './MessageBubble'
import { StatusIndicator } from './StatusIndicator'
import { isMessageVisible } from './messageVisibility'
import { useGetChatMessagesQuery } from '@/store/api'
import type { AttachmentRef, ServerMessage } from '@/store/types'

// ── ChatThread ────────────────────────────────────────────────────────────────

export interface ChatThreadProps {
  chatId: string
  workspaceId?: string
  /** When true the messages query is skipped (used for the "new chat" stub). */
  skipQuery?: boolean
  agentName?: string
  developerMode?: boolean
  /** Additional "sending" state from the parent's mutation (POST /messages). */
  isSending?: boolean
  highlightMessageId?: string
  /** CSS classes for the inner message list container. */
  innerClassName?: string
  /** CSS classes for regular message rows within the list container. */
  messageClassName?: string | ((message: ServerMessage) => string | undefined)
  /** CSS classes for the typing/status row. */
  statusClassName?: string
  /** CSS classes for the agent name/time row. */
  agentHeaderClassName?: string
  /** CSS classes for content rendered after the final assistant message. */
  lastAssistantSlotClassName?: string
  /** Rendered above the message list (e.g. "Open in chat" link). */
  headerSlot?: ReactNode
  /** Rendered below the scroll area (e.g. ChatInput). */
  footerSlot?: ReactNode
  /** Replaces the default "No messages yet" empty state. */
  emptySlot?: ReactNode
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Called after the last assistant message (e.g. inline artifact cards). */
  lastAssistantSlot?: (messageId: string) => ReactNode
  showNewBadge?: boolean
  /** Optional additional filter applied after the default visibility check.
   *  Return false to hide a message from this thread instance.
   *  Should be a stable reference (module-level constant or memoized) to avoid
   *  unnecessary message-list recomputations. */
  filterMessage?: (m: ServerMessage) => boolean
}

export function ChatThread({
  chatId,
  workspaceId,
  skipQuery = false,
  agentName,
  developerMode = false,
  isSending = false,
  highlightMessageId,
  innerClassName = 'space-y-6 p-4',
  messageClassName,
  statusClassName,
  agentHeaderClassName,
  lastAssistantSlotClassName,
  headerSlot,
  footerSlot,
  emptySlot,
  onAttachmentClick,
  lastAssistantSlot,
  showNewBadge = false,
  filterMessage,
}: ChatThreadProps) {
  const { data, isLoading } = useGetChatMessagesQuery({ chatId }, { skip: skipQuery })
  const scrollRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const allItems = data?.items ?? []

  const hasPendingTrigger = allItems.some(
    m => m.content.type === 'agent_turn' && (m.state === 'pending' || m.state === 'running'),
  )
  const isTyping = hasPendingTrigger || isSending

  const messages: ServerMessage[] = useMemo(
    () => {
      const visible = allItems.filter(m => isMessageVisible(m, developerMode))
      return filterMessage ? visible.filter(filterMessage) : visible
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, developerMode, filterMessage],
  )

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent') return messages[i].id
    }
    return null
  }, [messages])

  const resolvedStatusClassName = statusClassName ?? (typeof messageClassName === 'string' ? messageClassName : undefined)

  useEffect(() => {
    if (highlightMessageId) {
      const el = messageRefs.current.get(highlightMessageId)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        return
      }
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping, highlightMessageId])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {headerSlot}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className={innerClassName}>
          {messages.length === 0 && !isLoading && (
            emptySlot ?? (
              <p className="text-xs text-muted-foreground text-center pt-4" data-testid="task-chat-empty">
                No messages yet. Ask a question or request changes.
              </p>
            )
          )}
          {messages.map((msg, i) => (
            <div
              key={msg.id}
              data-message-id={msg.id}
              ref={(el) => {
                if (el) messageRefs.current.set(msg.id, el)
                else messageRefs.current.delete(msg.id)
              }}
            >
              <div className={typeof messageClassName === 'function' ? messageClassName(msg) : messageClassName}>
                <MessageBubble
                  message={msg}
                  workspaceId={workspaceId}
                  agentName={agentName}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role || messages[i - 1].content.type === 'artifactRef'}
                  isNew={showNewBadge && msg.id === lastAssistantId}
                  onAttachmentClick={onAttachmentClick}
                  agentHeaderClassName={agentHeaderClassName}
                  hideAgentHeader={msg.content.type === 'artifactRef'}
                  developerMode={developerMode}
                />
              </div>
              {lastAssistantSlot && msg.id === lastAssistantId && (
                <div className={lastAssistantSlotClassName}>
                  {lastAssistantSlot(msg.id)}
                </div>
              )}
            </div>
          ))}
          {isTyping && (
            <div className={resolvedStatusClassName}>
              <StatusIndicator text={null} isTyping={isTyping} />
            </div>
          )}
        </div>
      </div>
      {footerSlot}
    </div>
  )
}
