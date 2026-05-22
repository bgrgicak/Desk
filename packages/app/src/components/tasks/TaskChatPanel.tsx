import { useState, useCallback } from 'react'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput, type UploadedFile, type SendOptions } from '@/components/compose/ChatInput'
import { ThreadParentChip } from '@/components/chats/ThreadParentChip'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { usePostChatMessageMutation } from '@/store/api'
import { usePrefs } from '@/hooks/use-prefs'
import type { Task } from '@/data/ui-types'
import type { AttachmentRef } from '@/store/types'
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
 *
 * File uploads ride the same plumbing the chat view uses: a
 * FileDropZone wraps the whole pane so the user can drop anywhere
 * (not just on the input strip), and the dropped File objects flow
 * out as multipart `files` on the next outgoing message — no
 * upload-then-attach two-step.
 */
export function TaskChatPanel({ task }: TaskChatPanelProps) {
  const { developerMode } = usePrefs()
  const [isSending, setIsSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; file: File }>>([])
  const [postMessage] = usePostChatMessageMutation()
  // Tasks created from inside a chat live as a thread of that chat: the
  // anchor (kind='task') stays in the source chat; task_runs and any
  // follow-up replies land in the dedicated thread chat. Open the thread
  // when present; fall back to the anchor's chat for standalone tasks
  // created from the TasksPage composer (no parent).
  const chatId = task.threadChatId ?? task.chatId ?? ''

  const handleUpload = useCallback((entries: UploadEntry[]) => {
    setPendingFiles(prev => [
      ...prev,
      ...entries.map(({ file }, i) => ({
        id: `pending-${Date.now()}-${i}-${file.name}`,
        file,
      })),
    ])
  }, [])

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(p => p.id !== id))
  }, [])

  const handleSend = useCallback(
    async (msg: string, uploads: UploadedFile[], _options?: SendOptions) => {
      if (!chatId || isSending) return
      const text = msg.trim()

      // Library mentions (path set) become AttachmentRefs; dropped /
      // picked files ride the same request as multipart `files`. The
      // de-dupe mirrors ChatView so a file mentioned via @ and also
      // staged in the tray doesn't appear twice on the wire.
      const seen = new Set<string>()
      const attachments: AttachmentRef[] = uploads
        .filter(u => typeof u.path === 'string')
        .filter(u => {
          if (seen.has(u.path!)) return false
          seen.add(u.path!)
          return true
        })
        .map(u => ({
          path: u.path!,
          name: u.name,
          kind: u.kind,
          mime: u.mime,
          size: u.size,
        }))
      const files = pendingFiles.map(p => p.file)

      setPendingFiles([])
      setIsSending(true)
      try {
        await postMessage({
          chatId,
          content: text,
          attachments: attachments.length > 0 ? attachments : undefined,
          files: files.length > 0 ? files : undefined,
        }).unwrap()
      } catch {
        toast.error('Failed to send message')
      } finally {
        setIsSending(false)
      }
    },
    [chatId, isSending, pendingFiles, postMessage],
  )

  return (
    <FileDropZone
      onFiles={handleUpload}
      overlayLabel="Drop to attach to chat"
      className="flex h-full w-full flex-col bg-transparent"
    >
      {({ openPicker }) => (
        <ChatThread
          chatId={chatId}
          skipQuery={!chatId}
          developerMode={developerMode}
          isSending={isSending}
          headerSlot={chatId ? <ThreadParentChip chatId={chatId} /> : null}
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
                    onSend={(msg, uploads, options) => void handleSend(msg, uploads, options)}
                    placeholder="Write a message or type @ to reference files and chats"
                    showGoalPicker
                    draftKey={`task:${task.id}`}
                    onOpenUploadPicker={openPicker}
                    extraUploads={pendingFiles.map(p => ({
                      id: p.id,
                      name: p.file.name,
                      mime: p.file.type,
                      size: p.file.size,
                    }))}
                    onRemoveExtraUpload={removePendingFile}
                  />
                </div>
              </div>
            </div>
          }
        />
      )}
    </FileDropZone>
  )
}
