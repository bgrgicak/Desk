import { useState, useCallback } from 'react'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput } from '@/components/compose/ChatInput'
import { usePostChatMessageMutation } from '@/store/api'
import { usePrefs } from '@/hooks/use-prefs'
import type { Task } from '@/data/ui-types'
import { toast } from 'sonner'

// Same centred column as the chat view so the task thread reads
// identically to a normal chat (mirrors FileChatPanel).
const CHAT_COLUMN_CLASS = 'w-full max-w-4xl min-w-0 mx-auto'

interface TaskChatPanelProps {
  task: Task
}

/**
 * The docked chat sidebar for a selected task — the *same surface* as
 * the chat view's column and the Library file detail's chat pane:
 * transparent (floats on the shell blob), centred `max-w-4xl`
 * messages, the chat's narrow `px-6` gutter, full composer. All
 * surrounding chrome lives elsewhere for parity with ContextDetail:
 * the breadcrumb stays in the global TopBar, the collapse X is a
 * TopBar affordance (owned by TasksPage), and the avatar stack is the
 * global overlay centred over this pane.
 */
export function TaskChatPanel({ task }: TaskChatPanelProps) {
  const { developerMode } = usePrefs()
  const [isSending, setIsSending] = useState(false)
  const [postMessage] = usePostChatMessageMutation()
  const chatId = task.chatId ?? ''

  const handleSend = useCallback(
    async (msg: string) => {
      const text = msg.trim()
      if (!text || !chatId || isSending) return
      setIsSending(true)
      try {
        await postMessage({ chatId, content: text }).unwrap()
      } catch {
        toast.error('Failed to send message')
      } finally {
        setIsSending(false)
      }
    },
    [chatId, isSending, postMessage],
  )

  return (
    <div className="flex h-full w-full flex-col bg-transparent">
      <ChatThread
        chatId={chatId}
        skipQuery={!chatId}
        developerMode={developerMode}
        isSending={isSending}
        innerClassName="px-6 pt-8 pb-16 space-y-3"
        messageClassName={() => CHAT_COLUMN_CLASS}
        statusClassName={CHAT_COLUMN_CLASS}
        agentHeaderClassName={CHAT_COLUMN_CLASS}
        emptySlot={null}
        footerSlot={
          <div className="shrink-0 min-w-0 max-w-full overflow-hidden">
            <div className="w-full min-w-0 px-6 pt-2 pb-6">
              <div className={CHAT_COLUMN_CLASS}>
                <ChatInput
                  onSend={(msg) => void handleSend(msg)}
                  placeholder="Write a message or type @ to reference files and chats"
                  showGoalPicker
                  draftKey={`task:${task.id}`}
                />
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}
