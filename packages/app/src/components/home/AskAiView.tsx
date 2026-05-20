import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { MessageBubble } from '@/components/compose/MessageBubble'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import {
  useGlobalChat,
  createGlobalChat,
  sendGlobalChatMessage,
  type GlobalChatMessage,
} from '@/components/global-palette/globalChatStore'
import { usePrefs } from '@/hooks/use-prefs'
import type { ServerMessage } from '@/store/types'

// One persistent "Ask AI" thread on Home. Backed by the existing in-app
// global chat store (mock streaming, localStorage) — the hub-workspace
// chat seam is noted in the plan. We remember a single dedicated chat id
// so Home always reopens the same thread (no thread list).
const ASKAI_ID_KEY = 'desk.home-askai.v1'

function loadAskAiChatId(): string | null {
  try {
    return localStorage.getItem(ASKAI_ID_KEY)
  } catch {
    return null
  }
}
function saveAskAiChatId(id: string): void {
  try {
    localStorage.setItem(ASKAI_ID_KEY, id)
  } catch {
    /* ignore */
  }
}

/** Adapt the global-chat stub message to the ServerMessage shape
 *  MessageBubble expects (same adapter the global palette uses). */
function toServerMessage(m: GlobalChatMessage): ServerMessage {
  return {
    id: m.id,
    // Trunk added `kind` as a required field on ServerMessage. The
    // global-palette stub thread is plain chatter — mark it as such.
    kind: 'chat',
    chatId: 'home-askai',
    role: m.role,
    content: { type: 'text', text: m.content },
    createdAt: new Date(m.createdAt).toISOString(),
  }
}

const COLUMN = 'w-full max-w-4xl min-w-0 mx-auto'

/**
 * The Home "Ask AI" surface — the same chat UI as a room, just a single
 * thread (no thread list / new-chat). Reuses MessageBubble + ChatInput +
 * StatusIndicator over the global chat store.
 */
export function AskAiView() {
  const { developerMode } = usePrefs()
  const [chatId, setChatId] = useState<string | null>(() => loadAskAiChatId())
  const chat = useGlobalChat(chatId)
  const scrollRef = useRef<HTMLDivElement>(null)

  const visibleMessages = useMemo(
    () => (chat ? chat.messages.filter(m => m.content.length > 0) : []),
    [chat],
  )
  const isTyping = !!chat?.messages.some(m => m.role === 'agent' && m.streaming)

  const lastTick = visibleMessages.map(m => `${m.id}:${m.content.length}`).join(',')
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastTick, isTyping])

  const handleSend = (msg: string) => {
    const text = msg.trim()
    if (!text) return
    if (!chatId) {
      const { id } = createGlobalChat(text)
      saveAskAiChatId(id)
      setChatId(id)
      return
    }
    sendGlobalChatMessage(chatId, text)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 pt-8 pb-4">
        <div className={`${COLUMN} space-y-4`}>
          {visibleMessages.length === 0 && !isTyping ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <Sparkles className="h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} />
              <div>
                <p className="text-base font-semibold text-foreground">Ask Desk AI</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ask anything across your rooms — tasks, files, or what to do next.
                </p>
              </div>
            </div>
          ) : (
            <>
              {visibleMessages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={toServerMessage(m)}
                  isFirstInGroup={i === 0 || visibleMessages[i - 1].role !== m.role}
                  agentName="Desk AI"
                  developerMode={developerMode}
                />
              ))}
              <StatusIndicator text={null} isTyping={isTyping} />
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <div className={COLUMN}>
          <ChatInput
            onSend={(msg) => handleSend(msg)}
            placeholder="Ask Desk AI anything…"
            showGoalPicker={false}
            hideAgentPicker
            directUpload
          />
        </div>
      </div>
    </div>
  )
}
