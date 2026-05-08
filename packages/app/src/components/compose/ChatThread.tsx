import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import { StatusIndicator } from './StatusIndicator'
import { isMessageVisible } from './messageVisibility'
import { useGetChatMessagesQuery } from '@/store/api'
import type { AttachmentRef, ServerMessage } from '@/store/types'

// ── ChatThread ────────────────────────────────────────────────────────────────

/** Distance from the top (px) at which we trigger loading older messages. */
const SCROLL_TOP_THRESHOLD = 120

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
  // ── Scrollback state ─────────────────────────────────────────────────
  const [beforeCursor, setBeforeCursor] = useState<string | undefined>(undefined)

  // Reset scrollback state when chatId changes.
  const prevChatIdRef = useRef(chatId)
  if (prevChatIdRef.current !== chatId) {
    prevChatIdRef.current = chatId
    setBeforeCursor(undefined)
  }

  // Initial load — newest page (no cursor).
  const { data, isLoading } = useGetChatMessagesQuery(
    { chatId },
    { skip: skipQuery },
  )

  // Load older page when beforeCursor is set.
  const { isFetching: isFetchingOlder } = useGetChatMessagesQuery(
    { chatId, before: beforeCursor! },
    { skip: skipQuery || !beforeCursor },
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /** Tracks whether we should auto-scroll to bottom (user is at the bottom). */
  const isAtBottomRef = useRef(true)
  /** When loading older messages, stores the scroll-height before prepend so
   *  we can restore the scroll position after the DOM updates. */
  const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)

  const allItems = data?.items ?? []
  const prevCursor = data?.prevCursor

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

  // ── Scroll position management ───────────────────────────────────────
  // Track message count to detect when older messages were prepended.
  const prevMessageCountRef = useRef(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // Handle highlighted message scrolling.
    if (highlightMessageId) {
      const msgEl = messageRefs.current.get(highlightMessageId)
      if (msgEl) {
        msgEl.scrollIntoView({ block: 'center' })
        return
      }
    }

    // If older messages were prepended (count grew AND we captured a scroll
    // anchor), restore scroll position so the user's viewport doesn't jump.
    if (scrollAnchorRef.current && messages.length > prevMessageCountRef.current) {
      const { scrollHeight: prevHeight, scrollTop: prevTop } = scrollAnchorRef.current
      const newHeight = el.scrollHeight
      el.scrollTop = prevTop + (newHeight - prevHeight)
      scrollAnchorRef.current = null
      prevMessageCountRef.current = messages.length
      return
    }

    prevMessageCountRef.current = messages.length

    // Auto-scroll to bottom when at/near the bottom.
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isTyping, highlightMessageId])

  // On initial load, scroll to bottom.
  const hasInitialScrolled = useRef(false)
  useEffect(() => {
    if (!isLoading && messages.length > 0 && !hasInitialScrolled.current) {
      hasInitialScrolled.current = true
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }
  }, [isLoading, messages.length])

  // Reset initial scroll flag when chat changes.
  useEffect(() => {
    hasInitialScrolled.current = false
  }, [chatId])

  // ── Load older messages on scroll-to-top ─────────────────────────────
  const loadOlderMessages = useCallback(() => {
    if (!prevCursor || isFetchingOlder) return
    // Capture current scroll position before the DOM changes.
    if (scrollRef.current) {
      scrollAnchorRef.current = {
        scrollHeight: scrollRef.current.scrollHeight,
        scrollTop: scrollRef.current.scrollTop,
      }
    }
    setBeforeCursor(prevCursor)
  }, [prevCursor, isFetchingOlder])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    // Track whether we're at the bottom (within 40px tolerance).
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40

    // Load older messages when scrolled near the top.
    if (el.scrollTop < SCROLL_TOP_THRESHOLD) {
      loadOlderMessages()
    }
  }, [loadOlderMessages])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {headerSlot}
      <div ref={scrollRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        <div className={innerClassName}>
          {/* Loading-older indicator */}
          {isFetchingOlder && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {/* "Beginning of conversation" marker */}
          {!prevCursor && messages.length > 0 && !isLoading && (
            <p className="text-xs text-muted-foreground text-center pt-1 pb-2">
              Beginning of conversation
            </p>
          )}
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
