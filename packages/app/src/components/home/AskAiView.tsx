import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput } from '@/components/compose/ChatInput'
import { EmptyChatGreeting } from '@/components/compose/EmptyChatGreeting'
import { SuggestionPills } from '@/components/compose/SuggestionPills'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import {
  useGetAskAiChatQuery,
  usePostChatMessageMutation,
} from '@/store/api'
import { usePrefs } from '@/hooks/use-prefs'
import type { SendOptions, UploadedFile } from '@/components/compose/ChatInput'
import type { AttachmentRef } from '@/store/types'
import type { GoalKey } from '@roomy-ai/shared'

const COLUMN = 'w-full max-w-4xl min-w-0 mx-auto'
// Messages get an extra `px-6` to match the ChatInput card's internal
// `pl-6`/`pr-6`, so the assistant text and the textarea/placeholder line
// up on the same left edge (and the user bubble's right edge lines up
// with the card content's right edge).
const MESSAGE_COLUMN = `${COLUMN} px-6`

/**
 * The Home "Ask AI" surface — a single, persistent thread backed by the
 * hub workspace's oldest chat. The hub itself is hidden from the public
 * workspaces API; the server exposes this one chat via /me/ask-ai-chat
 * and creates it on demand. Every message round-trips through the real
 * chat backend, so the agent reply is real (no mocks).
 */
export function AskAiView() {
  const { developerMode } = usePrefs()
  const { data: askAiChat, isLoading: isLoadingChat } = useGetAskAiChatQuery()
  const [postMessage] = usePostChatMessageMutation()
  const [isSending, setIsSending] = useState(false)

  // Suggestion-pill state: prefill text + Tools goal pushed into the
  // composer when the user clicks a pill.
  const [pillPrefill, setPillPrefill] = useState<string | undefined>(undefined)
  const [pillGoal, setPillGoal] = useState<GoalKey | null>(null)

  // Files dropped onto the view or picked via the composer's attach
  // button. Held in browser memory until the user sends — the file
  // rides on the next outgoing message as a multipart part (same
  // pattern as ChatView).
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; file: File }>>([])

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

  const handleSend = async (
    msg: string,
    uploads: UploadedFile[],
    options?: SendOptions,
  ) => {
    const text = msg.trim()
    if (!text && uploads.length === 0 && pendingFiles.length === 0) return
    if (isSending) return
    if (!askAiChat) {
      toast.error('Ask AI chat is not ready yet')
      return
    }
    // Library-mention uploads (path set) become AttachmentRefs; the
    // raw File bodies live in `pendingFiles` state and ride along as
    // multipart parts.
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
        chatId: askAiChat.id,
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        files: files.length > 0 ? files : undefined,
        ...options,
      }).unwrap()
    } catch {
      toast.error('Failed to send message')
    } finally {
      setIsSending(false)
    }
  }

  const isThreadEmpty = !askAiChat && !isLoadingChat

  return (
    <FileDropZone
      onFiles={handleUpload}
      overlayLabel="Drop to attach to Roomy AI"
      className="flex h-full min-h-0 w-full flex-col"
    >
      {({ openPicker }) => (
        <ChatThread
          chatId={askAiChat?.id ?? ''}
          skipQuery={!askAiChat}
          developerMode={developerMode}
          isSending={isSending}
          agentName="Roomy AI"
          innerClassName="px-6 pt-8 pb-4 space-y-4"
          messageClassName={() => MESSAGE_COLUMN}
          statusClassName={MESSAGE_COLUMN}
          agentHeaderClassName={MESSAGE_COLUMN}
          emptySlot={
            <div className={MESSAGE_COLUMN}>
              <EmptyChatGreeting />
            </div>
          }
          footerSlot={
            <div className="shrink-0 px-6 pb-6 pt-2">
              <div className={`${COLUMN} flex flex-col gap-3`}>
                {isThreadEmpty && (
                  <SuggestionPills
                    className="px-6"
                    onSelect={s => {
                      setPillPrefill(s.prompt)
                      if (s.goal !== undefined) setPillGoal(s.goal)
                    }}
                  />
                )}
                <ChatInput
                  autoFocus
                  onSend={(msg, uploads, options) => {
                    void handleSend(msg, uploads, options)
                    setPillPrefill(undefined)
                    setPillGoal(null)
                  }}
                  placeholder="Ask Roomy AI anything…"
                  showGoalPicker
                  goal={pillGoal}
                  prefillValue={pillPrefill}
                  hideAgentPicker
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
          }
        />
      )}
    </FileDropZone>
  )
}
