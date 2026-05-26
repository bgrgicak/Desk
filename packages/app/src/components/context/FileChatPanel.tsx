import { useState, useCallback } from 'react'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput } from '@/components/compose/ChatInput'
import { useLibraryItemChat } from '@/hooks/use-library-item-chat'
import { usePrefs } from '@/hooks/use-prefs'
import type { ContextItem } from '@/data/ui-types'
import { toast } from 'sonner'
import { AGENT_NAME } from '@/lib/constants'

// Mirrors `CHAT_COLUMN_CLASS` in ChatView so this file-chat pane
// centres its messages/composer on the same `max-w-4xl` axis as the
// main chat column (kept in sync by convention — it's a one-liner).
const CHAT_COLUMN_CLASS = 'w-full max-w-4xl min-w-0 mx-auto'

interface FileChatPanelProps {
  item: ContextItem
  workspaceId?: string
}

/**
 * The right-hand chat pane for the Library file-detail view.
 *
 * Deliberately the *same surface* as the chat view's chat column —
 * not the older `ConversationPanel` (which keeps its tabbed,
 * bordered chrome for ArtifactDetail). It is a transparent area that
 * floats on the shell blob, with a centred `max-w-4xl` message
 * column, the chat's narrow `px-6` gutter, and the same full
 * composer. All surrounding chrome lives elsewhere for parity with
 * the chat view: breadcrumb + file controls in the global TopBar's
 * file region, the avatar stack as the global overlay centred over
 * this pane, and the collapse control as a TopBar affordance (owned
 * by ContextDetail).
 */
export function FileChatPanel({ item, workspaceId }: FileChatPanelProps) {
  const { developerMode } = usePrefs()
  const [isSending, setIsSending] = useState(false)

  const chat = useLibraryItemChat(workspaceId || undefined, item.id)
  const chatId = chat?.chatId ?? null
  const sendMessage = chat?.sendMessage
  const agentName = AGENT_NAME

  const handleSend = useCallback(async (msg: string) => {
    if (!msg.trim() || !sendMessage || isSending) return
    setIsSending(true)
    try {
      await sendMessage(msg)
    } catch {
      toast.error('Failed to send message')
    } finally {
      setIsSending(false)
    }
  }, [sendMessage, isSending])

  const draftKey = `library:${item.id}`
  const hideAttachmentPaths = [item.id]

  return (
    // No entrance animation here — the parent panel container slides
    // in as one piece (its width animates), so animating the contents
    // too would double up. Plain, transparent, full-height column.
    <div className="flex h-full w-full flex-col bg-transparent">
      <ChatThread
        chatId={chatId ?? ''}
        skipQuery={!chatId}
        agentName={agentName}
        developerMode={developerMode}
        isSending={isSending}
        innerClassName="px-6 pt-8 pb-16 space-y-3"
        messageClassName={() => CHAT_COLUMN_CLASS}
        statusClassName={CHAT_COLUMN_CLASS}
        agentHeaderClassName={CHAT_COLUMN_CLASS}
        emptySlot={null}
        hideAttachmentPaths={hideAttachmentPaths}
        footerSlot={
          <div className="shrink-0 min-w-0 max-w-full overflow-hidden">
            <div className="w-full min-w-0 px-6 pt-2 pb-6">
              <div className={CHAT_COLUMN_CLASS}>
                <ChatInput
                  onSend={(msg) => void handleSend(msg)}
                  placeholder="Ask a question or request changes to this file."
                  showGoalPicker={true}
                  draftKey={draftKey}
                />
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}
