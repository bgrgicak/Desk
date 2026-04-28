import { useEffect, useMemo, useRef } from 'react'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { MessageBubble } from '@/components/compose/MessageBubble'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useGlobalPalette } from './GlobalPaletteProvider'
import { useGlobalChat, type GlobalChatMessage } from './globalChatStore'
import type { ServerMessage } from '@/store/types'

/** Adapt a frontend-stub GlobalChatMessage to the ServerMessage shape that
 * the shared MessageBubble expects. Streaming agent rows whose content is
 * still empty are dropped here — the StatusIndicator covers that interval. */
function toServerMessage(m: GlobalChatMessage): ServerMessage {
  return {
    id: m.id,
    chatId: 'global',
    role: m.role,
    content: { type: 'text', text: m.content },
    createdAt: new Date(m.createdAt).toISOString(),
  }
}

export function GlobalPaletteChat() {
  const { chatId, sendMessage, showSearch } = useGlobalPalette()
  const chat = useGlobalChat(chatId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Render agent rows only once they have content; an empty streaming row
  // would render as a hollow bubble — show the typing indicator instead.
  const visibleMessages = useMemo(() => {
    if (!chat) return []
    return chat.messages.filter(m => m.content.length > 0)
  }, [chat])
  const isTyping = !!chat?.messages.some(m => m.role === 'agent' && m.streaming)

  // Auto-scroll to bottom on each render where messages change.
  const lastTick = visibleMessages.map(m => `${m.id}:${m.content.length}`).join(',')
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lastTick, isTyping])

  if (!chat) {
    return <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">Chat not found.</div>
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-[52px] flex items-center gap-2 border-b px-3 shrink-0">
        <button
          onClick={showSearch}
          title="Back to search"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{chat.title || 'New chat'}</span>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {visibleMessages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={toServerMessage(m)}
              isFirstInGroup={i === 0 || visibleMessages[i - 1].role !== m.role}
              fallbackModel="Desk AI"
              developerMode={false}
            />
          ))}
          <StatusIndicator text={null} isTyping={isTyping} />
        </div>
      </div>

      {/* Input — same component used in the artifact details Chat tab */}
      <div className="border-t p-3 shrink-0">
        <ChatInput
          onSend={(msg) => sendMessage(msg)}
          placeholder="Ask a follow-up..."
          compact
          showGoalPicker={false}
          hideAgentPicker
          directUpload
          autoFocus
        />
      </div>
    </div>
  )
}
