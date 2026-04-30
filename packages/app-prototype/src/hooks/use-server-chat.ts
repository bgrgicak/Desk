import { useState, useCallback } from 'react'
import {
  useGetWorkspaceAgentsQuery,
  useCreateChatMutation,
  usePostChatMessageMutation,
  useGetChatMessagesQuery,
  usePinChatLibraryRefMutation,
} from '@/store/api'
import type { ChatMessage } from '@/data/ui-types'
import type { AttachmentRef, ServerMessage } from '@/store/types'

export function serverMessageToChatMessage(m: ServerMessage): ChatMessage | null {
  if (m.role === 'system' || m.kind === 'ai_note') return null
  if (m.content.type === 'events') return null
  const text =
    m.content.type === 'text'
      ? m.content.text ?? ''
      : m.content.type === 'toolResult'
        ? '[tool result]'
        : ''
  return {
    id: m.id,
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: text,
    timestamp: new Date(m.createdAt),
  }
}

export interface UseServerChatReturn {
  chatId: string | null
  messages: ChatMessage[]
  isTyping: boolean
  agentModel: string
  sendMessage: (content: string) => Promise<void>
}

/**
 * Real server-backed chat. Creates a new chat on first message (lazy) and
 * persists the chat id in localStorage under `storageKey` so the conversation
 * survives page reloads. Optionally attaches `staticAttachments` to every
 * outgoing message (used by useLibraryItemChat to pin the open file).
 */
export function useServerChat(
  workspaceId: string | undefined,
  storageKey: string,
  title: string,
  staticAttachments?: AttachmentRef[],
): UseServerChatReturn {
  const [chatId, setChatIdState] = useState<string | null>(() =>
    workspaceId && storageKey ? localStorage.getItem(storageKey) : null,
  )

  const setChatId = useCallback(
    (id: string) => {
      setChatIdState(id)
      if (storageKey) localStorage.setItem(storageKey, id)
    },
    [storageKey],
  )

  const { data: workspaceAgents } = useGetWorkspaceAgentsQuery(workspaceId!, {
    skip: !workspaceId,
  })
  const [createChat] = useCreateChatMutation()
  const [postMessage] = usePostChatMessageMutation()
  const [pinChatLibraryRef] = usePinChatLibraryRefMutation()

  const { data: messagesData } = useGetChatMessagesQuery(
    { chatId: chatId! },
    { skip: !chatId },
  )

  const rawMessages = messagesData?.items ?? []
  const messages: ChatMessage[] = rawMessages
    .map(serverMessageToChatMessage)
    .filter((m): m is ChatMessage => m !== null)

  const lastAgentMsg = [...rawMessages].reverse().find(m => m.role === 'agent')
  const isTyping = lastAgentMsg?.state === 'running'

  const firstAgent = workspaceAgents?.[0]
  const agentModel = firstAgent?.name ?? 'Agent'

  const sendMessage = useCallback(
    async (content: string) => {
      if (!workspaceId) return

      let activeChatId = chatId

      if (!activeChatId) {
        const agentId = workspaceAgents?.[0]?.id
        if (!agentId) return
        const chat = await createChat({ workspaceId, agentId, title }).unwrap()
        activeChatId = chat.id
        setChatId(chat.id)
        // Pin static attachments (library files) so they appear in the Files sidebar.
        for (const attachment of staticAttachments ?? []) {
          pinChatLibraryRef({ chatId: activeChatId, path: attachment.path }).catch(() => {})
        }
      }

      await postMessage({
        chatId: activeChatId,
        content,
        ...(staticAttachments && staticAttachments.length > 0
          ? { attachments: staticAttachments }
          : {}),
      }).unwrap()
    },
    [workspaceId, chatId, workspaceAgents, title, staticAttachments, createChat, postMessage, setChatId, pinChatLibraryRef],
  )

  return { chatId, messages, isTyping, agentModel, sendMessage }
}
